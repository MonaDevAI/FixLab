import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/fixlab.js", import.meta.url));

function run(args, cwd, environment = {}, input = undefined) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    input
  });
}

test("help lists supported commands", () => {
  const result = run(["--help"], process.cwd());

  assert.equal(result.status, 0);
  assert.match(result.stdout, /fixlab init/);
  assert.match(result.stdout, /fixlab prepare/);
  assert.match(result.stdout, /fixlab validate/);
  assert.match(result.stdout, /fixlab dashboard/);
  assert.match(result.stdout, /--runtime <agency\|copilot>/);
  assert.match(result.stdout, /--environment <name>/);
  assert.match(result.stdout, /FIXLAB_RUNTIME/);
  assert.match(result.stdout, /127\.0\.0\.1:4317/);
  assert.match(result.stdout, /docs\/troubleshooting\.md/);
});

test("init creates a parseable repository profile", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    const result = run(["init", repository], repository);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );

    assert.equal(result.status, 0);
    assert.equal(existsSync(profilePath), true);
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    assert.equal(profile.browserAutomation.package, "@playwright/test");
    assert.equal(profile.browserAutomation.browser, "chromium");
    assert.equal(profile.browserAutomation.testCommand, "npm run test:e2e");
    assert.deepEqual(profile.browserAutomation.testSynthesis, {
      enabled: true,
      defaultDataSource: "synthetic-intercepted",
      mutationMode: "intercepted",
      requireScenarioEvidence: true
    });
    assert.equal(profile.browserAutomation.authentication.required, false);
    assert.equal(profile.browserAutomation.dataSafety.productionAllowed, false);
    assert.equal(profile.pullRequests.branchNaming.userId, "your-user-id");
    assert.equal(
      profile.pullRequests.branchNaming.prefixTemplate,
      "users/{userId}"
    );
    const promptDirectory = join(repository, ".github", "prompts");
    const expectedPrompts = [
      "fixlab.bugfix.prompt.md",
      "fixlab.intake.prompt.md",
      "fixlab.diagnose.prompt.md",
      "fixlab.reproduce.prompt.md",
      "fixlab.fix.prompt.md",
      "fixlab.validate.prompt.md",
      "fixlab.live-test.prompt.md",
      "fixlab.pr.prompt.md"
    ];
    for (const promptName of expectedPrompts) {
      assert.equal(existsSync(join(promptDirectory, promptName)), true);
    }
    const agentPath = join(
      repository,
      ".github",
      "agents",
      "fixlab-autofix.agent.md"
    );
    assert.equal(existsSync(agentPath), true);
    const agent = readFileSync(agentPath, "utf8");
    assert.match(agent, /target: vscode/);
    assert.match(agent, /Fix one reported bug/);
    assert.match(agent, /\.github\/fixlab\/repository-profile\.json/);
    assert.match(agent, /Never select production automatically/);

    const bugfixPrompt = readFileSync(
      join(promptDirectory, "fixlab.bugfix.prompt.md"),
      "utf8"
    );
    assert.match(bugfixPrompt, /agent: fixlab-autofix/);
    assert.match(bugfixPrompt, /smallest complete correction/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("init preserves existing profile and prompt files", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const promptPath = join(
      repository,
      ".github",
      "prompts",
      "fixlab.validate.prompt.md"
    );
    const agentPath = join(
      repository,
      ".github",
      "agents",
      "fixlab-autofix.agent.md"
    );
    writeFileSync(profilePath, '{"name":"custom"}');
    writeFileSync(promptPath, "custom prompt");
    writeFileSync(agentPath, "custom agent");
    const second = run(["init", repository], repository);

    assert.equal(second.status, 0);
    assert.match(second.stdout, /Kept existing FixLab profile/);
    assert.match(
      second.stdout,
      /Existing profiles are preserved and are not upgraded automatically/
    );
    assert.match(
      second.stdout,
      /Profile upgrade required: add browserAutomation\.testSynthesis/
    );
    assert.match(second.stdout, /Kept existing FixLab prompt/);
    assert.match(second.stdout, /Kept existing FixLab agent/);
    assert.equal(readFileSync(profilePath, "utf8"), '{"name":"custom"}');
    assert.equal(readFileSync(promptPath, "utf8"), "custom prompt");
    assert.equal(readFileSync(agentPath, "utf8"), "custom agent");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor blocks when Playwright is unavailable", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const result = run(["doctor", repository], repository);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Playwright package/);
    assert.match(result.stdout, /FAIL  Playwright browser/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor and prepare block a broken frontend package manager", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    mkdirSync(join(repository, "frontend"), { recursive: true });
    mkdirSync(join(repository, "backend", "src"), { recursive: true });
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "npm.cmd" : "npm"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\nif \"%1\"==\"--version\" (\r\n  echo 11.17.0\r\n  exit /b 0\r\n)\r\necho TypeError: Class extends value undefined is not a constructor or null 1>&2\r\nexit /b 1\r\n"
        : "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  printf '%s\\n' '11.17.0'\n  exit 0\nfi\nprintf '%s\\n' 'TypeError: Class extends value undefined is not a constructor or null' >&2\nexit 1\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }
    const path = [
      executableDirectory,
      process.env.PATH
    ].filter(Boolean).join(process.platform === "win32" ? ";" : ":");

    const doctorResult = run(["doctor", repository], repository, {
      PATH: path
    });
    assert.equal(doctorResult.status, 1);
    assert.match(doctorResult.stdout, /FAIL  Frontend package manager/);
    assert.match(
      doctorResult.stdout,
      /align the active Node\.js and npm installation/
    );

    const prepareResult = run(
      ["prepare", repository, "--yes"],
      repository,
      { PATH: path }
    );
    assert.equal(prepareResult.status, 1);
    assert.match(prepareResult.stdout, /FAIL  Frontend package manager/);
    assert.match(
      prepareResult.stderr,
      /stopped before dependency restore/
    );
    assert.match(prepareResult.stderr, /docs\/troubleshooting\.md/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor and dashboard block an incomplete live-test profile", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    delete profile.browserAutomation.testCommand;
    profile.browserAutomation.authentication = {};
    profile.browserAutomation.dataSafety.productionAllowed = true;
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = run(["doctor", repository], repository);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Live-test profile/);
    assert.match(result.stdout, /browserAutomation\.testCommand/);
    assert.match(result.stdout, /browserAutomation\.authentication\.required/);
    assert.match(result.stdout, /browserAutomation\.dataSafety\.productionAllowed=false/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor blocks until required browser authentication is complete", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.browserAutomation.authentication = {
      required: true,
      command: "npm run test:e2e:auth",
      statusPaths: ["e2e/.auth/user.json"]
    };
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = run(["doctor", repository], repository);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Live-test profile/);
    assert.match(result.stdout, /browserAutomation authentication is not ready/);
    assert.match(result.stdout, /e2e\/\.auth\/user\.json/);
    assert.match(result.stderr, /Next action: run "npm run test:e2e:auth"/);
    assert.match(result.stderr, /complete interactive sign-in/);
    assert.match(result.stderr, /docs\/troubleshooting\.md/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor redacts secrets from authentication command guidance", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.browserAutomation.authentication = {
      required: true,
      command:
        "cross-env TOKEN=super-secret npm run auth --password hunter2 --url https://user:pass@example.test",
      statusPaths: ["e2e/.auth/user.json"]
    };
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = run(["doctor", repository], repository);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /TOKEN=\[REDACTED\]/);
    assert.match(result.stderr, /--password \[REDACTED\]/);
    assert.match(result.stderr, /https:\/\/user:\[REDACTED\]@example\.test/);
    assert.doesNotMatch(result.stderr, /super-secret|hunter2|user:pass/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor blocks when the repository-pinned .NET SDK cannot resolve", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    writeFileSync(
      join(repository, "global.json"),
      JSON.stringify({ sdk: { version: "8.0.421" } })
    );
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "dotnet.cmd" : "dotnet"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho A compatible .NET SDK was not found. 1>&2\r\nexit /b 1\r\n"
        : "#!/bin/sh\nprintf '%s\\n' 'A compatible .NET SDK was not found.' >&2\nexit 1\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const isolatedPath =
      process.platform === "win32"
        ? [
            executableDirectory,
            join(process.env.SystemRoot, "System32"),
            process.env.SystemRoot
          ].join(";")
        : `${executableDirectory}:/usr/bin:/bin`;
    const result = run(["doctor", repository], repository, {
      PATH: isolatedPath
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /FAIL  \.NET SDK \(requires 8\.0\.421 from .*global\.json\)/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor launches the configured Playwright browser", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const playwrightDirectory = join(
      repository,
      "frontend",
      "node_modules",
      "@playwright",
      "test"
    );
    mkdirSync(playwrightDirectory, { recursive: true });
    writeFileSync(
      join(playwrightDirectory, "index.js"),
      "exports.chromium = { launch: async (options) => { if (options.channel !== 'msedge') throw new Error('missing Edge channel'); return { close: async () => {} }; } };"
    );
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.browserAutomation.channel = "msedge";
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = run(["doctor", repository], repository);

    assert.match(result.stdout, /PASS  Playwright package/);
    assert.match(
      result.stdout,
      /PASS  Playwright browser \(chromium channel msedge launched successfully\)/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("prepare plans and runs repository-owned restore commands", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.validation.commands.frontendRestore = "node prepare.js";
    profile.validation.commands.backendRestore = "node prepare.js";
    writeFileSync(profilePath, JSON.stringify(profile));

    for (const application of ["frontend", "backend/src"]) {
      const workingDirectory = join(repository, application);
      mkdirSync(workingDirectory, { recursive: true });
      writeFileSync(
        join(workingDirectory, "prepare.js"),
        'require("node:fs").writeFileSync("prepared.txt", "ready");'
      );
    }

    const planned = run(["prepare", repository], repository);
    assert.equal(planned.status, 0);
    assert.match(planned.stdout, /Repository preparation plan/);
    assert.match(planned.stdout, /No commands executed/);
    assert.equal(
      existsSync(join(repository, "frontend", "prepared.txt")),
      false
    );

    const prepared = run(["prepare", repository, "--yes"], repository);
    assert.equal(prepared.status, 0);
    assert.match(prepared.stdout, /PASS  frontend restore/);
    assert.match(prepared.stdout, /PASS  backend restore/);
    assert.equal(
      readFileSync(join(repository, "frontend", "prepared.txt"), "utf8"),
      "ready"
    );
    assert.equal(
      readFileSync(join(repository, "backend", "src", "prepared.txt"), "utf8"),
      "ready"
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("prepare restore failures include troubleshooting guidance", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.validation.commands.frontendRestore =
      'node -e "process.exit(7)"';
    delete profile.validation.commands.backendRestore;
    writeFileSync(profilePath, JSON.stringify(profile));
    mkdirSync(join(repository, "frontend"), { recursive: true });

    const result = run(["prepare", repository, "--yes"], repository);

    assert.equal(result.status, 7);
    assert.match(result.stderr, /frontend restore failed/);
    assert.match(result.stderr, /docs\/troubleshooting\.md/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("setup-playwright plans approved repository-local commands without changing files", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const frontend = join(repository, "frontend");
    mkdirSync(frontend, { recursive: true });
    writeFileSync(join(frontend, "package-lock.json"), "{}");

    const result = run(["setup-playwright", repository], repository);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Detected package manager: npm/);
    assert.match(result.stdout, /npm install --save-dev @playwright\/test/);
    assert.match(result.stdout, /npx playwright install chromium/);
    assert.match(result.stdout, /No changes made/);
    assert.equal(existsSync(join(frontend, "node_modules")), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("validate requires a numeric pull request", () => {
  const result = run(["validate", "--pr", "invalid"], process.cwd());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /only digits/);
});

test("repository commands reject pull request URLs", () => {
  const result = run(
    [
      "doctor",
      "https://example.test/project/_git/application/pullrequest/123"
    ],
    process.cwd()
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be a local directory, not a URL/);
  assert.match(result.stderr, /fixlab validate --pr <number>/);
  assert.doesNotMatch(result.stderr, /https:\\/);
});

test("dashboard rejects invalid ports before starting", () => {
  const result = run(["dashboard", "--port", "70000"], process.cwd());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /integer between 1 and 65535/);
});

test("dashboard rejects unknown options before starting", () => {
  const result = run(["dashboard", "--public"], process.cwd());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown dashboard option/);
});

test("dashboard rejects a missing repository before starting", () => {
  const missing = join(tmpdir(), `fixlab-missing-${Date.now()}`);
  const result = run(["dashboard", missing, "--no-open"], process.cwd());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository does not exist/);
});

test("run launches the Agency-resolved FixLab agent", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.browserAutomation.testSynthesis.defaultDataSource =
      "non-production-read-only";
    writeFileSync(profilePath, JSON.stringify(profile));
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "agency.cmd" : "agency"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho ARGS:%*\r\nmore\r\n"
        : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\ncat\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const result = run(
      [
        "run",
        repository,
        "--environment",
        "development",
        "--",
        "repair",
        "the",
        "defect"
      ],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      }
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /ARGS:copilot --plugin-dir .*FixLab --agent fixlab:fixlab/);
    assert.doesNotMatch(result.stdout, /--interactive/);
    assert.match(result.stdout, /Use development as the user-selected validation environment/);
    assert.match(result.stdout, /Do not silently fall back/);
    assert.match(result.stdout, /primary business-data source/);
    assert.match(result.stdout, /synthetic pass proves the UI behavior only/);
    assert.match(result.stdout, /FIXLAB_ACTIVITY/);
    assert.match(result.stdout, /FIXLAB_TEST/);
    assert.match(result.stdout, /transient validation artifacts/);
    assert.match(result.stdout, /\*\.auth\.spec\.ts/);
    assert.match(result.stdout, /Request: repair the defect/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("Agency backend-first guidance requires both environment and read-only source", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "agency.cmd" : "agency"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\nmore\r\n"
        : "#!/bin/sh\ncat\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }
    const environment = {
      PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
    };

    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    const selectedWithoutReadOnly = run(
      [
        "run",
        repository,
        "--environment",
        "development",
        "--",
        "repair",
        "the",
        "defect"
      ],
      repository,
      environment
    );
    assert.equal(selectedWithoutReadOnly.status, 0);
    assert.match(
      selectedWithoutReadOnly.stdout,
      /Use development as the user-selected validation environment/
    );
    assert.doesNotMatch(
      selectedWithoutReadOnly.stdout,
      /primary business-data source/
    );

    profile.browserAutomation.testSynthesis.defaultDataSource =
      "non-production-read-only";
    writeFileSync(profilePath, JSON.stringify(profile));
    const readOnlyWithoutSelection = run(
      ["run", repository, "--", "repair", "the", "defect"],
      repository,
      environment
    );
    assert.equal(readOnlyWithoutSelection.status, 0);
    assert.doesNotMatch(
      readOnlyWithoutSelection.stdout,
      /primary business-data source/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("run launches the FixLab plugin directly through Copilot", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "copilot.cmd" : "copilot"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho ARGS:%*\r\nmore\r\n"
        : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\ncat\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const result = run(
      [
        "run",
        repository,
        "--runtime",
        "copilot",
        "--",
        "repair",
        "the",
        "defect"
      ],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      }
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /--plugin-dir .*FixLab --agent fixlab:fixlab/);
    assert.match(result.stdout, /--autopilot/);
    assert.match(result.stdout, /transient validation artifacts/);
    assert.match(result.stdout, /\*\.auth\.spec\.ts/);
    assert.match(result.stdout, /Request: repair the defect/);
    assert.doesNotMatch(result.stdout, /--interactive repair the defect/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("run without a request preserves interactive Agency mode", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "agency.cmd" : "agency"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho ARGS:%*\r\nmore\r\n"
        : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\ncat\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const result = run(
      ["run", repository],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      },
      "interactive input\n"
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /--plugin-dir .*FixLab --agent fixlab:fixlab/);
    assert.doesNotMatch(result.stdout, /--interactive/);
    assert.match(result.stdout, /interactive input/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("run without a request keeps Agency guidance interactive", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "agency.cmd" : "agency"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho ARGS:%*\r\n"
        : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const result = run(
      ["run", repository, "--environment", "development"],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      }
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /--interactive/);
    assert.doesNotMatch(result.stdout, /--session-id/);
    assert.doesNotMatch(result.stdout, /--no-ask-user/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("run without a request keeps Copilot environment guidance interactive", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "copilot.cmd" : "copilot"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho ARGS:%*\r\nmore\r\n"
        : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\ncat\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const result = run(
      [
        "run",
        repository,
        "--runtime",
        "copilot",
        "--environment",
        "development"
      ],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      },
      "inherited-standard-input\n"
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /--interactive/);
    assert.match(
      result.stdout,
      /Use development as the user-selected validation environment/
    );
    assert.doesNotMatch(result.stdout, /--session-id/);
    assert.doesNotMatch(result.stdout, /--no-ask-user/);
    assert.doesNotMatch(result.stdout, /--autopilot/);
    assert.match(result.stdout, /inherited-standard-input/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("runtime selection rejects unsupported values", () => {
  const result = run(
    ["run", "--runtime", "unknown", "--", "validate"],
    process.cwd()
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime must be one of: agency, copilot/);
});

test("run rejects an environment outside the repository profile", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const result = run(
      ["run", repository, "--environment", "production", "--", "validate"],
      repository
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /non-production environment/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
