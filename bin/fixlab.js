#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { createServer as createNetServer } from "node:net";
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
import { runChat } from "../dashboard/chat.js";
import {
  parseKeepAwakeMinutes,
  runKeepAwake,
  startKeepAwake,
  stopKeepAwake
} from "./keep-awake.js";
import {
  runStructuredCommand,
  showStructuredEvidence
} from "./structured-command.js";

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
  fixlab <repository> [--runtime <agency|copilot>]
  fixlab onboard [repository] [--yes] [--authenticate] [--start-dashboard] [--runtime <agency|copilot>]
  fixlab init [repository]
  fixlab prepare [repository] [--yes]
  fixlab doctor [repository] [--runtime <agency|copilot>]
  fixlab setup-playwright [repository] [--yes]
  fixlab authenticate [repository] [--yes]
  fixlab exec [repository] [--cwd <path>] [--stage <name>] [--reuse] [--timeout-seconds <seconds>] [--] <command> [args...]
  fixlab evidence [repository] show <evidence-id> [--stream <summary|stdout|stderr>] [--lines <count>]
  fixlab run [repository] [--runtime <agency|copilot>] [--environment <name>] [--] [request...]
  fixlab validate [repository] --pr <number> [--runtime <agency|copilot>]
  fixlab dashboard [repository] [--port <number>] [--no-open] [--keep-awake-minutes <minutes>] [--runtime <agency|copilot>]
  fixlab chat [repository] [--port <number>] [--runtime <agency|copilot>]
  fixlab keep-awake --minutes <minutes>
  fixlab --help

Commands:
  <repository>
            Open an interactive FixLab shell for setup, fixes, and validation.
  onboard   Run the plan-first repository onboarding workflow.
  init      Detect repository settings and add the initial FixLab profile.
  prepare   Plan or run repository-owned frontend and backend restore commands.
  doctor    Check required tools and repository configuration.
  setup-playwright
            Plan or install the repository-local Playwright package and browser.
  authenticate
            Plan or run the repository-owned browser authentication command.
  exec      Run a command with compact structured output and private evidence.
  evidence  Inspect a bounded portion of redacted structured-command evidence.
  run       Launch the FixLab agent for a request.
  validate  Launch validation-only mode for a pull request.
  dashboard Start the local FixLab dashboard (127.0.0.1:${DEFAULT_DASHBOARD_PORT}).
  chat      Chat with the active dashboard job, starting it when necessary.
  keep-awake
            Temporarily prevent system sleep for a bounded number of minutes.

Runtime:
  agency    Use Agency Copilot (default).
  copilot   Use GitHub Copilot CLI directly.

Set FIXLAB_RUNTIME or pass --runtime to select the runtime.
Run with --environment to select an allowed non-production environment from the repository profile.
For the Agency-like interactive experience, run FixLab with only the repository path.

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

const discoveryIgnoredDirectories = new Set([
  ".git",
  ".github",
  ".next",
  ".nuxt",
  ".turbo",
  "artifacts",
  "bin",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "playwright-report",
  "test-results"
]);

function repositoryPath(repository, path) {
  const value = relative(repository, path);
  return value ? value.split(sep).join("/") : ".";
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function discoverFiles(repository, predicate, maxDepth = 3) {
  const files = [];
  const visit = (directory, depth) => {
    if (depth > maxDepth || files.length >= 200) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!discoveryIgnoredDirectories.has(entry.name)) {
          visit(path, depth + 1);
        }
        continue;
      }
      if (entry.isFile() && predicate(entry.name, path)) {
        files.push(path);
      }
    }
  };
  visit(repository, 0);
  return files;
}

