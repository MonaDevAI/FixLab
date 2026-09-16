#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCopilotInvocation,
  createDashboardServer,
  DEFAULT_DASHBOARD_PORT,
  FIXLAB_RUNTIMES,
  inspectRepository,
  validateLiveTestProfile,
  validatePort
} from "../dashboard/server.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileRelativePath = join(
  ".github",
  "fixlab",
  "repository-profile.json"
);
const promptNames = [
  "fixlab.bugfix.prompt.md",
  "fixlab.intake.prompt.md",
  "fixlab.diagnose.prompt.md",
  "fixlab.reproduce.prompt.md",
  "fixlab.fix.prompt.md",
  "fixlab.validate.prompt.md",
  "fixlab.live-test.prompt.md",
  "fixlab.pr.prompt.md"
];
const vscodeAgentName = "fixlab-autofix.agent.md";

function printUsage() {
  console.log(`FixLab CLI

Usage:
  fixlab init [repository]
  fixlab prepare [repository] [--yes]
  fixlab doctor [repository] [--runtime <agency|copilot>]
  fixlab setup-playwright [repository] [--yes]
  fixlab run [repository] [--runtime <agency|copilot>] [--] [request...]
  fixlab validate [repository] --pr <number> [--runtime <agency|copilot>]
  fixlab dashboard [repository] [--port <number>] [--no-open] [--runtime <agency|copilot>]
  fixlab --help

Commands:
  init      Add the FixLab repository profile template.
  prepare   Plan or run repository-owned frontend and backend restore commands.
  doctor    Check required tools and repository configuration.
  setup-playwright
            Plan or install the repository-local Playwright package and browser.
  run       Launch the FixLab agent for a request.
  validate  Launch validation-only mode for a pull request.
  dashboard Start the local FixLab dashboard (127.0.0.1:${DEFAULT_DASHBOARD_PORT}).

Runtime:
  agency    Use Agency Copilot (default).
  copilot   Use GitHub Copilot CLI directly.

Set FIXLAB_RUNTIME or pass --runtime to select the runtime.`);
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

function checkDotnetSdk(repository) {
  if (!findExecutable("dotnet")) {
    return {
      name: ".NET SDK",
      ok: false,
      detail: "dotnet"
    };
  }

  const result = spawnSync("dotnet", ["--version"], {
    cwd: repository,
    encoding: "utf8",
    shell: false
  });
  const version = result.stdout?.trim();
  if (result.status === 0 && version) {
    return {
      name: ".NET SDK",
      ok: true,
      detail: version
    };
  }

  const globalJsonPath = join(repository, "global.json");
  if (existsSync(globalJsonPath)) {
    try {
      const requiredVersion = JSON.parse(
        readFileSync(globalJsonPath, "utf8")
      )?.sdk?.version;
      if (typeof requiredVersion === "string" && requiredVersion.trim()) {
        return {
          name: ".NET SDK",
          ok: false,
          detail: `requires ${requiredVersion.trim()} from ${globalJsonPath}`
        };
      }
    } catch (error) {
      return {
        name: ".NET SDK",
        ok: false,
        detail: `global.json is invalid JSON: ${error.message}`
      };
    }
  }

  return {
    name: ".NET SDK",
    ok: false,
    detail:
      result.error?.message ??
      result.stderr?.trim().split(/\r?\n/, 1)[0] ??
      "dotnet --version failed"
  };
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
  const browserChannel = configuration.channel;

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
      const browser = await browserType.launch({
        headless: true,
        ...(${JSON.stringify(browserChannel)} ? { channel: ${JSON.stringify(browserChannel)} } : {})
      });
      await browser.close();
      process.stdout.write(${JSON.stringify(
        browserChannel ? `${browserName}:${browserChannel}` : browserName
      )});
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
  const expectedBrowser = browserChannel
    ? `${browserName}:${browserChannel}`
    : browserName;
  const browserCheck = {
    name: "Playwright browser",
    ok: browserResult.status === 0 && launchedBrowser === expectedBrowser,
    detail:
      browserResult.error?.message ??
      (launchedBrowser
        ? `${launchedBrowser.replace(":", " channel ")} launched successfully`
        : browserResult.stderr?.trim() ??
          "browser launch failed; install the configured Playwright browser")
  };

  return { packageCheck, browserCheck };
}

function init(repository) {
  const destination = join(repository, profileRelativePath);
  let created = 0;
  if (existsSync(destination)) {
    console.log(`Kept existing FixLab profile: ${destination}`);
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(
      join(packageRoot, "templates", "repository-profile.json"),
      destination
    );
    console.log(`Created ${destination}`);
    created += 1;
  }

  const promptDirectory = join(repository, ".github", "prompts");
  mkdirSync(promptDirectory, { recursive: true });
  for (const promptName of promptNames) {
    const promptDestination = join(promptDirectory, promptName);
    if (existsSync(promptDestination)) {
      console.log(`Kept existing FixLab prompt: ${promptDestination}`);
      continue;
    }
    copyFileSync(join(packageRoot, "prompts", promptName), promptDestination);
    console.log(`Created ${promptDestination}`);
    created += 1;
  }

  const agentDirectory = join(repository, ".github", "agents");
  const agentDestination = join(agentDirectory, vscodeAgentName);
  if (existsSync(agentDestination)) {
    console.log(`Kept existing FixLab agent: ${agentDestination}`);
  } else {
    mkdirSync(agentDirectory, { recursive: true });
    copyFileSync(
      join(packageRoot, "templates", "fixlab-autofix.agent.md"),
      agentDestination
    );
    console.log(`Created ${agentDestination}`);
    created += 1;
  }

  console.log(
    created > 0
      ? `Created ${created} FixLab repository file(s).`
      : "FixLab repository setup is already present."
  );
  console.log("Update its paths, commands, ports, and allowed environments.");
  return 0;
}

function validateRuntime(value) {
  const runtime = String(value ?? "").trim().toLowerCase();
  if (!FIXLAB_RUNTIMES.includes(runtime)) {
    throw new Error(
      `runtime must be one of: ${FIXLAB_RUNTIMES.join(", ")}`
    );
  }
  return runtime;
}

function parseRuntimeArguments(args) {
  let runtime;
  try {
    runtime = validateRuntime(process.env.FIXLAB_RUNTIME ?? "agency");
  } catch (error) {
    return { error: `FIXLAB_RUNTIME ${error.message}` };
  }
  const remaining = [];
  let afterSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      afterSeparator = true;
      remaining.push(argument);
      continue;
    }
    if (!afterSeparator && argument === "--runtime") {
      if (!args[index + 1]) {
        return { error: "--runtime requires agency or copilot" };
      }
      try {
        runtime = validateRuntime(args[index + 1]);
      } catch (error) {
        return { error: error.message };
      }
      index += 1;
      continue;
    }
    if (!afterSeparator && argument.startsWith("--runtime=")) {
      try {
        runtime = validateRuntime(argument.slice("--runtime=".length));
      } catch (error) {
        return { error: error.message };
      }
      continue;
    }
    remaining.push(argument);
  }
  return { runtime, args: remaining };
}

