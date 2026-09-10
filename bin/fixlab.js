#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileRelativePath = join(
  ".github",
  "fixlab",
  "repository-profile.json"
);

function printUsage() {
  console.log(`FixLab CLI

Usage:
  fixlab init [repository]
  fixlab doctor [repository]
  fixlab run [repository] [--] [request...]
  fixlab validate [repository] --pr <number>
  fixlab --help

Commands:
  init      Add the FixLab repository profile template.
  doctor    Check required tools and repository configuration.
  run       Launch the FixLab Agency agent for a request.
  validate  Launch validation-only mode for a pull request.`);
}

function resolveRepository(value) {
  return resolve(value && !value.startsWith("-") ? value : process.cwd());
}

function findExecutable(command) {
  const result = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [command],
    { encoding: "utf8", shell: false }
  );
  return result.status === 0;
}

function loadProfile(repository) {
  const profilePath = join(repository, profileRelativePath);
  if (!existsSync(profilePath)) {
    return { profilePath, profile: null, error: "profile is missing" };
  }

  try {
    return {
      profilePath,
      profile: JSON.parse(readFileSync(profilePath, "utf8")),
      error: null
    };
  } catch (error) {
    return {
      profilePath,
      profile: null,
      error: `profile is invalid JSON: ${error.message}`
    };
  }
}

function checkPlaywright(repository, profile) {
  const configuration = profile?.browserAutomation ?? {};
  const workingDirectory = resolve(
    repository,
    configuration.workingDirectory ??
      profile?.applications?.frontend?.workingDirectory ??
      "."
  );
  const preferredPackage = configuration.package;
  const packages = [
    preferredPackage,
    "@playwright/test",
    "playwright"
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  const browserName = configuration.browser ?? "chromium";

  if (!existsSync(workingDirectory)) {
    const detail = `working directory is missing: ${workingDirectory}`;
    return {
      packageCheck: { name: "Playwright package", ok: false, detail },
      browserCheck: { name: "Playwright browser", ok: false, detail }
    };
  }

  const packageProbe = `
    const packages = ${JSON.stringify(packages)};
    for (const name of packages) {
      try {
        require.resolve(name);
        process.stdout.write(name);
        process.exit(0);
      } catch {}
    }
    process.stderr.write("install @playwright/test in the configured working directory");
    process.exit(1);
  `;
  const packageResult = spawnSync(process.execPath, ["-e", packageProbe], {
    cwd: workingDirectory,
    encoding: "utf8",
    timeout: 15000
  });
  const resolvedPackage = packageResult.stdout?.trim();
  const packageCheck = {
    name: "Playwright package",
    ok: packageResult.status === 0 && Boolean(resolvedPackage),
    detail:
      packageResult.error?.message ??
      resolvedPackage ??
      packageResult.stderr?.trim() ??
      "package resolution failed"
  };

  if (!packageCheck.ok) {
    return {
      packageCheck,
      browserCheck: {
        name: "Playwright browser",
        ok: false,
        detail: "not checked because the Playwright package is unavailable"
      }
    };
  }

  const browserProbe = `
    const playwright = require(${JSON.stringify(resolvedPackage)});
    const browserType = playwright[${JSON.stringify(browserName)}];
    if (!browserType || typeof browserType.launch !== "function") {
      throw new Error("configured browser is not exported by Playwright");
    }
    (async () => {
      const browser = await browserType.launch({ headless: true });
      await browser.close();
      process.stdout.write(${JSON.stringify(browserName)});
    })().catch((error) => {
      process.stderr.write(error.message);
      process.exit(1);
    });
  `;
  const browserResult = spawnSync(process.execPath, ["-e", browserProbe], {
    cwd: workingDirectory,
    encoding: "utf8",
    timeout: 45000
  });
  const launchedBrowser = browserResult.stdout?.trim();
  const browserCheck = {
    name: "Playwright browser",
    ok: browserResult.status === 0 && launchedBrowser === browserName,
    detail:
      browserResult.error?.message ??
      (launchedBrowser
        ? `${launchedBrowser} launched successfully`
        : browserResult.stderr?.trim() ??
          "browser launch failed; install the configured Playwright browser")
  };

  return { packageCheck, browserCheck };
}

function init(repository) {
  const destination = join(repository, profileRelativePath);
  if (existsSync(destination)) {
    console.error(`FixLab profile already exists: ${destination}`);
    return 1;
  }

  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(
    join(packageRoot, "templates", "repository-profile.json"),
    destination
  );
  console.log(`Created ${destination}`);
  console.log("Update its paths, commands, ports, and allowed environments.");
  return 0;
}

function doctor(repository) {
  const checks = [
    ["Git", "git"],
    ["Node.js", "node"],
    [".NET SDK", "dotnet"],
    ["PowerShell", "pwsh"],
    ["Agency", "agency"]
  ].map(([name, command]) => ({
    name,
    ok: findExecutable(command),
    detail: command
  }));

  const { profilePath, profile, error } = loadProfile(repository);
  checks.push({
    name: "Repository profile",
    ok: Boolean(profile),
    detail: error ?? profilePath
  });
  checks.push({
    name: "Git repository",
    ok: existsSync(join(repository, ".git")),
    detail: repository
  });
  const playwright = checkPlaywright(repository, profile);
  checks.push(playwright.packageCheck, playwright.browserCheck);

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name} (${check.detail})`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(`FixLab doctor found ${failed.length} blocking check(s).`);
    return 1;
  }

  console.log(`FixLab is ready for ${profile.name ?? repository}.`);
  return 0;
}

function launch(repository, request) {
  const { error } = loadProfile(repository);
  if (error) {
    console.error(
      `Cannot launch FixLab because ${error}. Run "fixlab init ${repository}" first.`
    );
    return 1;
  }

  if (!findExecutable("agency")) {
    console.error(
      "Cannot launch FixLab because Agency Copilot is unavailable. Install and authenticate Agency first."
    );
    return 1;
  }

  const args = [
    "copilot",
    "--plugin",
    `local:${packageRoot}`,
    "--agent",
    "fixlab:fixlab"
  ];
  if (request) {
    args.push("--interactive", request);
  }

  const result = spawnSync("agency", args, {
    cwd: repository,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  return result.status ?? 1;
}

function parseValidateArguments(args) {
  const prIndex = args.indexOf("--pr");
  if (prIndex < 0 || !args[prIndex + 1]) {
    return { error: "validate requires --pr <number>" };
  }

  const pullRequest = args[prIndex + 1];
  if (!/^\d+$/.test(pullRequest)) {
    return { error: "pull request number must contain only digits" };
  }

  const repository = resolveRepository(args[0]);
  return { repository, pullRequest };
}

function main(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }

  if (command === "init") {
    return init(resolveRepository(rest[0]));
  }

  if (command === "doctor") {
    return doctor(resolveRepository(rest[0]));
  }

  if (command === "run") {
    const repository = resolveRepository(rest[0]);
    const requestStart = rest[0] && !rest[0].startsWith("-") ? 1 : 0;
    const request = rest
      .slice(requestStart)
      .filter((value) => value !== "--")
      .join(" ")
      .trim();
    return launch(repository, request);
  }

  if (command === "validate") {
    const parsed = parseValidateArguments(rest);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    return launch(
      parsed.repository,
      `Validate pull request ${parsed.pullRequest} without modifying source code or the pull request.`
    );
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  return 1;
}

process.exitCode = main(process.argv.slice(2));