function exactNodeVersion(value) {
  const normalized = String(value ?? "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : "";
}

function detectNodeVersion(repository, frontendDirectory, packageJson) {
  for (const directory of [repository, frontendDirectory]) {
    for (const name of [".nvmrc", ".node-version"]) {
      const path = join(directory, name);
      if (existsSync(path)) {
        const version = exactNodeVersion(readFileSync(path, "utf8"));
        if (version) {
          return {
            version,
            source: repositoryPath(repository, path),
            reviewRequired: false
          };
        }
      }
    }
  }
  const packageVersion = exactNodeVersion(packageJson?.engines?.node);
  if (packageVersion) {
    return {
      version: packageVersion,
      source: "package.json engines.node",
      reviewRequired: false
    };
  }
  return {
    version: exactNodeVersion(process.version),
    source: "active Node.js runtime",
    reviewRequired: true
  };
}

function packageScript(packageManager, name) {
  return name ? `${packageManager} run ${name}` : "";
}

function detectBrowserAuthenticationStatusPaths(frontendDirectory) {
  const candidates = [
    join("e2e", "auth.setup.ts"),
    join("e2e", "auth.setup.js"),
    join("e2e", "fixtures.ts"),
    join("e2e", "fixtures.js"),
    "playwright.config.ts",
    "playwright.config.js"
  ];
  const paths = new Set();
  for (const candidate of candidates) {
    const path = join(frontendDirectory, candidate);
    if (!existsSync(path) || statSync(path).size > 256 * 1024) {
      continue;
    }
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(
      /path\.join\(\s*__dirname\s*,\s*["'](\.[^"']+)["']\s*\)/gu
    )) {
      paths.add(
        join(dirname(candidate), match[1]).replaceAll("\\", "/")
      );
    }
  }
  return [...paths];
}

