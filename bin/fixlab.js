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
const promptNames = [
  "fixlab.intake.prompt.md",
  "fixlab.diagnose.prompt.md",
  "fixlab.reproduce.prompt.md",
  "fixlab.fix.prompt.md",
  "fixlab.validate.prompt.md",
  "fixlab.live-test.prompt.md",
  "fixlab.pr.prompt.md"
];

function printUsage() {
  console.log(`FixLab CLI

Usage:
  fixlab init [repository]
  fixlab doctor [repository]
  fixlab setup-playwright [repository] [--yes]
  fixlab run [repository] [--] [request...]
  fixlab validate [repository] --pr <number>
  fixlab --help

Commands:
  init      Add the FixLab repository profile template.
  doctor    Check required tools and repository configuration.
  setup-playwright
            Plan or install the repository-local Playwright package and browser.
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

  console.log(
    created > 0
      ? `Created ${created} FixLab repository file(s).`
      : "FixLab repository setup is already present."
  );
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

  if (command === "setup-playwright") {
    const repositoryArgument = rest.find((value) => !value.startsWith("-"));
    return setupPlaywright(
      resolveRepository(repositoryArgument),
      rest.includes("--yes")
    );
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