function doctor(repository, runtime) {
  const checks = [
    ["Git", "git"],
    ["Node.js", "node"],
    ["PowerShell", "pwsh"],
    [runtime === "copilot" ? "GitHub Copilot CLI" : "Agency", runtime]
  ].map(([name, command]) => ({
    name,
    ok: findExecutable(command),
    detail: command
  }));
  checks.splice(2, 0, checkDotnetSdk(repository));

  const { profilePath, profile, error } = loadProfile(repository);
  checks.push({
    name: "Repository profile",
    ok: Boolean(profile),
    detail: error ?? profilePath
  });
  const liveTestProfile = profile
    ? validateLiveTestProfile(profile, repository)
    : { ok: false, detail: "not checked because the repository profile is unavailable" };
  checks.push({
    name: "Live-test profile",
    ok: liveTestProfile.ok,
    detail: liveTestProfile.detail
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

function prepare(repository, approved) {
  const { profile, error } = loadProfile(repository);
  if (error) {
    console.error(
      `Cannot prepare repository because ${error}. Run "fixlab init ${repository}" first.`
    );
    return 1;
  }

  const commands = profile.validation?.commands ?? {};
  const steps = [
    ["frontend", commands.frontendRestore],
    ["backend", commands.backendRestore]
  ]
    .filter(([, command]) => typeof command === "string" && command.trim())
    .map(([application, command]) => ({
      application,
      command: command.trim(),
      workingDirectory: resolve(
        repository,
        profile.applications?.[application]?.workingDirectory ?? "."
      )
    }));

  if (steps.length === 0) {
    console.error(
      "Repository profile has no frontendRestore or backendRestore command."
    );
    return 1;
  }

  for (const step of steps) {
    if (!existsSync(step.workingDirectory)) {
      console.error(
        `${step.application} restore directory is missing: ${step.workingDirectory}`
      );
      return 1;
    }
  }

  console.log("Repository preparation plan:");
  for (const step of steps) {
    console.log(
      `  ${step.application}: ${step.command} (${step.workingDirectory})`
    );
  }

  if (!approved) {
    console.log(
      "No commands executed. Review the plan and rerun with --yes to prepare the repository."
    );
    return 0;
  }

  for (const step of steps) {
    const result = spawnSync(step.command, {
      cwd: step.workingDirectory,
      stdio: "inherit",
      shell: true,
      windowsHide: true
    });
    if (result.status !== 0) {
      console.error(
        `${step.application} restore failed: ${step.command}`
      );
      return result.status ?? 1;
    }
    console.log(`PASS  ${step.application} restore (${step.command})`);
  }

  console.log("Repository preparation completed.");
  return 0;
}

function detectPackageManager(workingDirectory) {
  if (existsSync(join(workingDirectory, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(workingDirectory, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

function playwrightSetupCommands(packageManager, packageName, browserTarget) {
  if (packageManager === "pnpm") {
    return [
      ["pnpm", ["add", "--save-dev", packageName]],
      ["pnpm", ["exec", "playwright", "install", browserTarget]]
    ];
  }
  if (packageManager === "yarn") {
    return [
      ["yarn", ["add", "--dev", packageName]],
      ["yarn", ["playwright", "install", browserTarget]]
    ];
  }
  return [
    ["npm", ["install", "--save-dev", packageName]],
    ["npx", ["playwright", "install", browserTarget]]
  ];
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function setupPlaywright(repository, approved) {
  const { profile, error } = loadProfile(repository);
  if (error) {
    console.error(
      `Cannot set up Playwright because ${error}. Run "fixlab init ${repository}" first.`
    );
    return 1;
  }

  const configuration = profile.browserAutomation ?? {};
  const workingDirectory = resolve(
    repository,
    configuration.workingDirectory ??
      profile.applications?.frontend?.workingDirectory ??
      "."
  );
  if (!existsSync(workingDirectory)) {
    console.error(`Playwright working directory is missing: ${workingDirectory}`);
    return 1;
  }

  const packageName = configuration.package ?? "@playwright/test";
  const browserTarget = configuration.channel ?? configuration.browser ?? "chromium";
  const current = checkPlaywright(repository, profile);
  if (current.packageCheck.ok && current.browserCheck.ok) {
    console.log(`Playwright is already ready in ${workingDirectory}.`);
    console.log(`PASS  ${current.packageCheck.name} (${current.packageCheck.detail})`);
    console.log(`PASS  ${current.browserCheck.name} (${current.browserCheck.detail})`);
    return 0;
  }

  const packageManager = detectPackageManager(workingDirectory);
  if (!findExecutable(packageManager)) {
    console.error(`Required package manager is unavailable: ${packageManager}`);
    return 1;
  }

  const commands = playwrightSetupCommands(
    packageManager,
    packageName,
    browserTarget
  ).filter((_, index) => index > 0 || !current.packageCheck.ok);

  console.log(`Playwright setup directory: ${workingDirectory}`);
  console.log(`Detected package manager: ${packageManager}`);
  console.log("Planned commands:");
  for (const [command, args] of commands) {
    console.log(`  ${formatCommand(command, args)}`);
  }

  if (!approved) {
    console.log("No changes made. Review the commands and rerun with --yes to execute them.");
    return 0;
  }

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      cwd: workingDirectory,
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    if (result.status !== 0) {
      console.error(`Playwright setup failed: ${formatCommand(command, args)}`);
      return result.status ?? 1;
    }
  }

  const verified = checkPlaywright(repository, profile);
  for (const check of [verified.packageCheck, verified.browserCheck]) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name} (${check.detail})`);
  }
  if (!verified.packageCheck.ok || !verified.browserCheck.ok) {
    console.error("Playwright installation completed but verification failed.");
    return 1;
  }

  console.log("Playwright setup and browser launch verification completed.");
  return 0;
}

function launch(repository, request, runtime) {
  const { error } = loadProfile(repository);
  if (error) {
    console.error(
      `Cannot launch FixLab because ${error}. Run "fixlab init ${repository}" first.`
    );
    return 1;
  }

  if (!findExecutable(runtime)) {
    console.error(
      `Cannot launch FixLab because ${runtime} is unavailable. Install and authenticate the selected runtime first.`
    );
    return 1;
  }

  const invocation =
    runtime === "copilot"
      ? buildCopilotInvocation({
          packageRoot,
          prompt: request,
          sessionId: randomUUID()
        })
      : {
          args: [
            "copilot",
            "--plugin-dir",
            packageRoot,
            "--agent",
            "fixlab:fixlab",
            ...(request ? ["--interactive", request] : [])
          ]
        };
  const result = spawnSync(runtime, invocation.args, {
    cwd: repository,
    stdio: request && runtime === "copilot" ? ["pipe", "inherit", "inherit"] : "inherit",
    input: runtime === "copilot" ? invocation.input : undefined,
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

function parseDashboardArguments(args) {
  let repositoryArgument;
  let port = DEFAULT_DASHBOARD_PORT;
  let open = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") {
      open = false;
      continue;
    }
    if (argument === "--port") {
      if (!args[index + 1]) {
        return { error: "dashboard requires a value after --port" };
      }
      try {
        port = validatePort(args[index + 1]);
      } catch (error) {
        return { error: error.message };
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      return { error: `unknown dashboard option: ${argument}` };
    }
    if (repositoryArgument) {
      return { error: "dashboard accepts at most one repository path" };
    }
    repositoryArgument = argument;
  }
  return {
    repository: resolveRepository(repositoryArgument),
    port,
    open
  };
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = process.env.ComSpec ?? "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    shell: false
  });
  child.on("error", (error) => {
    console.error(`Could not open the system browser: ${error.message}`);
  });
  child.unref();
}

async function dashboard(repository, port, shouldOpen, runtime) {
  const readiness = inspectRepository(repository);
  if (!readiness.repositoryReady) {
    console.error(`Cannot start FixLab dashboard: ${readiness.error}`);
    return 1;
  }
  const dashboardServer = createDashboardServer({
    repository,
    packageRoot,
    runtime
  });
  let address;
  try {
    address = await dashboardServer.listen({ port });
  } catch (error) {
    console.error(`Cannot start FixLab dashboard: ${error.message}`);
    return 1;
  }

  console.log(`FixLab dashboard: ${address.url}`);
  console.log(`Repository: ${repository}`);
  console.log(`Runtime: ${runtime}`);
  console.log("Press Ctrl+C to stop the local dashboard.");
  if (shouldOpen) {
    openBrowser(address.url);
  }

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await dashboardServer.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return 0;
}

async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }

  if (command === "init") {
    return init(resolveRepository(rest[0]));
  }

  if (command === "doctor") {
    const parsed = parseRuntimeArguments(rest);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    return doctor(resolveRepository(parsed.args[0]), parsed.runtime);
  }

  if (command === "prepare") {
    const repositoryArgument = rest.find((value) => !value.startsWith("-"));
    return prepare(
      resolveRepository(repositoryArgument),
      rest.includes("--yes")
    );
  }

  if (command === "setup-playwright") {
    const repositoryArgument = rest.find((value) => !value.startsWith("-"));
    return setupPlaywright(
      resolveRepository(repositoryArgument),
      rest.includes("--yes")
    );
  }

  if (command === "run") {
    const parsed = parseRuntimeArguments(rest);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    const repository = resolveRepository(parsed.args[0]);
    const requestStart =
      parsed.args[0] && !parsed.args[0].startsWith("-") ? 1 : 0;
    const request = parsed.args
      .slice(requestStart)
      .filter((value) => value !== "--")
      .join(" ")
      .trim();
    return launch(repository, request, parsed.runtime);
  }

  if (command === "validate") {
    const runtimeArguments = parseRuntimeArguments(rest);
    if (runtimeArguments.error) {
      console.error(runtimeArguments.error);
      return 1;
    }
    const parsed = parseValidateArguments(runtimeArguments.args);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    return launch(
      parsed.repository,
      `Validate pull request ${parsed.pullRequest} without modifying source code or the pull request.`,
      runtimeArguments.runtime
    );
  }

  if (command === "dashboard") {
    const runtimeArguments = parseRuntimeArguments(rest);
    if (runtimeArguments.error) {
      console.error(runtimeArguments.error);
      return 1;
    }
    const parsed = parseDashboardArguments(runtimeArguments.args);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    return dashboard(
      parsed.repository,
      parsed.port,
      parsed.open,
      runtimeArguments.runtime
    );
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