function detectBrowserHealthUrl(frontendDirectory, port) {
  for (const candidate of [
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mjs"
  ]) {
    const path = join(frontendDirectory, candidate);
    if (!existsSync(path) || statSync(path).size > 256 * 1024) {
      continue;
    }
    const source = readFileSync(path, "utf8");
    if (/https?:\/\/localhost(?::|\$\{)/u.test(source)) {
      return `http://localhost:${port}`;
    }
    if (/https?:\/\/127\.0\.0\.1(?::|\$\{)/u.test(source)) {
      return `http://127.0.0.1:${port}`;
    }
  }
  return `http://127.0.0.1:${port}`;
}

function firstScript(scripts, names) {
  return names.find((name) => typeof scripts?.[name] === "string") ?? "";
}

function detectFrontend(repository) {
  const candidates = discoverFiles(
    repository,
    (name) => name === "package.json",
    3
  )
    .map((packagePath) => {
      const packageJson = readJson(packagePath);
      if (!packageJson) {
        return null;
      }
      const directory = dirname(packagePath);
      const scripts = packageJson.scripts ?? {};
      const dependencies = {
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {})
      };
      const relativeDirectory = repositoryPath(repository, directory);
      let score = relativeDirectory === "." ? 5 : 0;
      if (dependencies.react || dependencies["react-dom"]) {
        score += 100;
      }
      if (scripts.start || scripts.dev || scripts.serve) {
        score += 30;
      }
      if (scripts.build) {
        score += 15;
      }
      if (dependencies["@playwright/test"] || dependencies.playwright) {
        score += 15;
      }
      if (/^(?:frontend|client|web|ui|apps\/(?:web|frontend))$/i.test(relativeDirectory)) {
        score += 20;
      }
      return { directory, packageJson, relativeDirectory, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  return candidates[0] ?? null;
}

function detectBackend(repository) {
  const candidates = discoverFiles(
    repository,
    (name) => name.endsWith(".csproj"),
    4
  )
    .map((projectPath) => {
      const directory = dirname(projectPath);
      const content = readFileSync(projectPath, "utf8");
      let score = /Microsoft\.NET\.Sdk\.Web/i.test(content) ? 100 : 0;
      if (existsSync(join(directory, "Program.cs"))) {
        score += 40;
      }
      if (/api|backend|server/i.test(repositoryPath(repository, directory))) {
        score += 20;
      }
      const solutionDirectories = discoverFiles(
        repository,
        (name) => name.endsWith(".sln"),
        3
      )
        .map((solutionPath) => dirname(solutionPath))
        .filter((solutionDirectory) => {
          const projectRelativePath = relative(solutionDirectory, projectPath);
          return (
            projectRelativePath &&
            !projectRelativePath.startsWith("..") &&
            !projectRelativePath.startsWith(sep)
          );
        })
        .sort((left, right) => right.length - left.length);
      const workingDirectory = solutionDirectories[0] ?? directory;
      return {
        directory,
        workingDirectory,
        projectPath,
        relativeDirectory: repositoryPath(repository, directory),
        relativeWorkingDirectory: repositoryPath(
          repository,
          workingDirectory
        ),
        projectFromWorkingDirectory: repositoryPath(
          workingDirectory,
          projectPath
        ),
        score
      };
    })
    .sort((left, right) => right.score - left.score);
  return candidates[0] ?? null;
}

function detectBackendTestPattern(repository, backend) {
  const testProject = discoverFiles(
    repository,
    (name, path) =>
      name.endsWith(".csproj") &&
      (/test/i.test(name) || /(?:^|[\\/])Tests?(?:[\\/]|$)/i.test(path)),
    4
  )[0];
  if (!testProject) {
    return `${backend.relativeWorkingDirectory}/**/*Test*.cs`;
  }
  const parts = repositoryPath(repository, testProject).split("/");
  const testDirectoryIndex = parts.findIndex((part) => /^tests?$/i.test(part));
  if (testDirectoryIndex >= 0) {
    return `${parts.slice(0, testDirectoryIndex + 1).join("/")}/**/*.cs`;
  }
  return `${repositoryPath(repository, dirname(testProject))}/**/*.cs`;
}

function detectBackendLaunch(backend) {
  const launchSettings = readJson(
    join(backend.directory, "Properties", "launchSettings.json")
  );
  const projectProfile = Object.values(launchSettings?.profiles ?? {}).find(
    (profile) =>
      profile?.commandName === "Project" &&
      typeof profile.applicationUrl === "string"
  );
  const applicationUrls = projectProfile?.applicationUrl
    ?.split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const selectedUrl =
    applicationUrls?.find((value) => value.startsWith("http://")) ??
    applicationUrls?.[0];
  if (!selectedUrl) {
    return {
      port: 5000,
      healthUrl: "http://127.0.0.1:5000"
    };
  }
  try {
    const url = new URL(selectedUrl);
    url.hostname = "127.0.0.1";
    const launchPath =
      typeof projectProfile.launchUrl === "string"
        ? projectProfile.launchUrl.trim()
        : "";
    if (launchPath) {
      url.pathname = `/${launchPath.replace(/^\/+/, "")}`;
    }
    return {
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      healthUrl: url.toString().replace(/\/$/, "")
    };
  } catch {
    return {
      port: 5000,
      healthUrl: "http://127.0.0.1:5000"
    };
  }
}

function detectDefaultBranch(repository) {
  const currentBranch = spawnSync("git", ["branch", "--show-current"], {
    cwd: repository,
    encoding: "utf8",
    shell: false
  }).stdout?.trim();
  if (["main", "develop", "master"].includes(currentBranch)) {
    return currentBranch;
  }

  const headName = spawnSync(
    "git",
    [
      "name-rev",
      "--name-only",
      "--refs=refs/remotes/origin/*",
      "HEAD"
    ],
    { cwd: repository, encoding: "utf8", shell: false }
  );
  if (headName.status === 0) {
    const branch = headName.stdout
      .trim()
      .replace(/^remotes\/origin\//, "")
      .replace(/^origin\//, "")
      .replace(/~\d+$/, "");
    if (branch && branch !== "undefined") {
      return branch;
    }
  }

  const remoteHead = spawnSync(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { cwd: repository, encoding: "utf8", shell: false }
  );
  if (remoteHead.status === 0) {
    return remoteHead.stdout.trim().replace(/^origin\//, "") || "main";
  }
  for (const branch of ["main", "develop", "master"]) {
    const result = spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repository, shell: false }
    );
    if (result.status === 0) {
      return branch;
    }
  }
  return "main";
}

function createDetectedProfile(repository) {
  const template = JSON.parse(
    readFileSync(
      join(packageRoot, "templates", "repository-profile.json"),
      "utf8"
    )
  );
  const frontend = detectFrontend(repository);
  const backend = detectBackend(repository);
  const findings = [];
  const unresolved = [];

  template.name =
    frontend?.packageJson?.displayName ??
    frontend?.packageJson?.name ??
    basename(repository);
  template.pullRequests.defaultTargetBranch =
    detectDefaultBranch(repository);

  if (frontend) {
    const scripts = frontend.packageJson.scripts ?? {};
    const packageManager = detectPackageManager(frontend.directory);
    const startScript = firstScript(scripts, [
      "start:local",
      "start",
      "dev",
      "serve"
    ]);
    const testScript = firstScript(scripts, ["test", "test:unit"]);
    const typeCheckScript = firstScript(scripts, [
      "type-check",
      "typecheck",
      "check:types"
    ]);
    const e2eScript = firstScript(scripts, [
      "test:e2e",
      "e2e",
      "test:playwright",
      "playwright"
    ]);
    const authenticationScript = firstScript(scripts, [
      "test:e2e:auth",
      "e2e:auth",
      "playwright:auth",
      "auth:e2e"
    ]);
    const sourceDirectory = existsSync(join(frontend.directory, "src"))
      ? `${frontend.relativeDirectory === "." ? "" : `${frontend.relativeDirectory}/`}src`
      : frontend.relativeDirectory;
    const startCommand = packageScript(packageManager, startScript);
    const startSource = scripts[startScript] ?? "";
    const portMatch = startSource.match(/(?:--port(?:=|\s+)|PORT=)(\d{2,5})/i);
    const isVite =
      Boolean(frontend.packageJson.dependencies?.vite) ||
      Boolean(frontend.packageJson.devDependencies?.vite);
    const port = portMatch ? Number(portMatch[1]) : isVite ? 5173 : 3000;
    const browserHealthUrl = detectBrowserHealthUrl(
      frontend.directory,
      port
    );
    const node = detectNodeVersion(
      repository,
      frontend.directory,
      frontend.packageJson
    );

    template.toolchain = { nodeVersion: node.version };
    template.components[0] = {
      name: "frontend",
      paths: [sourceDirectory],
      testPatterns: [
        `${sourceDirectory}/**/*.test.ts`,
        `${sourceDirectory}/**/*.test.tsx`
      ]
    };
    template.validation.commands.frontendRestore =
      packageManager === "npm" && existsSync(join(frontend.directory, "package-lock.json"))
        ? "npm ci"
        : packageManager === "pnpm"
          ? "pnpm install --frozen-lockfile"
          : packageManager === "yarn"
            ? "yarn install --frozen-lockfile"
            : "npm install";
    template.validation.commands.frontendTest =
      packageScript(packageManager, testScript);
    template.validation.commands.frontendTypeCheck =
      packageScript(packageManager, typeCheckScript);
    template.validation.commands.frontendBuild =
      packageScript(packageManager, firstScript(scripts, ["build"]));
    template.applications.frontend = {
      workingDirectory: frontend.relativeDirectory,
      command: startCommand,
      port,
      healthUrl: `http://127.0.0.1:${port}`
    };
    const environments = {};
    for (const scriptName of Object.keys(scripts)) {
      const match = scriptName.match(
        /^start:(local|dev|development|sit|uat|integration)$/i
      );
      if (!match) {
        continue;
      }
      const environment =
        match[1].toLowerCase() === "dev"
          ? "development"
          : match[1].toLowerCase();
      environments[environment] = {
        frontendCommand: packageScript(packageManager, scriptName),
        healthUrl: browserHealthUrl,
        authenticationRequired: false
      };
    }
    if (/dev/i.test(scripts.start ?? "") && !environments.development) {
      environments.development = {
        frontendCommand: packageScript(packageManager, "start"),
        healthUrl: browserHealthUrl,
        authenticationRequired: false
      };
    }
    if (startCommand) {
      const environment =
        ["dev", "serve"].includes(startScript) ? "development" : "local";
      if (!environments[environment]) {
        environments[environment] = {
          frontendCommand: startCommand,
          healthUrl: browserHealthUrl,
          authenticationRequired: false
        };
      }
    }
    template.environments = environments;
    template.browserAutomation.workingDirectory =
      frontend.relativeDirectory;
    template.browserAutomation.package =
      frontend.packageJson.dependencies?.["@playwright/test"] ||
      frontend.packageJson.devDependencies?.["@playwright/test"]
        ? "@playwright/test"
        : frontend.packageJson.dependencies?.playwright ||
            frontend.packageJson.devDependencies?.playwright
          ? "playwright"
          : "@playwright/test";
    template.browserAutomation.testCommand =
      packageScript(packageManager, e2eScript) ||
      (packageManager === "pnpm"
        ? "pnpm exec playwright test"
        : packageManager === "yarn"
          ? "yarn playwright test"
          : "npx playwright test");
    if (authenticationScript) {
      const authentication = template.browserAutomation.authentication;
      authentication.command = packageScript(
        packageManager,
        authenticationScript
      );
      authentication.statusPaths =
        detectBrowserAuthenticationStatusPaths(frontend.directory);
      for (const [environment, configuration] of Object.entries(
        environments
      )) {
        configuration.authenticationRequired = environment !== "local";
      }
      if (authentication.statusPaths.length === 0) {
        unresolved.push(
          "set browserAutomation.authentication.statusPaths for the detected browser authentication command"
        );
      }
    }
    findings.push(
      `frontend ${frontend.relativeDirectory} (${packageManager}, Node.js ${node.version} from ${node.source})`
    );
    if (node.reviewRequired) {
      unresolved.push(
        `confirm that Node.js ${node.version} is repository-supported or replace toolchain.nodeVersion with the exact supported version`
      );
    }
    if (!startCommand) {
      unresolved.push(
        `add a start, dev, or serve script for ${frontend.relativeDirectory}/package.json`
      );
    }
  } else {
    unresolved.push("set the frontend package path and commands");
  }

  if (backend) {
    const sourceDirectory = existsSync(join(backend.directory, "src"))
      ? `${backend.relativeDirectory === "." ? "" : `${backend.relativeDirectory}/`}src`
      : backend.relativeDirectory;
    template.components[1] = {
      name: "backend",
      paths: [sourceDirectory],
      testPatterns: [detectBackendTestPattern(repository, backend)]
    };
    template.applications.backend.workingDirectory =
      backend.relativeWorkingDirectory;
    template.applications.backend.command =
      backend.projectFromWorkingDirectory === basename(backend.projectPath)
        ? "dotnet run"
        : `dotnet run --project ${backend.projectFromWorkingDirectory}`;
    const backendLaunch = detectBackendLaunch(backend);
    template.applications.backend.port = backendLaunch.port;
    template.applications.backend.healthUrl = backendLaunch.healthUrl;
    template.validation.commands.backendRestore = "dotnet restore";
    template.validation.commands.backendTest = "dotnet test";
    template.validation.commands.backendBuild = "dotnet build";
    findings.push(
      `backend ${backend.relativeDirectory} (${basename(backend.projectPath)})`
    );
  } else {
    unresolved.push("set the ASP.NET project path and commands");
  }

  return { profile: template, findings, unresolved };
}

function profileSetupIssues(repository, profile) {
  const issues = [];
  const frontendDirectory = resolve(
    repository,
    profile?.applications?.frontend?.workingDirectory ?? ""
  );
  const backendDirectory = resolve(
    repository,
    profile?.applications?.backend?.workingDirectory ?? ""
  );
  if (!existsSync(frontendDirectory)) {
    issues.push("frontend working directory does not exist");
  }
  if (!profile?.applications?.frontend?.command?.trim()) {
    issues.push("frontend startup command is missing");
  }
  if (
    profile?.validation?.commands?.backendRestore?.trim() &&
    !existsSync(backendDirectory)
  ) {
    issues.push("backend working directory does not exist");
  }
  if (
    profile?.environments &&
    !Array.isArray(profile.environments) &&
    typeof profile.environments === "object"
  ) {
    const authentication = profile.browserAutomation?.authentication ?? {};
    for (const [environment, configuration] of Object.entries(
      profile.environments
    )) {
      if (!configuration?.frontendCommand?.trim()) {
        issues.push(
          `environment ${environment} frontend startup command is missing`
        );
      }
      if (!configuration?.healthUrl?.trim()) {
        issues.push(`environment ${environment} health URL is missing`);
      }
      if (
        configuration?.authenticationRequired === true &&
        (!authentication.command?.trim() ||
          !Array.isArray(authentication.statusPaths) ||
          authentication.statusPaths.length === 0)
      ) {
        issues.push(
          `environment ${environment} requires browser authentication configuration`
        );
      }
    }
  }
  return issues;
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
      if (Array.isArray(profile?.environments)) {
        console.log(
          "Profile upgrade required: replace the environments array with environment objects containing frontendCommand, healthUrl, and authenticationRequired."
        );
      }
    } catch {
      console.log(
        "The existing profile could not be parsed; fix its JSON before running fixlab doctor."
      );
    }
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    const discovery = createDetectedProfile(repository);
    writeFileSync(
      destination,
      `${JSON.stringify(discovery.profile, null, 2)}\n`
    );
    console.log(`Created ${destination}`);
    for (const finding of discovery.findings) {
      console.log(`Detected ${finding}.`);
    }
    for (const unresolved of discovery.unresolved) {
      console.log(`Review required: ${unresolved}.`);
    }
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
  console.log(
    "Review the detected paths, commands, ports, allowed environments, authentication, and branch ownership before approving setup."
  );
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

function packageIsDeclared(workingDirectory, packageName) {
  const packageJson = readJson(join(workingDirectory, "package.json"));
  return Boolean(
    packageJson?.dependencies?.[packageName] ||
      packageJson?.devDependencies?.[packageName] ||
      packageJson?.optionalDependencies?.[packageName]
  );
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
  ).filter(
    (_, index) =>
      index > 0 ||
      (!current.packageCheck.ok &&
        !packageIsDeclared(workingDirectory, packageName))
  );

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
  const environmentAuthenticationRequired =
    profile.environments &&
    !Array.isArray(profile.environments) &&
    typeof profile.environments === "object" &&
    Object.values(profile.environments).some(
      (configuration) => configuration?.authenticationRequired === true
    );
  if (
    (authentication.required !== true && !environmentAuthenticationRequired) ||
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
  let keepAwakeMinutes = 0;
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
    if (argument === "--keep-awake-minutes") {
      if (!args[index + 1]) {
        return {
          error: "dashboard requires a value after --keep-awake-minutes"
        };
      }
      try {
        keepAwakeMinutes = parseKeepAwakeMinutes(
          args[index + 1],
          "--keep-awake-minutes"
        );
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
    keepAwakeMinutes
  };
}

function parseChatArguments(args) {
  let repositoryArgument;
  let port = DEFAULT_DASHBOARD_PORT;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      if (!args[index + 1]) {
        return { error: "chat requires a value after --port" };
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
      return { error: `unknown chat option: ${argument}` };
    }
    if (repositoryArgument) {
      return { error: "chat accepts at most one repository path" };
    }
    repositoryArgument = argument;
  }
  return { port, repositoryArgument };
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

async function promptForApproval(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = (await readline.question(`${question} [y/N]: `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
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
    const loaded = loadProfile(repository);
    if (loaded.error) {
      console.error(`Cannot continue onboarding because ${loaded.error}.`);
      return 1;
    }
    const discovery = createDetectedProfile(repository);
    const setupIssues = [
      ...discovery.unresolved,
      ...profileSetupIssues(repository, loaded.profile)
    ];
    if (setupIssues.length > 0) {
      console.log("FixLab generated a profile from repository discovery.");
      console.log("Complete these repository-specific fields before setup:");
      for (const issue of setupIssues) {
        console.log(`  - ${issue}`);
      }
      console.log("Then rerun fixlab onboard for this repository.");
      return 0;
    }
    console.log(
      "FixLab generated a usable initial profile from the detected repository structure."
    );
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
    approved = await promptForApproval(
      "Run the displayed restore and Playwright installation commands now?"
    );
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
  }

  const preparationResult = prepare(repository, true);
  if (preparationResult !== 0) {
    return preparationResult;
  }
  const playwrightResult = setupPlaywright(repository, true);
  if (playwrightResult !== 0) {
    return playwrightResult;
  }
  const loaded = loadProfile(repository);
  const environmentAuthenticationRequired =
    loaded.profile?.environments &&
    !Array.isArray(loaded.profile.environments) &&
    typeof loaded.profile.environments === "object" &&
    Object.values(loaded.profile.environments).some(
      (configuration) => configuration?.authenticationRequired === true
    );
  if (
    !authenticateBrowser &&
    (loaded.profile?.browserAutomation?.authentication?.required === true ||
      environmentAuthenticationRequired)
  ) {
    authenticateBrowser = await promptForApproval(
      "Run the repository-owned interactive browser authentication command?"
    );
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
  if (!startDashboard) {
    startDashboard = await promptForApproval(
      "Doctor passed. Start the FixLab dashboard now?"
    );
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

async function dashboard(
  repository,
  port,
  shouldOpen,
  runtime,
  keepAwakeMinutes = 0
) {
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
  let keepAwakeHandle;
  if (keepAwakeMinutes > 0) {
    try {
      keepAwakeHandle = startKeepAwake(keepAwakeMinutes);
      await keepAwakeHandle.ready;
      keepAwakeHandle.child.once("error", (error) => {
        console.error(`Keep-awake timer failed: ${error.message}`);
      });
      console.log(
        `Keep-awake timer: ${keepAwakeMinutes} minute(s); screen locking is allowed, but interactive browser steps may require an unlocked desktop.`
      );
    } catch (error) {
      stopKeepAwake(keepAwakeHandle);
      await dashboardServer.close();
      console.error(`Cannot start keep-awake timer: ${error.message}`);
      return 1;
    }
  }
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
    stopKeepAwake(keepAwakeHandle);
    await dashboardServer.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return 0;
}

async function promptForChatRepository() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "no FixLab dashboard is running; rerun as fixlab chat <repository> or use an interactive terminal to choose the repository"
    );
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = (
      await readline.question(
        `Repository path [${process.cwd()}]: `
      )
    ).trim();
    return resolveRepository(answer || process.cwd());
  } finally {
    readline.close();
  }
}

async function promptForRepositoryConfirmation(repository) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return "";
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    return (
      await readline.question(
        `Connected repository: ${repository}\nPress Enter to continue, or enter another repository path: `
      )
    ).trim();
  } finally {
    readline.close();
  }
}

async function canListenOnPort(port) {
  return new Promise((resolvePort) => {
    const server = createNetServer();
    server.unref();
    server.once("error", () => resolvePort(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolvePort(true));
    });
  });
}

async function findAvailableDashboardPort(startPort) {
  for (
    let candidate = startPort;
    candidate <= Math.min(65535, startPort + 20);
    candidate += 1
  ) {
    if (await canListenOnPort(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `no available FixLab dashboard port was found from ${startPort} through ${Math.min(
      65535,
      startPort + 20
    )}`
  );
}

async function waitForDashboard(baseUrl, child) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the FixLab dashboard exited with code ${child.exitCode}`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/status`, {
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`dashboard returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `the FixLab dashboard did not become ready within 15 seconds${
      lastError?.message ? `: ${lastError.message}` : ""
    }`
  );
}

async function startDashboardForChat({
  repositoryArgument,
  port,
  runtime,
  baseUrl
}) {
  let repository;
  if (repositoryArgument) {
    repository = resolveRepository(repositoryArgument);
  } else {
    const currentRepository = resolveRepository(process.cwd());
    repository = inspectRepository(currentRepository).repositoryReady
      ? currentRepository
      : await promptForChatRepository();
  }
  if (!existsSync(repository) || !statSync(repository).isDirectory()) {
    throw new Error(`repository does not exist or is not a directory: ${repository}`);
  }

  let readiness = inspectRepository(repository);
  if (!readiness.repositoryReady) {
    if (!existsSync(join(repository, profileRelativePath))) {
      const initResult = init(repository);
      if (initResult !== 0) {
        throw new Error(`could not initialize FixLab for ${repository}`);
      }
    }
    console.log(
      "The repository is not dashboard-ready. Opening the interactive FixLab onboarding session first."
    );
    const onboardingResult = launch(repository, "", runtime);
    if (onboardingResult !== 0) {
      throw new Error(
        `FixLab onboarding exited with code ${onboardingResult}`
      );
    }
    readiness = inspectRepository(repository);
    if (!readiness.repositoryReady) {
      throw new Error(
        `onboarding finished but the repository is not dashboard-ready: ${readiness.error}`
      );
    }
  }

  console.log(`Starting FixLab dashboard for ${repository}...`);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "dashboard",
      repository,
      "--port",
      String(port),
      "--no-open",
      "--runtime",
      runtime
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  await waitForDashboard(baseUrl, child);
  child.unref();
  console.log(`FixLab dashboard started at ${baseUrl}.`);
  return baseUrl;
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

  if (command === "exec") {
    return runStructuredCommand(rest, process.cwd());
  }

  if (command === "evidence") {
    return showStructuredEvidence(rest, process.cwd());
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
    return dashboard(
      parsed.repository,
      parsed.port,
      parsed.open,
      runtimeArguments.runtime,
      parsed.keepAwakeMinutes
    );
  }

  if (command === "keep-awake") {
    if (
      rest.length !== 2 ||
      rest[0] !== "--minutes"
    ) {
      console.error("keep-awake requires --minutes <minutes>");
      return 1;
    }
    try {
      return runKeepAwake(parseKeepAwakeMinutes(rest[1]));
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }

  if (command === "chat") {
    const runtimeArguments = parseRuntimeArguments(rest);
    if (runtimeArguments.error) {
      console.error(runtimeArguments.error);
      return 1;
    }
    const parsed = parseChatArguments(runtimeArguments.args);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    const baseUrl = `http://127.0.0.1:${parsed.port}`;
    const switchRepository = async ({
      baseUrl: currentBaseUrl = baseUrl,
      readiness,
      repository: requestedRepository
    }) => {
      const connectedRepository = readiness?.repository;
      let repositoryArgument = requestedRepository;
      if (!repositoryArgument) {
        repositoryArgument = await promptForChatRepository();
      }
      const repository = resolveRepository(repositoryArgument);
      if (
        connectedRepository &&
        repository.toLowerCase() ===
          resolve(connectedRepository).toLowerCase()
      ) {
        return currentBaseUrl;
      }
      const alternatePort = await findAvailableDashboardPort(
        parsed.port + 1
      );
      const alternateUrl = `http://127.0.0.1:${alternatePort}`;
      return startDashboardForChat({
        repositoryArgument: repository,
        port: alternatePort,
        runtime: runtimeArguments.runtime,
        baseUrl: alternateUrl
      });
    };
    return runChat({
      baseUrl,
      recoverConnection: () =>
        startDashboardForChat({
          repositoryArgument: parsed.repositoryArgument,
          port: parsed.port,
          runtime: runtimeArguments.runtime,
          baseUrl
        }),
      selectRepository: async ({ readiness }) => {
        const connectedRepository = readiness?.repository;
        let requestedRepository = parsed.repositoryArgument;
        if (
          requestedRepository &&
          connectedRepository &&
          resolve(requestedRepository).toLowerCase() ===
            resolve(connectedRepository).toLowerCase()
        ) {
          return baseUrl;
        }
        if (!requestedRepository) {
          requestedRepository = await promptForRepositoryConfirmation(
            connectedRepository ?? "unknown"
          );
        }
        if (!requestedRepository) {
          return baseUrl;
        }
        return switchRepository({
          baseUrl,
          readiness,
          repository: requestedRepository
        });
      },
      switchRepository,
      openDashboard: ({ baseUrl: dashboardUrl }) =>
        openBrowser(dashboardUrl)
    });
  }

  if (!command.startsWith("-")) {
    const parsed = parseRuntimeArguments(args);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    if (parsed.args.length !== 1) {
      console.error(
        "interactive FixLab accepts one repository path and an optional --runtime"
      );
      return 1;
    }
    return launch(
      resolveRepository(parsed.args[0]),
      "",
      parsed.runtime
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
