#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgencyInvocation,
  buildCopilotInvocation,
  configuredValidationEnvironments,
  createDashboardServer,
  DEFAULT_DASHBOARD_PORT,
  FIXLAB_RUNTIMES,
  inspectRepository,
  validateTargetEnvironment,
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
const troubleshootingUrl =
  "https://github.com/MonaDevAI/FixLab/blob/main/docs/troubleshooting.md";

function printTroubleshooting() {
  console.error(`Troubleshooting: ${troubleshootingUrl}`);
}

function redactCommandForDisplay(command) {
  return String(command)
    .replace(
      /((?:password|passwd|secret|token|authorization|bearer|cookie|client[-_]?secret|api[-_]?key)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /(--(?:password|passwd|secret|token|authorization|bearer|cookie|client-secret|api-key)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/(https?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}

function printUsage() {
  console.log(`FixLab CLI

Usage:
  fixlab onboard [repository] [--yes] [--authenticate] [--start-dashboard] [--runtime <agency|copilot>]
  fixlab init [repository]
  fixlab prepare [repository] [--yes]
  fixlab doctor [repository] [--runtime <agency|copilot>]
  fixlab setup-playwright [repository] [--yes]
  fixlab authenticate [repository] [--yes]
  fixlab run [repository] [--runtime <agency|copilot>] [--environment <name>] [--] [request...]
  fixlab validate [repository] --pr <number> [--runtime <agency|copilot>]
  fixlab dashboard [repository] [--port <number>] [--no-open] [--stop] [--runtime <agency|copilot>]
  fixlab --help

Commands:
  onboard   Run the plan-first repository onboarding workflow.
  init      Add the FixLab repository profile template.
  prepare   Plan or run repository-owned frontend and backend restore commands.
  doctor    Check required tools and repository configuration.
  setup-playwright
            Plan or install the repository-local Playwright package and browser.
  authenticate
            Plan or run the repository-owned browser authentication command.
  run       Launch the FixLab agent for a request.
  validate  Launch validation-only mode for a pull request.
  dashboard Start or stop the local FixLab dashboard (127.0.0.1:${DEFAULT_DASHBOARD_PORT}).

Runtime:
  agency    Use Agency Copilot (default).
  copilot   Use GitHub Copilot CLI directly.

Set FIXLAB_RUNTIME or pass --runtime to select the runtime.
Run with --environment to select an allowed non-production environment from the repository profile.

Troubleshooting:
  ${troubleshootingUrl}`);
}

function resolveRepository(value) {
  if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
    throw new Error(
      'Repository argument must be a local directory, not a URL. Run FixLab from the local clone; to validate a pull request, use "fixlab validate --pr <number> --runtime agency".'
    );
  }
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

function checkPackageManager(command, workingDirectory) {
  const match = command?.match(
    /^\s*(npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?)\b/i
  );
  if (!match) {
    return null;
  }

  const manager = match[1];
  const result = spawnSync(`${manager} --version`, {
    cwd: workingDirectory,
    encoding: "utf8",
    shell: true,
    timeout: 15000,
    windowsHide: true
  });
  const version = result.stdout?.trim();
  let failure =
    result.error?.message ??
    result.stderr?.trim().split(/\r?\n/, 1)[0] ??
    `${manager} --version failed`;
  if (result.status === 0 && version) {
    if (/^npm(?:\.cmd)?$/i.test(manager)) {
      const integrityResult = spawnSync(
        `${manager} pack --dry-run --ignore-scripts --json`,
        {
          cwd: packageRoot,
          encoding: "utf8",
          shell: true,
          timeout: 15000,
          windowsHide: true
        }
      );
      const integrityOutput = [
        integrityResult.stdout,
        integrityResult.stderr
      ].filter(Boolean).join("\n");
      const internalFailure = integrityOutput.match(
        /(?:Class extends value undefined|(?:TypeError|ReferenceError|SyntaxError):)[^\r\n]*/i
      );
      if (!integrityResult.error && !internalFailure) {
        return {
          name: "Frontend package manager",
          ok: true,
          detail: `${manager} ${version}`
        };
      }
      failure =
        integrityResult.error?.message ??
        internalFailure?.[0]?.replace(/[",]+$/, "") ??
        "npm dependency graph probe failed internally";
    } else {
      return {
        name: "Frontend package manager",
        ok: true,
        detail: `${manager} ${version}`
      };
    }
  }

  return {
    name: "Frontend package manager",
    ok: false,
    detail: `${failure}. Run "${manager} --version" and "${manager} pack --dry-run --ignore-scripts --json" in this shell, then align the active Node.js and ${manager} installation before retrying`
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
    console.log(
      "Existing profiles are preserved and are not upgraded automatically. Run fixlab doctor and merge newly required fields from the current profile template."
    );
    try {
      const profile = JSON.parse(readFileSync(destination, "utf8"));
      if (profile?.browserAutomation?.testSynthesis === undefined) {
        console.log(
          "Profile upgrade required: add browserAutomation.testSynthesis with an approved data source, mutation mode, and scenario evidence requirement."
        );
      }
    } catch {
      console.log(
        "The existing profile could not be parsed; fix its JSON before running fixlab doctor."
      );
    }
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
  const frontendWorkingDirectory = resolve(
    repository,
    profile?.applications?.frontend?.workingDirectory ?? "."
  );
  const packageManager = checkPackageManager(
    profile?.validation?.commands?.frontendRestore,
    existsSync(frontendWorkingDirectory) ? frontendWorkingDirectory : repository
  );
  if (packageManager) {
    checks.push(packageManager);
  }
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
    if (
      !liveTestProfile.ok &&
      liveTestProfile.detail.includes("authentication is not ready") &&
      profile?.browserAutomation?.authentication?.command
    ) {
      const authenticationDirectory = resolve(
        repository,
        profile.browserAutomation.workingDirectory
      );
      const authenticationCommand = redactCommandForDisplay(
        profile.browserAutomation.authentication.command
      );
      console.error(
        `Next action: run "${authenticationCommand}" from "${authenticationDirectory}", complete interactive sign-in, then rerun Doctor.`
      );
      if (
        Object.keys(
          profile.browserAutomation.authentication.environment ?? {}
        ).length > 0
      ) {
        console.error(
          "Set the browserAutomation.authentication.environment values from the repository profile before running the authentication command."
        );
      }
    }
    printTroubleshooting();
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
    printTroubleshooting();
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
    printTroubleshooting();
    return 1;
  }

  for (const step of steps) {
    if (!existsSync(step.workingDirectory)) {
      console.error(
        `${step.application} restore directory is missing: ${step.workingDirectory}`
      );
      printTroubleshooting();
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

  const checkedPackageManagers = new Set();
  for (const step of steps) {
    const packageManager = checkPackageManager(
      step.command,
      step.workingDirectory
    );
    if (!packageManager || checkedPackageManagers.has(packageManager.detail)) {
      continue;
    }
    checkedPackageManagers.add(packageManager.detail);
    console.log(
      `${packageManager.ok ? "PASS" : "FAIL"}  ${packageManager.name} (${packageManager.detail})`
    );
    if (!packageManager.ok) {
      console.error(
        "Repository preparation stopped before dependency restore because the configured package manager is not runnable."
      );
      printTroubleshooting();
      return 1;
    }
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
      printTroubleshooting();
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

function authenticate(repository, approved) {
  const { profile, error } = loadProfile(repository);
  if (error) {
    console.error(
      `Cannot authenticate because ${error}. Run "fixlab init ${repository}" first.`
    );
    printTroubleshooting();
    return 1;
  }

  const browserAutomation = profile.browserAutomation ?? {};
  const authentication = browserAutomation.authentication ?? {};
  if (
    authentication.required !== true ||
    typeof authentication.command !== "string" ||
    !authentication.command.trim()
  ) {
    console.error(
      "Repository profile does not define a required browser authentication command."
    );
    printTroubleshooting();
    return 1;
  }

  const workingDirectory = resolve(
    repository,
    browserAutomation.workingDirectory ??
      profile.applications?.frontend?.workingDirectory ??
      "."
  );
  if (!existsSync(workingDirectory)) {
    console.error(
      `Browser authentication working directory is missing: ${workingDirectory}`
    );
    printTroubleshooting();
    return 1;
  }

  const command = authentication.command.trim();
  const authenticationEnvironment = authentication.environment ?? {};
  console.log("Browser authentication plan:");
  console.log(`  command: ${redactCommandForDisplay(command)}`);
  console.log(`  working directory: ${workingDirectory}`);
  const environmentNames = Object.keys(authenticationEnvironment);
  if (environmentNames.length > 0) {
    console.log(`  environment: ${environmentNames.join(", ")}`);
  }

  if (!approved) {
    console.log(
      "No command executed. Review the plan and rerun with --yes to start interactive authentication."
    );
    return 0;
  }

  const result = spawnSync(command, {
    cwd: workingDirectory,
    env: { ...process.env, ...authenticationEnvironment },
    stdio: "inherit",
    shell: true,
    windowsHide: true
  });
  if (result.status !== 0) {
    console.error(`Browser authentication failed with exit code ${result.status ?? 1}.`);
    printTroubleshooting();
    return result.status ?? 1;
  }

  const missingStatusPaths = (authentication.statusPaths ?? [])
    .map((statusPath) => resolve(workingDirectory, statusPath))
    .filter((statusPath) => !existsSync(statusPath));
  if (missingStatusPaths.length > 0) {
    console.error(
      `Browser authentication command completed, but required state is missing: ${missingStatusPaths.join(", ")}`
    );
    printTroubleshooting();
    return 1;
  }

  console.log("Browser authentication completed and required state is ready.");
  return 0;
}

function launch(repository, request, runtime, targetEnvironment = "") {
  const { profile, error } = loadProfile(repository);
  if (error) {
    console.error(
      `Cannot launch FixLab because ${error}. Run "fixlab init ${repository}" first.`
    );
    return 1;
  }

  let selectedEnvironment;
  try {
    selectedEnvironment = validateTargetEnvironment(
      targetEnvironment,
      configuredValidationEnvironments(profile)
    );
  } catch (validationError) {
    console.error(validationError.message);
    return 1;
  }

  if (!findExecutable(runtime)) {
    console.error(
      `Cannot launch FixLab because ${runtime} is unavailable. Install and authenticate the selected runtime first.`
    );
    return 1;
  }

  const guidance = [
    "Treat runtime-synthesized Playwright scenarios as transient validation artifacts by default. Remove their source files and validation-only configuration edits before review, commit, push, or pull-request creation. Do not add newly generated authenticated tests such as *.auth.spec.ts unless the user explicitly requests permanent browser-test coverage or repository instructions require that exact persisted test.",
    ...(selectedEnvironment
      ? [
        `Use ${selectedEnvironment} as the user-selected validation environment for profile-defined application startup and Playwright live testing. Do not silently fall back to another environment; block with the exact prerequisite if ${selectedEnvironment} is unavailable or unsafe.`,
        ...(profile.browserAutomation?.testSynthesis?.defaultDataSource ===
        "non-production-read-only"
          ? [
              `Use the selected ${selectedEnvironment} backend and API as the primary business-data source. Keep backend access read-only and intercept every mutating request.`,
              "Do not fulfill or intercept business-data reads while the selected backend is available and returns safe records that can prove the required assertions.",
              "Fall back to synthetic-intercepted data only when the selected backend is unreachable, access prevents the read, or it returns no safe records capable of exercising the required behavior. Preserve the exact backend limitation.",
              "Do not replace an expected empty-state assertion with synthetic data. A synthetic pass proves the UI behavior only and must not be reported as validation of the selected backend or its data.",
              "When fallback occurs, emit FIXLAB_ACTIVITY with the reason and FIXLAB_TEST with source synthetic-intercepted and mutation mode intercepted."
            ]
          : [])
      ]
      : [])
  ].join(" ");
  const prompt =
    request || selectedEnvironment
      ? `${guidance}${request ? ` Request: ${request}` : ""}`
      : "";
  const invocation = request
    ? runtime === "copilot"
      ? buildCopilotInvocation({
          packageRoot,
          prompt,
          sessionId: randomUUID()
        })
      : buildAgencyInvocation({
          packageRoot,
          prompt,
          sessionId: randomUUID()
        })
    : {
        args: [
          ...(runtime === "agency" ? ["copilot"] : []),
          "--plugin-dir",
          packageRoot,
          "--agent",
          "fixlab:fixlab",
          ...(prompt ? ["--interactive", prompt] : [])
        ]
      };
  const forwardsPrompt =
    typeof invocation.input === "string" && invocation.input.length > 0;
  const result = spawnSync(runtime, invocation.args, {
    cwd: repository,
    stdio: forwardsPrompt ? ["pipe", "inherit", "inherit"] : "inherit",
    input: forwardsPrompt ? invocation.input : undefined,
    shell: process.platform === "win32"
  });
  return result.status ?? 1;
}

function parseRunArguments(args) {
  let repositoryArgument;
  let targetEnvironment = "";
  const request = [];
  let afterSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && argument === "--environment") {
      if (!args[index + 1]) {
        return { error: "run requires a value after --environment" };
      }
      targetEnvironment = args[index + 1];
      index += 1;
      continue;
    }
    if (!afterSeparator && argument.startsWith("--environment=")) {
      targetEnvironment = argument.slice("--environment=".length);
      if (!targetEnvironment) {
        return { error: "run requires a value after --environment" };
      }
      continue;
    }
    if (!afterSeparator && !repositoryArgument && !argument.startsWith("-")) {
      repositoryArgument = argument;
      continue;
    }
    request.push(argument);
  }
  return {
    repository: resolveRepository(repositoryArgument),
    request: request.join(" ").trim(),
    targetEnvironment
  };
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
  let stop = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--stop") {
      stop = true;
      continue;
    }
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
    open,
    stop
  };
}

function dashboardControlPath(repository) {
  const identity = createHash("sha256")
    .update(resolve(repository))
    .digest("hex")
    .slice(0, 20);
  return join(
    tmpdir(),
    "fixlab-dashboard-control",
    identity,
    "dashboard.json"
  );
}

function writeDashboardControl(repository, port, token) {
  const controlPath = dashboardControlPath(repository);
  mkdirSync(dirname(controlPath), { recursive: true });
  writeFileSync(
    controlPath,
    JSON.stringify({
      version: 1,
      repository: resolve(repository),
      host: "127.0.0.1",
      port,
      pid: process.pid,
      token
    }),
    { mode: 0o600 }
  );
  return controlPath;
}

function removeDashboardControl(controlPath, token) {
  try {
    const record = JSON.parse(readFileSync(controlPath, "utf8"));
    if (record.token === token) {
      rmSync(controlPath, { force: true });
    }
  } catch {
    // A missing or replaced record does not belong to this dashboard instance.
  }
}

async function stopDashboard(repository) {
  const controlPath = dashboardControlPath(repository);
  if (!existsSync(controlPath)) {
    console.log(`No running FixLab dashboard is registered for ${repository}.`);
    return 0;
  }

  let record;
  try {
    record = JSON.parse(readFileSync(controlPath, "utf8"));
  } catch {
    console.error(`FixLab dashboard control record is invalid: ${controlPath}`);
    return 1;
  }
  if (
    record.version !== 1 ||
    record.repository !== resolve(repository) ||
    record.host !== "127.0.0.1" ||
    !Number.isSafeInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535 ||
    typeof record.token !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(record.token)
  ) {
    console.error(`FixLab dashboard control record is invalid: ${controlPath}`);
    return 1;
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:${record.port}/api/control/stop`,
      {
        method: "POST",
        headers: { "X-FixLab-Shutdown-Token": record.token },
        signal: AbortSignal.timeout(5000)
      }
    );
    if (response.status !== 202) {
      console.error(
        `FixLab dashboard refused the stop request (HTTP ${response.status}).`
      );
      return 1;
    }
  } catch {
    rmSync(controlPath, { force: true });
    console.log(
      `No running FixLab dashboard was found; removed stale control record for ${repository}.`
    );
    return 0;
  }

  console.log(`Stopping FixLab dashboard for ${repository}.`);
  return 0;
}

function parseOnboardArguments(args) {
  const runtimeArguments = parseRuntimeArguments(args);
  if (runtimeArguments.error) {
    return runtimeArguments;
  }

  let repositoryArgument;
  let approved = false;
  let authenticateBrowser = false;
  let startDashboard = false;
  for (const argument of runtimeArguments.args) {
    if (argument === "--yes") {
      approved = true;
      continue;
    }
    if (argument === "--authenticate") {
      authenticateBrowser = true;
      continue;
    }
    if (argument === "--start-dashboard") {
      startDashboard = true;
      continue;
    }
    if (argument.startsWith("-")) {
      return { error: `unknown onboard option: ${argument}` };
    }
    if (repositoryArgument) {
      return { error: "onboard accepts at most one repository path" };
    }
    repositoryArgument = argument;
  }

  return {
    repository: resolveRepository(repositoryArgument),
    runtime: runtimeArguments.runtime,
    approved,
    authenticateBrowser,
    startDashboard
  };
}

async function onboard({
  repository,
  runtime,
  approved,
  authenticateBrowser,
  startDashboard
}) {
  const profilePath = join(repository, profileRelativePath);
  const profileExisted = existsSync(profilePath);

  console.log("FixLab onboarding");
  console.log(`  repository: ${repository}`);
  console.log(`  runtime: ${runtime}`);

  const initResult = init(repository);
  if (initResult !== 0) {
    return initResult;
  }

  console.log("");
  console.log("Review this repository-owned profile before approving setup:");
  console.log(`  ${profilePath}`);
  console.log("");

  if (!profileExisted) {
    console.log("FixLab created a new example profile.");
    console.log(
      "Update its frontend/backend paths, commands, ports, environments, and authentication settings."
    );
    console.log("Then rerun fixlab onboard for this repository.");
    return 0;
  }

  const preparationPlan = prepare(repository, false);
  if (preparationPlan !== 0) {
    return preparationPlan;
  }
  const playwrightPlan = setupPlaywright(repository, false);
  if (playwrightPlan !== 0) {
    return playwrightPlan;
  }

  if (!approved) {
    console.log("");
    console.log("No restore or Playwright installation commands were executed.");
    console.log("After reviewing the profile and plans, rerun with --yes.");
    console.log(
      "Add --authenticate to perform repository-owned browser sign-in."
    );
    console.log(
      "Add --start-dashboard to start the dashboard after Doctor passes."
    );
    return 0;
  }

  const preparationResult = prepare(repository, true);
  if (preparationResult !== 0) {
    return preparationResult;
  }
  const playwrightResult = setupPlaywright(repository, true);
  if (playwrightResult !== 0) {
    return playwrightResult;
  }
  if (authenticateBrowser) {
    const authenticationResult = authenticate(repository, true);
    if (authenticationResult !== 0) {
      return authenticationResult;
    }
  }

  const doctorResult = doctor(repository, runtime);
  if (doctorResult !== 0) {
    return doctorResult;
  }
  if (startDashboard) {
    return dashboard(repository, DEFAULT_DASHBOARD_PORT, true, runtime);
  }

  console.log("");
  console.log("FixLab onboarding is ready.");
  console.log("Start the dashboard with:");
  console.log(`  fixlab dashboard "${repository}" --runtime ${runtime}`);
  return 0;
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
  const shutdownToken = randomUUID();
  let close;
  const dashboardServer = createDashboardServer({
    repository,
    packageRoot,
    runtime,
    shutdownToken,
    onShutdown: () => close?.()
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
  console.log(
    'Press Ctrl+C or run "fixlab dashboard --stop" from the repository directory to stop the local dashboard.'
  );
  let controlPath;
  try {
    controlPath = writeDashboardControl(repository, address.port, shutdownToken);
  } catch (error) {
    await dashboardServer.close();
    console.error(
      `Cannot register FixLab dashboard stop control: ${error.message}`
    );
    return 1;
  }
  if (shouldOpen) {
    openBrowser(address.url);
  }

  let closing = false;
  close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      await dashboardServer.close();
    } finally {
      removeDashboardControl(controlPath, shutdownToken);
    }
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  return 0;
}

async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }

  if (command === "onboard") {
    const parsed = parseOnboardArguments(rest);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    return onboard(parsed);
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

  if (command === "authenticate") {
    const repositoryArgument = rest.find((value) => !value.startsWith("-"));
    return authenticate(
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
    const runArguments = parseRunArguments(parsed.args);
    if (runArguments.error) {
      console.error(runArguments.error);
      return 1;
    }
    return launch(
      runArguments.repository,
      runArguments.request,
      parsed.runtime,
      runArguments.targetEnvironment
    );
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
    if (parsed.stop) {
      return stopDashboard(parsed.repository);
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

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
