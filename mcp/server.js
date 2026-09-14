#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  statSync
} from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";

const protocolVersion = "2024-11-05";
const tools = [
  {
    name: "fixlab_inspect_repository",
    description:
      "Inspect whether a repository has a parseable FixLab profile and summarize its configured validation surfaces.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description: "Absolute or current-directory-relative repository path."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "fixlab_validation_commands",
    description:
      "Read the repository-owned package scripts that participate in FixLab validation without executing them.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description: "Absolute or current-directory-relative repository path."
        }
      },
      additionalProperties: false
    }
  }
];

function textResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ],
    isError
  };
}

function resolveRepository(value) {
  const repository = resolve(
    typeof value === "string" && value.trim() ? value : process.cwd()
  );
  if (!existsSync(repository) || !statSync(repository).isDirectory()) {
    throw new Error("repository does not exist or is not a directory");
  }
  return repository;
}

function inspectRepository(repositoryValue) {
  const repository = resolveRepository(repositoryValue);
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  if (!existsSync(profilePath)) {
    return {
      repository,
      profileReady: false,
      profilePath,
      error: "repository profile is missing; run fixlab init"
    };
  }

  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  return {
    repository,
    profileReady: true,
    profilePath,
    name: profile.name ?? null,
    applicationNames: Object.keys(profile.applications ?? {}),
    environmentNames: Object.keys(profile.environments ?? {}),
    browserAutomationConfigured: Boolean(profile.browserAutomation),
    pullRequestPolicyConfigured: Boolean(profile.pullRequest)
  };
}

function validationCommands(repositoryValue) {
  const repository = resolveRepository(repositoryValue);
  const packagePath = join(repository, "package.json");
  if (!existsSync(packagePath)) {
    return {
      repository,
      packagePath,
      commands: {},
      error: "package.json is missing"
    };
  }
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const scripts = packageJson.scripts ?? {};
  const names = [
    "lint",
    "format:check",
    "docs:check",
    "test",
    "test:ci",
    "pack:check",
    "validate"
  ];
  return {
    repository,
    packagePath,
    commands: Object.fromEntries(
      names.filter((name) => scripts[name]).map((name) => [name, scripts[name]])
    )
  };
}

function toolCall(params = {}) {
  const repository = params.arguments?.repository;
  if (params.name === "fixlab_inspect_repository") {
    return textResult(inspectRepository(repository));
  }
  if (params.name === "fixlab_validation_commands") {
    return textResult(validationCommands(repository));
  }
  throw new Error(`unknown tool: ${params.name ?? ""}`);
}

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function errorResponse(id, error) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error)
      }
    })}\n`
  );
}

async function handleMessage(message) {
  if (message.method === "initialize") {
    response(message.id, {
      protocolVersion,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "fixlab",
        version: "0.5.1"
      }
    });
    return;
  }
  if (message.method === "ping") {
    response(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    response(message.id, { tools });
    return;
  }
  if (message.method === "tools/call") {
    response(message.id, toolCall(message.params));
    return;
  }
  if (message.id !== undefined) {
    throw new Error(`unsupported method: ${message.method ?? ""}`);
  }
}

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

input.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
    await handleMessage(message);
  } catch (error) {
    errorResponse(message?.id ?? null, error);
  }
});
