import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import {
  parseNaturalChatCommand,
  runChat
} from "../dashboard/chat.js";
import {
  buildAgencyInvocation,
  buildCopilotInvocation,
  buildJobPrompt,
  createCacheContext,
  createDashboardServer,
  createProcessCompletion,
  FIXLAB_STAGES,
  inspectRepository,
  linkedDependencyDirectories,
  MAX_JOB_ACTIVITY_ENTRIES,
  MAX_CACHE_BYTES,
  MAX_CACHE_ENTRIES,
  MAX_JOB_LOG_ENTRIES,
  openLocalUrl,
  validateCopilotModel
} from "../dashboard/server.js";
import { createExecutorLease } from "../dashboard/executor-lease.js";
import { runValidationGate } from "../bin/validation-gate-client.js";

const packageRoot = new URL("..", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1"
);

test("linked node_modules directories are granted only inside trusted dependency roots", () => {
  const base = mkdtempSync(join(tmpdir(), "fixlab-linked-"));
  try {
    const repository = join(base, "repo");
    const trusted = join(base, "trusted");
    const external = join(trusted, "web", "node_modules");
    const untrusted = join(base, "untrusted", "node_modules");
    mkdirSync(join(repository, "apps", "web"), { recursive: true });
    mkdirSync(join(repository, "tools"), { recursive: true });
    mkdirSync(external, { recursive: true });
    mkdirSync(untrusted, { recursive: true });
    symlinkSync(
      external,
      join(repository, "apps", "web", "node_modules"),
      "junction"
    );
    symlinkSync(untrusted, join(repository, "tools", "node_modules"), "junction");

    const writeProfile = (trustedDependencyRoots) => {
      const directory = join(repository, ".github", "fixlab");
      mkdirSync(directory, { recursive: true });
      const profile = validProfile({ trustedDependencyRoots });
      profile.browserAutomation.workingDirectory = "apps/web";
      profile.applications.frontend.workingDirectory = "apps/web";
      profile.applications.tools = { workingDirectory: "tools" };
      writeFileSync(
        join(directory, "repository-profile.json"),
        JSON.stringify(profile)
      );
    };

    writeProfile(undefined);
    assert.deepEqual(linkedDependencyDirectories(repository), []);
    assert.deepEqual(linkedDependencyDirectories(repository, { discover: true }), [
      realpathSync(external),
      realpathSync(untrusted)
    ]);
    assert.deepEqual(linkedDependencyDirectories(repository), []);

    writeProfile([parse(base).root]);
    assert.deepEqual(linkedDependencyDirectories(repository), []);

    writeProfile([trusted]);
    const directories = linkedDependencyDirectories(repository);
    assert.deepEqual(directories, [realpathSync(external)]);

    const invocation = buildCopilotInvocation({
      packageRoot: "C:\\FixLab",
      prompt: "x",
      sessionId: "11111111-1111-4111-8111-111111111111",
      additionalDirs: directories
    });
    const index = invocation.args.indexOf("--add-dir");
    assert.equal(invocation.args[index + 1], realpathSync(external));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Copilot models are validated and retained in fresh and resumed invocations", () => {
  assert.equal(validateCopilotModel(" HydraFusion "), "hydrafusion");
  assert.equal(validateCopilotModel("", "agency"), "");
  for (const model of [1, true, ["hydrafusion"], {}]) {
    assert.throws(() => validateCopilotModel(model), /model must be a string/);
  }
  assert.throws(() => validateCopilotModel("hydrafusion", "agency"), /copilot runtime/);
  for (const model of ["hydrafusion&whoami", "--model", "x".repeat(129)]) {
    assert.throws(() => validateCopilotModel(model), /model must be/);
  }
  for (const resume of [false, true]) {
    for (const model of ["", "hydrafusion", "claude-sonnet-4.5"]) {
      const invocation = buildCopilotInvocation({
        packageRoot: "C:\\FixLab",
        prompt: "Validate the selected model.",
        sessionId: "11111111-1111-4111-8111-111111111111",
        model,
        resume
      });
      assert.equal(invocation.args.includes("--experimental"), model === "hydrafusion");
      assert.equal(invocation.args.includes("--model"), Boolean(model));
      if (model) {
        assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], model);
      }
      assert.equal(invocation.input, "Validate the selected model.");
    }
  }
});

test("Agency executor keeps long prompts out of process arguments", () => {
  const prompt = `Fix this batch:\n${"x".repeat(40000)}`;
  const invocation = buildAgencyInvocation({
    packageRoot: "C:\\FixLab",
    prompt,
    sessionId: "11111111-1111-4111-8111-111111111111"
  });

  assert.equal(invocation.input, prompt);
  assert.equal(invocation.args.includes(prompt), false);
  assert.equal(invocation.args.includes("--interactive"), false);
  assert.deepEqual(invocation.args.slice(0, 5), [
    "copilot",
    "--plugin-dir",
    "C:\\FixLab",
    "--agent",
    "fixlab:fixlab"
  ]);
  assert.deepEqual(invocation.args.slice(-2), [
    "--session-id",
    "11111111-1111-4111-8111-111111111111"
  ]);

  const resumed = buildAgencyInvocation({
    packageRoot: "C:\\FixLab",
    prompt,
    sessionId: "11111111-1111-4111-8111-111111111111",
    resume: true
  });
  assert.equal(resumed.args.includes("--session-id"), false);
  assert.equal(
    resumed.args.at(-1),
    "--resume=11111111-1111-4111-8111-111111111111"
  );
});

test("local browser opener accepts only credential-free loopback URLs", async () => {
  const launches = [];
  const child = new EventEmitter();
  child.unref = () => {};
  const launched = openLocalUrl("http://127.0.0.1:3000/app", {
    platform: "win32",
    spawnImpl(command, args, options) {
      launches.push({ command, args, options });
      return child;
    }
  });
  child.emit("spawn");
  await launched;
  assert.deepEqual(launches, [
    {
      command: "explorer.exe",
      args: ["http://127.0.0.1:3000/app"],
      options: {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }
    }
  ]);
  assert.throws(
    () =>
      openLocalUrl("http://user:password@localhost:3000", {
        platform: "win32",
        spawnImpl() {
          throw new Error("should not launch");
        }
      }),
    /credential-free HTTP\(S\) on loopback/
  );
  assert.throws(
    () =>
      openLocalUrl("https://example.com", {
        platform: "win32",
        spawnImpl() {
          throw new Error("should not launch");
        }
      }),
    /credential-free HTTP\(S\) on loopback/
  );

  const failedChild = new EventEmitter();
  failedChild.unref = () => {};
  const failedLaunch = openLocalUrl("http://localhost:3000", {
    platform: "linux",
    spawnImpl() {
      return failedChild;
    }
  });
  failedChild.emit("error", new Error("xdg-open is missing"));
  await assert.rejects(failedLaunch, /xdg-open is missing/);
});

test("executor completion settles after process exit when inherited pipes remain open", async () => {
  const child = new EventEmitter();
  const output = [];
  const completion = createProcessCompletion(
    child,
    (stream, text) => output.push({ stream, text }),
    5
  );

  child.emit("exit", 0, null);

  assert.deepEqual(await completion, { code: 0, signal: null });
  assert.deepEqual(output, []);
});

test("direct Copilot executor preserves stdin sessions and resume", () => {
  const prompt = `Validate this batch:\n${"x".repeat(40000)}`;
  const invocation = buildCopilotInvocation({
    packageRoot: "C:\\FixLab",
    prompt,
    sessionId: "22222222-2222-4222-8222-222222222222"
  });

  assert.equal(invocation.input, prompt);
  assert.equal(invocation.args.includes(prompt), false);
  assert.deepEqual(invocation.args.slice(0, 4), [
    "--plugin-dir",
    "C:\\FixLab",
    "--agent",
    "fixlab:fixlab"
  ]);
  assert.equal(invocation.args.includes("--autopilot"), true);
  assert.deepEqual(invocation.args.slice(-2), [
    "--session-id",
    "22222222-2222-4222-8222-222222222222"
  ]);

  const resumed = buildCopilotInvocation({
    packageRoot: "C:\\FixLab",
    prompt,
    sessionId: "22222222-2222-4222-8222-222222222222",
    resume: true
  });
  assert.equal(resumed.args.includes("--session-id"), false);
  assert.equal(
    resumed.args.at(-1),
    "--resume=22222222-2222-4222-8222-222222222222"
  );
});

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-dashboard-"));
  const profileDirectory = join(repository, ".github", "fixlab");
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(
    join(profileDirectory, "repository-profile.json"),
    JSON.stringify(validProfile())
  );
  return repository;
}

function validProfile(overrides = {}) {
  return {
    name: "Dashboard test repository",
    applications: {
      frontend: {
        workingDirectory: ".",
        command: "npm start",
        port: 3000,
        healthUrl: "http://127.0.0.1:3000"
      }
    },
    browserAutomation: {
      workingDirectory: ".",
      package: "@playwright/test",
      browser: "chromium",
      testCommand: "npm run test:e2e",
      testSynthesis: {
        enabled: true,
        defaultDataSource: "synthetic-intercepted",
        mutationMode: "intercepted",
        requireScenarioEvidence: true
      },
      authentication: {
        required: false,
        command: "",
        statusPaths: []
      },
      dataSafety: {
        policy: "Use mocked data and intercept mutations.",
        productionAllowed: false
      }
    },
    environments: ["local", "dev", "sit"],
    pullRequests: {
      defaultTargetBranch: "develop",
      requireConfirmation: true,
      branchNaming: {
        userId: "fixlab-test",
        prefixTemplate: "users/{userId}"
      }
    },
    ...overrides
  };
}

test("dashboard readiness blocks a missing explicit Playwright configuration", () => {
  const repository = createRepository();
  try {
    const profile = validProfile();
    profile.browserAutomation.testCommand = "playwright test --config=playwright.local.ts";
    writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
    assert.equal(inspectRepository(repository).profileReady, false);
    assert.match(inspectRepository(repository).error, /configuration is missing.*worktreeSetup.files/);
    writeFileSync(join(repository, "playwright.local.ts"), "export default {};");
    assert.equal(inspectRepository(repository).profileReady, true);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard readiness blocks an incomplete live-test profile", () => {
  const repository = createRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );

  try {
    const profile = validProfile();
    delete profile.browserAutomation.testCommand;
    writeFileSync(profilePath, JSON.stringify(profile));

    const readiness = inspectRepository(repository);

    assert.equal(readiness.repositoryReady, true);
    assert.equal(readiness.profileReady, false);
    assert.match(readiness.error, /live-test profile is incomplete/);
    assert.match(readiness.error, /browserAutomation\.testCommand/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard readiness rejects credentials in a loopback health URL", () => {
  const repository = createRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  profile.applications.frontend.healthUrl =
    "http://user:password@localhost:3000";
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));

  const readiness = inspectRepository(repository);
  assert.equal(readiness.profileReady, false);
  assert.match(readiness.error, /credential-free loopback URL required/);
  rmSync(repository, { recursive: true, force: true });
});

test("dashboard readiness validates configured test synthesis", () => {
  const repository = createRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );

  try {
    const profile = validProfile();
    profile.browserAutomation.testSynthesis.mutationMode = "external-write";
    writeFileSync(profilePath, JSON.stringify(profile));

    const readiness = inspectRepository(repository);

    assert.equal(readiness.profileReady, false);
    assert.match(
      readiness.error,
      /browserAutomation\.testSynthesis\.mutationMode/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard readiness requires an explicit test synthesis contract", () => {
  const repository = createRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );

  try {
    const profile = validProfile();
    delete profile.browserAutomation.testSynthesis;
    writeFileSync(profilePath, JSON.stringify(profile));

    const readiness = inspectRepository(repository);

    assert.equal(readiness.profileReady, false);
    assert.match(readiness.error, /browserAutomation\.testSynthesis/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard readiness validates the agent idle timeout", () => {
  const repository = createRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );

  try {
    const profile = validProfile({
      validation: { agentIdleTimeoutMinutes: 0 }
    });
    writeFileSync(profilePath, JSON.stringify(profile));

    const readiness = inspectRepository(repository);

    assert.equal(readiness.profileReady, false);
    assert.match(
      readiness.error,
      /validation\.agentIdleTimeoutMinutes/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

function git(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("shared dashboard jobs refresh develop, reuse one checkout and reacquire held branches after restart", async () => {
  const source = createGitRepository();
  const repository = mkdtempSync(join(tmpdir(), "fixlab-shared-dashboard-"));
  const executions = [];
  const profile = validProfile({ worktreeSetup: { mode: "shared", baseBranch: "develop" } });
  writeFileSync(join(source, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  git(source, ["branch", "-m", "develop"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "configure shared runner"]);
  git(source, ["clone", "--quiet", source, repository]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.test"]);
  const executor = (input) => {
    let finish;
    const completion = new Promise((resolve) => { finish = resolve; });
    executions.push({ input, finish, branch: git(repository, ["branch", "--show-current"]) });
    return { completion, terminate() { finish({ code: null, signal: "SIGTERM" }); } };
  };
  let current = await startDashboard(repository, executor);
  const post = (path, body) => jsonRequest(current.url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const waitUntil = async (condition) => {
    for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(condition());
  };
  const block = (execution) => {
    execution.input.onOutput("stdout", "FIXLAB_STAGE|intake|blocked|Retain this job.\n");
    execution.finish({ code: 0 });
  };
  try {
    const first = await post("/api/jobs", { request: "First shared fix.", mode: "fix-and-validate" });
    assert.equal(first.response.status, 202);
    const firstId = first.body.job.id;
    const firstBranch = first.body.job.sharedWorkspace.branch;
    assert.equal(executions[0].branch, firstBranch);
    assert.match(executions[0].input.prompt, /Shared worktree contract/);
    writeFileSync(join(repository, "first-fix.txt"), "first fix");
    git(repository, ["add", "first-fix.txt"]);
    git(repository, ["commit", "--quiet", "-m", "first fix"]);
    const firstCommit = git(repository, ["rev-parse", "HEAD"]);
    block(executions[0]);
    await waitUntil(() => !existsSync(join(repository, ".git", "fixlab", "executor-lease")));
    await post("/api/jobs/hold", { jobId: firstId });
    writeFileSync(join(source, "upstream.txt"), "fresh develop");
    git(source, ["add", "upstream.txt"]);
    git(source, ["commit", "--quiet", "-m", "advance develop"]);
    const second = await post("/api/jobs", { request: "Second independent fix.", mode: "fix-and-validate" });
    assert.equal(second.response.status, 202);
    assert.notEqual(second.body.job.sharedWorkspace.branch, firstBranch);
    assert.equal(second.body.job.sharedWorkspace.baseCommit, git(source, ["rev-parse", "HEAD"]));
    assert.equal(executions[1].input.repository, repository);
    assert.equal(existsSync(join(repository, "first-fix.txt")), false);
    assert.equal(readFileSync(join(repository, "upstream.txt"), "utf8"), "fresh develop");
    block(executions[1]);
    await waitUntil(() => !existsSync(join(repository, ".git", "fixlab", "executor-lease")));
    await post("/api/jobs/hold", { jobId: second.body.job.id });
    await current.dashboard.close();
    current = await startDashboard(repository, executor);
    const restored = await jsonRequest(current.url, "/api/status");
    assert.equal(restored.body.held.find((job) => job.id === firstId).sharedWorkspace.branch, firstBranch);
    const resumed = await post("/api/jobs/resume", { jobId: firstId });
    assert.equal(resumed.response.status, 202);
    assert.equal(executions[2].input.sessionId, firstId);
    assert.equal(executions[2].input.resume, true);
    assert.equal(git(repository, ["rev-parse", "HEAD"]), firstCommit);
    assert.equal(existsSync(join(repository, "upstream.txt")), false);
    assert.equal(readFileSync(join(repository, "first-fix.txt"), "utf8"), "first fix");
    block(executions[2]);
    await waitUntil(() => !existsSync(join(repository, ".git", "fixlab", "executor-lease")));
    const restarted = await post("/api/jobs/restart", { jobId: firstId });
    assert.equal(restarted.response.status, 202);
    assert.notEqual(restarted.body.job.id, firstId);
    assert.notEqual(restarted.body.job.sharedWorkspace.branch, firstBranch);
    assert.equal(restarted.body.job.sharedWorkspace.baseCommit, git(source, ["rev-parse", "HEAD"]));
    assert.equal(executions[3].input.resume, false);
    assert.equal(existsSync(join(repository, "first-fix.txt")), false);
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("shared dashboard rejects dirty checkout acquisition without launching or retaining an executor lease", async () => {
  const repository = createGitRepository();
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(validProfile({
    worktreeSetup: { mode: "shared", baseBranch: "develop" }
  })));
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "shared policy"]);
  writeFileSync(join(repository, "uncommitted.txt"), "preserve");
  const { dashboard, url } = await startDashboard(repository, () => { throw new Error("Must not launch."); });
  try {
    const result = await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Preserve dirty state.", mode: "fix-and-validate" })
    });
    assert.equal(result.response.status, 202);
    assert.equal(result.body.job.status, "failed");
    assert.match(result.body.job.error, /uncommitted or untracked/);
    assert.equal(readFileSync(join(repository, "uncommitted.txt"), "utf8"), "preserve");
    const reservation = createExecutorLease(repository, "test").acquire("test");
    reservation.release();
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

function createGitRepository() {
  const repository = createRepository();
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "fixlab@example.invalid"]);
  git(repository, ["config", "user.name", "FixLab Test"]);
  writeFileSync(join(repository, "tracked.txt"), "initial\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "Initial state"]);
  return repository;
}

async function startDashboard(
  repository,
  executor,
  workItemLoader,
  options = {}
) {
  const effectiveExecutor =
    options.autoTestEvidence === false
      ? executor
      : (input) => {
          let reported = false;
          return executor({
            ...input,
            onOutput(stream, text) {
              if (/FIXLAB_TEST\|/u.test(text)) {
                reported = true;
              }
              if (
                !reported &&
                /FIXLAB_STAGE\|live-test\|passed\|/u.test(text)
              ) {
                input.onOutput(
                  "stdout",
                  "FIXLAB_TEST|synthetic-intercepted|intercepted|Test harness scenario evidence.\n"
                );
                reported = true;
              }
              input.onOutput(stream, text);
            }
          });
        };
  const trackedExecutor = (input) => {
    const handle = effectiveExecutor(input);
    if (options.deferTermination) {
      return handle;
    }
    let stopped;
    const termination = new Promise((resolve) => { stopped = resolve; });
    return {
      ...handle,
      completion: Promise.race([handle.completion, termination]),
      terminate() {
        handle.terminate?.();
        stopped({ code: null, signal: "SIGTERM" });
      }
    };
  };
  const dashboard = createDashboardServer({
    repository,
    packageRoot,
    executor: trackedExecutor,
    browserOpener() {},
    ...Object.fromEntries(
      Object.entries(options).filter(([name]) => name !== "autoTestEvidence")
    ),
    ...(workItemLoader ? { workItemLoader } : {})
  });
  const address = await dashboard.listen({ port: await availablePort() });
  return { dashboard, url: address.url };
}

async function jsonRequest(url, path, options) {
  const response = await fetch(`${url}${path}`, options);
  return { response, body: await response.json() };
}

test("Copilot dashboard retains model defaults, overrides and queue state through recovery", async () => {
  const repository = createGitRepository();
  const calls = [];
  let current = await startDashboard(repository, (input) => {
    calls.push(input);
    input.onOutput("stdout", "FIXLAB_STAGE|intake|blocked|Waiting for a prerequisite.\n");
    return { completion: Promise.resolve({ code: 1 }), terminate() {} };
  }, undefined, { runtime: "copilot", model: "hydrafusion" });
  const post = (path, body) => jsonRequest(current.url, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    const status = await jsonRequest(current.url, "/api/status");
    assert.deepEqual(status.body.runtime, {
      name: "copilot",
      defaultModel: "hydrafusion",
      supportsModelSelection: true
    });
    const started = await post("/api/jobs", {
      request: "Retain the configured model.",
      mode: "validate-only"
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.job.model, "hydrafusion");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resumed = await post("/api/job/input", {
      action: "continue",
      details: "The prerequisite is ready."
    });
    assert.equal(resumed.response.status, 202);
    assert.equal(calls[1].model, "hydrafusion");
    assert.equal(calls[1].resume, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queued = await post("/api/jobs", {
      request: "Use an explicit stable model.",
      mode: "validate-only",
      model: "claude-sonnet-4.5"
    });
    assert.equal(queued.response.status, 202);
    assert.equal(queued.body.queue[0].model, "claude-sonnet-4.5");
    const unconfigured = await post("/api/jobs", {
      request: "Use Copilot's own default.",
      mode: "validate-only",
      model: ""
    });
    assert.equal(unconfigured.response.status, 202);
    assert.equal(unconfigured.body.queue[1].model, "");
    await current.dashboard.close();
    current = await startDashboard(repository, (input) => {
      calls.push(input);
      return { completion: new Promise(() => {}), terminate() {} };
    }, undefined, { runtime: "copilot", model: "another-model" });
    const recovered = await jsonRequest(current.url, "/api/status");
    assert.equal(recovered.body.job.model, "hydrafusion");
    assert.equal(recovered.body.history.find((job) => job.id === queued.body.queue[0].id).model, "claude-sonnet-4.5");
    assert.equal(recovered.body.history.find((job) => job.id === unconfigured.body.queue[1].id).model, "");
    await post("/api/job/input", { action: "continue", details: "Resume the saved model." });
    assert.equal(calls.at(-1).model, "hydrafusion");
    await current.dashboard.close();
    current = await startDashboard(repository, () => {
      throw new Error("Cross-runtime recovery must not start an executor.");
    });
    const incompatible = await jsonRequest(current.url, "/api/status");
    assert.equal(incompatible.body.job, null);
    assert.ok(incompatible.body.history.some((job) => job.runtime === "copilot"));
    const rejected = await post("/api/job/input", { action: "continue", details: "Wrong runtime." });
    assert.equal(rejected.response.status, 404);
    assert.match(rejected.body.error, /no FixLab job/);
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("Agency dashboard rejects Copilot model overrides before starting an executor", async () => {
  const repository = createRepository();
  const { dashboard, url } = await startDashboard(repository, () => {
    throw new Error("Rejected jobs must not execute.");
  });
  try {
    const rejected = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Do not execute.", mode: "validate-only", model: "hydrafusion" })
    });
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.body.error, /copilot runtime/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const trailingNewline of [false, true]) {
  test(`adjacent markers survive chunk boundaries and ${trailingNewline ? "complete lines" : "final partial output"}`, async () => {
    const repository = createRepository();
    const { dashboard, url } = await startDashboard(repository, ({ onOutput }) => {
      const text = FIXLAB_STAGES.map((stage) => `FIXLAB_STAGE|${stage}|skipped|Read-only validation.`).join("") +
        "FIXLAB_ACTIVITY|intake|Recorded the required evidence." +
        (trailingNewline ? "\n" : "");
      const boundary = text.indexOf("FIXLAB_STAGE", 1) + 7;
      onOutput("stdout", text.slice(0, boundary));
      onOutput("stdout", text.slice(boundary));
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    });
    try {
      const started = await jsonRequest(url, "/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Validate marker boundaries.", mode: "validate-only" })
      });
      assert.equal(started.response.status, 202);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const completed = await jsonRequest(url, "/api/job");
      assert.equal(completed.body.job.status, "passed");
      for (const stage of FIXLAB_STAGES) {
        assert.equal(completed.body.job.stages[stage].status, "skipped");
      }
      assert.equal(completed.body.job.activity.length, 1);
    } finally {
      await dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("dashboard reports readiness and serves only known static assets", async () => {
  const repository = createRepository();
  const { dashboard, url } = await startDashboard(repository, () => {
    throw new Error("executor should not run");
  });

  try {
    const status = await jsonRequest(url, "/api/status");
    assert.equal(status.response.status, 200);
    assert.equal(status.body.readiness.repositoryReady, true);
    assert.equal(status.body.readiness.profileReady, true);
    assert.deepEqual(status.body.readiness.environments, [
      "local",
      "dev",
      "sit"
    ]);
    assert.equal(
      status.body.readiness.profileName,
      "Dashboard test repository"
    );

    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /FixLab Dashboard/);
    assert.match(pageText, /Bug or required enhancement/);
    assert.match(pageText, /Enter manually/);
    assert.match(pageText, /Load from Azure DevOps/);
    assert.match(pageText, /Load bugs/);
    assert.match(pageText, /Continue this job/);
    assert.match(pageText, /Screenshots \(optional\)/);
    assert.match(pageText, /Repository-defined validation context is loaded automatically/);
    assert.match(pageText, /proceeds autonomously/);

    const traversal = await fetch(`${url}/..%2fpackage.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard rejects a job when preflight finds a missing tool", async () => {
  const repository = createRepository();
  const { dashboard, url } = await startDashboard(
    repository,
    () => {
      throw new Error("executor should not run");
    },
    undefined,
    {
      preflight: () => [{ check: "npm on PATH", detail: "npm was not found" }]
    }
  );

  try {
    const result = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Fix the defect.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    assert.equal(result.response.status, 400);
    assert.match(result.body.error, /Preflight failed: npm on PATH/);
    assert.equal(result.body.preflight.length, 1);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("loads Azure DevOps intake and passes local screenshots without caching them", async () => {
  const repository = createGitRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  writeFileSync(
    profilePath,
    JSON.stringify(validProfile({
      name: "ADO intake repository",
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    }))
  );
  git(repository, [
    "add",
    join(".github", "fixlab", "repository-profile.json")
  ]);
  git(repository, ["commit", "--quiet", "-m", "Add ADO profile"]);

  const workItem = {
    id: 71,
    title: "Loaded bug",
    description: "Loaded description",
    reproduction: "Loaded reproduction",
    acceptanceCriteria: "Loaded acceptance",
    state: "Active",
    workItemType: "Bug",
    screenshots: [
      {
        name: "71-loaded.png",
        mimeType: "image/png",
        base64: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
        ]).toString("base64")
      }
    ],
    imagesWarning: "",
    webUrl:
      "https://dev.azure.com/profile-org/Profile%20Project/_workitems/edit/71"
  };
  let loaderInput;
  let receivedPrompt;
  let receivedArtifactDirectories;
  const executor = ({ prompt, artifactDirectories, onOutput }) => {
    receivedPrompt = prompt;
    receivedArtifactDirectories = artifactDirectories;
    onOutput(
      "stdout",
      "FIXLAB_BUG|71|external|upstream-system|The upstream system owns the rejected request; no repository change is required.\n"
    );
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} complete\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const workItemLoader = async (input) => {
    loaderInput = input;
    return workItem;
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    workItemLoader
  );
  let screenshotPath;

  try {
    const loaded = await jsonRequest(url, "/api/azure-devops/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItem: "71" })
    });
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.body.workItem.title, "Loaded bug");
    assert.equal(loaded.body.workItem.screenshots.length, 1);
    assert.equal(loaded.body.workItem.screenshots[0].name, "71-loaded.png");
    assert.equal(
      loaderInput.profile.azureDevOps.organization,
      "profile-org"
    );

    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]);
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Loaded bug and user notes.",
        requestType: "bug-fix",
        mode: "fix-and-validate",
        intakeSource: "azure-devops",
        workItem,
        screenshots: [
          {
            name: "screen.png",
            mimeType: "image/png",
            base64: png.toString("base64")
          }
        ]
      })
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.job.intakeSource, "azure-devops");
    assert.equal(started.body.job.workItem.id, 71);
    assert.deepEqual(started.body.job.screenshots, [
      { name: "screen.png", mimeType: "image/png", bytes: 8 }
    ]);
    assert.equal("path" in started.body.job.screenshots[0], false);

    const pathLine = receivedPrompt
      .split(/\r?\n/)
      .find((line) => line.startsWith("- ") && line.endsWith(".png"));
    screenshotPath = pathLine?.slice(2);
    assert.ok(screenshotPath);
    assert.equal(existsSync(screenshotPath), true);
    assert.deepEqual(receivedArtifactDirectories, [dirname(screenshotPath)]);
    assert.match(receivedPrompt, /Loaded Azure DevOps selection/);
    assert.match(
      receivedPrompt,
      /Do not search for or download additional Azure DevOps attachments/
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const cacheContext = createCacheContext(repository);
    const cacheContent = readFileSync(cacheContext.cachePath, "utf8");
    assert.doesNotMatch(cacheContent, /screen\.png/);
    assert.doesNotMatch(cacheContent, /dashboard-artifacts/);
    assert.doesNotMatch(cacheContent, /Loaded description/);
  } finally {
    await dashboard.close();
    if (screenshotPath) {
      assert.equal(existsSync(screenshotPath), false);
    }
    rmSync(repository, { recursive: true, force: true });
  }
});

test("loads and starts one Azure DevOps multi-bug batch", async () => {
  const repository = createGitRepository();
  git(repository, [
    "remote",
    "add",
    "origin",
    "https://dev.azure.com/example/project/_git/dashboard-test"
  ]);
  let loadedProfile;
  const workItemLoader = async () => {
    throw new Error("single-item loader should not run");
  };
  workItemLoader.loadMany = async ({ workItems, profile }) => {
    loadedProfile = profile;
    return workItems.map((value) => ({
      id: Number(value),
      title: `Loaded bug ${value}`,
      description: "",
      reproduction: "",
      acceptanceCriteria: "",
      state: "Active",
      workItemType: "Bug",
      webUrl: `https://dev.azure.com/example/project/_workitems/edit/${value}`
    }));
  };
  let receivedPrompt = "";
  const openedLocalhostUrls = [];
  let resolveBrowserOpen;
  const executor = ({ onOutput, prompt }) => {
    receivedPrompt = prompt;
    for (const id of ["101", "202"]) {
      onOutput(
        "stdout",
        `FIXLAB_BUG|${id}|no-change|application|No repository change is required.\n`
      );
    }
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} complete\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    workItemLoader,
    {
      browserOpener(localhostUrl) {
        openedLocalhostUrls.push(localhostUrl);
        return new Promise((resolveOpen) => {
          resolveBrowserOpen = resolveOpen;
        });
      }
    }
  );

  try {
    const loaded = await jsonRequest(url, "/api/azure-devops/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItems: ["101", "202"] })
    });
    assert.equal(loaded.response.status, 200, JSON.stringify(loaded.body));
    assert.equal(loaded.body.workItem, null);
    assert.deepEqual(
      loaded.body.workItems.map((item) => item.id),
      [101, 202]
    );
    assert.deepEqual(loadedProfile.azureDevOps, {
      organization: "example",
      project: "project"
    });
    const onboarding = await jsonRequest(url, "/api/onboarding");
    assert.deepEqual(onboarding.body.azureDevOps, {
      organization: "example",
      project: "project"
    });
    const savedOnboarding = await jsonRequest(
      url,
      "/api/onboarding/azure-devops",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: "saved-org",
          project: "saved-project"
        })
      }
    );
    assert.equal(savedOnboarding.response.status, 200);
    const savedProfile = JSON.parse(
      readFileSync(
        join(
          repository,
          ".github",
          "fixlab",
          "repository-profile.json"
        ),
        "utf8"
      )
    );
    assert.deepEqual(savedProfile.azureDevOps, {
      organization: "saved-org",
      project: "saved-project"
    });

    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request:
          "Azure DevOps Bug 101: First bug\n\nAzure DevOps Bug 202: Second bug",
        mode: "fix-and-validate",
        pullRequestStrategy: "per-bug",
        runAllUiScenarios: true,
        manualLocalhostTest: true,
        intakeSource: "azure-devops",
        workItems: loaded.body.workItems
      })
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.job.workItems.length, 2);
    assert.equal(started.body.job.pullRequestStrategy, "per-bug");
    assert.equal(started.body.job.runAllUiScenarios, true);
    assert.equal(started.body.job.manualLocalhostTest, true);
    assert.equal(
      started.body.job.manualLocalhostUrl,
      "http://127.0.0.1:3000"
    );
    assert.deepEqual(openedLocalhostUrls, ["http://127.0.0.1:3000"]);
    assert.equal(started.body.job.manualLocalhostOpenedAt, null);
    resolveBrowserOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const opened = await jsonRequest(url, "/api/job");
    assert.ok(opened.body.job.manualLocalhostOpenedAt);
    assert.match(
      opened.body.job.logs.at(-1).message,
      /Opened the React localhost URL/
    );
    assert.equal("description" in started.body.job.workItems[0], false);
    assert.match(receivedPrompt, /Pull request strategy: per-bug/);
    assert.match(receivedPrompt, /isolated delivery unit/);
    assert.match(receivedPrompt, /every repository-defined Playwright\/UI scenario/);
    assert.match(
      receivedPrompt,
      /Open React localhost for manual validation: yes/
    );
    assert.match(
      receivedPrompt,
      /Manual React localhost validation is enabled independently of Playwright/
    );
    assert.match(receivedPrompt, /manual confirmation is pending/);
    assert.match(receivedPrompt, /users\/fixlab-test/);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.status, "passed");
    assert.deepEqual(
      completed.body.job.bugs.map((bug) => bug.id),
      ["101", "202"]
    );
    assert.equal(
      completed.body.job.pullRequestReadiness.status,
      "blocked"
    );
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard records synchronous browser launcher failures", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} complete\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    undefined,
    {
      browserOpener() {
        throw new Error("browser launcher is unavailable");
      }
    }
  );

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Open React localhost for manual validation.",
        requestType: "small-enhancement",
        mode: "fix-and-validate",
        manualLocalhostTest: true
      })
    });
    assert.equal(started.response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.manualLocalhostOpenedAt, null);
    assert.ok(
      completed.body.job.logs.some((entry) =>
        /browser launcher is unavailable/.test(entry.message)
      )
    );
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard finalizes a pending manual marker as blocked", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    onOutput("stdout", "FIXLAB_MANUAL|localhost|pending\n");
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} complete\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Require manual localhost confirmation.",
        requestType: "small-enhancement",
        mode: "fix-and-validate",
        manualLocalhostTest: true
      })
    });
    assert.equal(started.response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const blocked = await jsonRequest(url, "/api/job");
    assert.equal(blocked.body.job.status, "blocked");
    assert.equal(blocked.body.job.manualLocalhostPending, true);
    assert.equal(blocked.body.job.stages["live-test"].status, "blocked");
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard keeps an explicit manual failure authoritative", async () => {
  const repository = createRepository();
  let callCount = 0;
  const executor = ({ onOutput }) => {
    callCount += 1;
    if (callCount === 1) {
      onOutput("stdout", "FIXLAB_MANUAL|localhost|pending\n");
      for (const stage of FIXLAB_STAGES) {
        const status = stage === "live-test" ? "blocked" : "passed";
        onOutput(
          "stdout",
          `FIXLAB_STAGE|${stage}|${status}|${stage} initial\n`
        );
      }
    } else {
      for (const stage of FIXLAB_STAGES) {
        onOutput(
          "stdout",
          `FIXLAB_STAGE|${stage}|passed|${stage} resumed\n`
        );
      }
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Respect a failed manual localhost result.",
        requestType: "small-enhancement",
        mode: "fix-and-validate",
        manualLocalhostTest: true
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resumed = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "manual-fail" })
    });
    assert.equal(resumed.response.status, 202, JSON.stringify(resumed.body));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failed = await jsonRequest(url, "/api/job");
    assert.equal(failed.body.job.status, "failed");
    assert.equal(failed.body.job.manualLocalhostResult, "failed");
    assert.equal(failed.body.job.stages["live-test"].status, "failed");
    assert.match(failed.body.job.error, /Manual React localhost validation failed/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard parses complete stage markers and passes a job", async () => {
  const repository = createRepository();
  let receivedPrompt;
  const executor = ({ prompt, onOutput }) => {
    receivedPrompt = prompt;
    onOutput(
      "stdout",
      "FIXLAB_BUG|17037209|external|upstream-system|The upstream system rejected parent validation and the application surfaced the returned error.\n"
    );
    onOutput(
      "stdout",
      "FIXLAB_BUG|17032997|fixed|application|Generation status displays the generated object type.\n"
    );
    onOutput(
      "stdout",
      "FIXLAB_TEST|synthetic-intercepted|intercepted|Two rapid approvals produce one approval request and one submission.\n"
    );
    for (const stage of FIXLAB_STAGES) {
      onOutput(
        "stdout",
        `FIXLAB_STAGE|${stage}|passed|${stage} completed\n`
      );
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request:
          "Azure DevOps Bug 17037209: Remap failed\nURL: https://dev.azure.com/example/project/_workitems/edit/17037209\n\nAzure DevOps Bug 17032997: Generic generation status",
        mode: "fix-and-validate",
        targetEnvironment: "sit"
      })
    });
    assert.equal(started.response.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");
    assert.equal(result.body.job.status, "passed");
    assert.equal(result.body.job.error, null);
    assert.equal(result.body.job.requestType, "bug-fix");
    assert.equal(result.body.job.targetEnvironment, "sit");
    assert.deepEqual(result.body.job.testEvidence, {
      enabled: true,
      source: "synthetic-intercepted",
      mutationMode: "intercepted",
      requireScenarioEvidence: true,
      reported: true,
      scenario:
        "Two rapid approvals produce one approval request and one submission."
    });
    assert.deepEqual(result.body.job.bugs, [
      {
        id: "17037209",
        title: "Remap failed",
        url: "https://dev.azure.com/example/project/_workitems/edit/17037209",
        outcome: "external",
        owner: "upstream-system",
        summary:
          "The upstream system rejected parent validation and the application surfaced the returned error."
      },
      {
        id: "17032997",
        title: "Generic generation status",
        url: "",
        outcome: "fixed",
        owner: "application",
        summary: "Generation status displays the generated object type."
      }
    ]);
    assert.match(receivedPrompt, /Read \.github\/fixlab\/repository-profile\.json/i);
    assert.match(receivedPrompt, /smallest complete change/i);
    assert.match(receivedPrompt, /Make no code change/i);
    assert.match(receivedPrompt, /self-review the effective diff/i);
    assert.match(receivedPrompt, /tests, type-checks, and builds/i);
    assert.match(
      receivedPrompt,
      /Do not skip Playwright merely because an unrelated non-browser/
    );
    assert.match(
      receivedPrompt,
      /Use local-stack only for profile-defined application startup and health/
    );
    assert.match(
      receivedPrompt,
      /Do not mark local-stack failed because a separate test, type-check, lint, or production build/
    );
    assert.match(receivedPrompt, /applications defined by the repository profile/i);
    assert.match(receivedPrompt, /repository-defined live test/i);
    assert.match(receivedPrompt, /Test synthesis: enabled/);
    assert.match(receivedPrompt, /Selected validation environment: sit/);
    assert.match(receivedPrompt, /Use exactly that repository-approved environment/);
    assert.match(receivedPrompt, /Do not silently fall back to local/);
    assert.match(
      receivedPrompt,
      /Configured test data source: synthetic-intercepted/
    );
    assert.match(receivedPrompt, /FIXLAB_TEST\|source\|mutation-mode\|scenario/);
    assert.match(receivedPrompt, /intercept every mutating request/);
    assert.match(
      receivedPrompt,
      /save at least one non-sensitive screenshot/i
    );
    assert.match(
      receivedPrompt,
      /Treat a synthesized Playwright scenario as a transient validation artifact/
    );
    assert.match(
      receivedPrompt,
      /Do not add a newly generated authenticated test such as `\*\.auth\.spec\.ts`/
    );
    assert.match(
      receivedPrompt,
      /Remove its source file and any validation-only configuration edits before diff review/
    );
    assert.match(
      receivedPrompt,
      /do not broaden the pull request to repair unrelated or stale browser journeys/
    );
    assert.match(receivedPrompt, /Do not invent or hardcode environment choices/i);
    assert.match(
      receivedPrompt,
      /create or update a draft pull request before remaining independent validation completes/i
    );
    assert.match(
      receivedPrompt,
      /Start long-running independent validation commands in parallel/i
    );
    assert.match(
      receivedPrompt,
      /Keep the pull request draft and clearly marked validation-in-progress/i
    );
    assert.match(
      receivedPrompt,
      /Never mark it ready for review or report the pr stage passed until all required local gates pass/i
    );
    assert.match(receivedPrompt, /publish the authorized PR by marking it ready for review/);
    assert.match(receivedPrompt, /Do not wait for remote PR CI or build completion before publication/);
    assert.match(receivedPrompt, /Verify the PR is no longer draft before reporting the PR stage passed/);
    assert.match(receivedPrompt, /Report remote checks as pending, not passed, and leave merge policies intact/);
    assert.match(receivedPrompt, /az repos pr update --id <id> --draft false/);
    assert.match(receivedPrompt, /authentication, unsafe-data approval/i);
    assert.match(receivedPrompt, /git status and effective diff/i);
    assert.match(receivedPrompt, /task-relevant symbols and files/i);
    assert.match(receivedPrompt, /Reuse this job\/session context/i);
    assert.match(receivedPrompt, /Do not reread unchanged files/i);
    assert.match(receivedPrompt, /reinstall available dependencies/i);
    assert.match(receivedPrompt, /commit changes and repository-profile or instruction changes as invalidation boundaries/i);
    assert.match(receivedPrompt, /do not feed unbounded raw output back into prompts/i);
    assert.match(receivedPrompt, /fixlab exec --stage <stage>/i);
    assert.match(receivedPrompt, /never wrap `fixlab exec` in `cmd \/c`/u);
    assert.match(receivedPrompt, /Never reuse startup, health, authentication/i);
    assert.match(receivedPrompt, /FIXLAB_STAGE\|stage\|status\|message/);
    assert.match(receivedPrompt, /FIXLAB_BUG\|id\|outcome\|owner\|summary/);
    assert.match(receivedPrompt, /Never generate markers through shell/);
    assert.match(receivedPrompt, /required machine-readable output/);
    assert.match(receivedPrompt, /before the terminal pr stage/);
    assert.match(
      receivedPrompt,
      /Do not call task_complete or return the final response/
    );
    assert.match(receivedPrompt, /external with owner upstream-system/);
    assert.match(receivedPrompt, /Do not create an empty pull request/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard fails a passed live test without required scenario evidence", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} completed\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    null,
    { autoTestEvidence: false }
  );

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Require explicit browser scenario evidence.",
        mode: "validate-only"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await jsonRequest(url, "/api/job");
    assert.equal(result.body.job.status, "failed");
    assert.equal(result.body.job.stages["live-test"].status, "failed");
    assert.match(result.body.job.error, /required FIXLAB_TEST/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard accepts rendered text stage markers", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (const stage of FIXLAB_STAGES) {
      const status =
        stage === "live-test"
          ? "skipped"
          : stage === "pr"
            ? "blocked"
            : "passed";
      onOutput(
        "stdout",
        `FIXLAB_STAGE ${stage} ${status} - ${stage} rendered result\n`
      );
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Validate rendered stage marker compatibility.",
        mode: "validate-only"
      })
    });
    assert.equal(started.response.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");
    assert.equal(result.body.job.status, "blocked");
    assert.equal(result.body.job.error, null);
    assert.equal(result.body.job.stages.intake.status, "passed");
    assert.equal(result.body.job.stages["live-test"].status, "skipped");
    assert.equal(result.body.job.stages.pr.status, "blocked");
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("blocked job accepts user input and resumes the same Agency session", async () => {
  const repository = createRepository();
  const calls = [];
  const executor = ({ prompt, sessionId, resume, onOutput }) => {
    calls.push({ prompt, sessionId, resume });
    if (!resume) {
      for (const stage of FIXLAB_STAGES) {
        const status =
          stage === "live-test"
            ? "blocked"
            : stage === "pr"
              ? "skipped"
              : "passed";
        onOutput(
          "stdout",
          `FIXLAB_STAGE|${stage}|${status}|${stage} result\n`
        );
      }
    } else {
      for (const stage of FIXLAB_STAGES) {
        onOutput(
          "stdout",
          `FIXLAB_STAGE|${stage}|passed|${stage} resumed\n`
        );
      }
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Validate an authenticated browser workflow.",
        mode: "validate-only",
        manualLocalhostTest: true
      })
    });
    assert.equal(started.response.status, 202);
    assert.match(
      started.body.job.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const blocked = await jsonRequest(url, "/api/job");
    assert.equal(blocked.body.job.status, "blocked");
    assert.equal(blocked.body.job.canResume, true);
    assert.equal(blocked.body.job.stages["live-test"].status, "blocked");
    assert.equal(blocked.body.job.manualLocalhostPending, false);

    const invalidManualResult = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "manual-pass" })
    });
    assert.equal(invalidManualResult.response.status, 409);
    assert.match(
      invalidManualResult.body.error,
      /manual localhost confirmation is not pending/
    );

    const resumed = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "continue",
        details: "Authentication is complete. Continue the browser validation."
      })
    });
    assert.equal(resumed.response.status, 202, JSON.stringify(resumed.body));
    assert.equal(resumed.body.job.inputCount, 1);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.status, "passed");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].resume, false);
    assert.equal(calls[1].resume, true);
    assert.equal(calls[1].sessionId, calls[0].sessionId);
    assert.match(calls[1].prompt, /Authentication is complete/);
    assert.match(calls[1].prompt, /Resume the existing FixLab dashboard session/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("zero-progress failure retries as a fresh Copilot session", async () => {
  const repository = createRepository();
  const calls = [];
  const executor = ({ prompt, sessionId, resume, onOutput }) => {
    calls.push({ prompt, sessionId, resume });
    if (calls.length === 1) {
      return { completion: Promise.resolve({ code: 1 }), terminate() {} };
    }
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} retried\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Repair a launch-blocked defect.",
        mode: "fix-and-validate"
      })
    });
    assert.equal(started.response.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = await jsonRequest(url, "/api/job");
    assert.equal(failed.body.job.status, "failed");
    assert.equal(failed.body.job.stages.intake.status, "pending");

    const retried = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "retry",
        details: "The plugin compatibility issue is fixed."
      })
    });
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));

    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.status, "passed");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].resume, false);
    assert.equal(calls[1].resume, false);
    assert.equal(calls[1].sessionId, calls[0].sessionId);
    assert.match(calls[1].prompt, /Repair a launch-blocked defect/);
    assert.match(calls[1].prompt, /failed before FixLab completed any stage/);
    assert.match(calls[1].prompt, /plugin compatibility issue is fixed/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("running job queues a comment and resumes the same session", async () => {
  const repository = createRepository();
  const calls = [];
  let completeFirst;
  let firstOutput;
  const executor = ({ prompt, sessionId, resume, onOutput }) => {
    calls.push({ prompt, sessionId, resume });
    if (!resume) {
      firstOutput = onOutput;
      return {
        completion: new Promise((resolve) => {
          completeFirst = resolve;
        }),
        terminate() {}
      };
    }
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|comment applied\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Validate the current bug batch.",
        mode: "validate-only"
      })
    });
    const sessionId = started.body.job.id;

    const commented = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "comment",
        details:
          "Keep every validated outcome attached to the existing pull request."
      })
    });
    assert.equal(commented.response.status, 202);
    assert.equal(commented.body.queued, true);
    assert.equal(commented.body.job.inputCount, 1);
    assert.equal(commented.body.job.pendingInputCount, 1);

    for (const stage of FIXLAB_STAGES) {
      firstOutput("stdout", `FIXLAB_STAGE|${stage}|passed|initial result\n`);
    }
    completeFirst({ code: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.status, "passed");
    assert.equal(completed.body.job.pendingInputCount, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].resume, true);
    assert.equal(calls[1].sessionId, sessionId);
    assert.match(calls[1].prompt, /existing pull request/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard checks and starts repository-owned Playwright authentication", async () => {
  const repository = createRepository();
  let receivedPrompt = "";
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  writeFileSync(
    profilePath,
    JSON.stringify(validProfile({
      name: "Playwright authentication repository",
      browserAutomation: {
        workingDirectory: ".",
        package: "@playwright/test",
        browser: "chromium",
        testCommand: "npm run test:e2e",
        testSynthesis: {
          enabled: true,
          defaultDataSource: "synthetic-intercepted",
          mutationMode: "intercepted",
          requireScenarioEvidence: true
        },
        authentication: {
          required: true,
          command: "node playwright-auth.js",
          statusPaths: ["e2e/.auth/user.json"]
        },
        dataSafety: {
          policy: "Use mocked data and intercept mutations.",
          productionAllowed: false
        }
      }
    }))
  );
  writeFileSync(
    join(repository, "playwright-auth.js"),
    'const fs = require("node:fs"); fs.mkdirSync("e2e/.auth", { recursive: true }); fs.writeFileSync("e2e/.auth/user.json", "{}");'
  );
  const screenshotDirectory = join(
    repository,
    "test-results"
  );
  const screenshot = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ]);
  const video = Buffer.from("webm-video-evidence");
  const { dashboard, url } = await startDashboard(
    repository,
    ({ prompt }) => {
      receivedPrompt = prompt;
      return { completion: new Promise(() => {}), terminate() {} };
    }
  );

  try {
    const initial = await jsonRequest(url, "/api/playwright/status");
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.configured, true);
    assert.equal(initial.body.ready, false);

    const started = await jsonRequest(url, "/api/playwright/connect", {
      method: "POST"
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.started, true);

    let status;
    const authenticationDeadline = Date.now() + 10000;
    while (Date.now() < authenticationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await jsonRequest(url, "/api/playwright/status");
      if (!status.body.running) {
        break;
      }
    }
    assert.equal(status.body.ready, true, JSON.stringify(status.body));
    assert.equal(status.body.lastResult.ok, true);
    assert.equal(status.body.paths[0].path, "e2e/.auth/user.json");

    const job = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Capture browser evidence.",
        requestType: "bug-fix",
        mode: "playwright-only",
        recordPlaywrightVideo: true
      })
    });
    assert.equal(job.response.status, 202);
    assert.equal(job.body.job.recordPlaywrightVideo, true);
    mkdirSync(screenshotDirectory, { recursive: true });
    writeFileSync(
      join(screenshotDirectory, "hold-option.png"),
      screenshot
    );
    writeFileSync(
      join(screenshotDirectory, "hold-option.webm"),
      video
    );
    const nestedDirectory = join(screenshotDirectory, "nested-journey");
    mkdirSync(nestedDirectory);
    writeFileSync(join(nestedDirectory, "nested-proof.png"), screenshot);
    const artifacts = await jsonRequest(
      url,
      `/api/playwright/artifacts?jobId=${job.body.job.id}`
    );
    assert.equal(artifacts.response.status, 200);
    assert.equal(artifacts.body.artifacts.length, 3);
    const imageArtifact = artifacts.body.artifacts.find(
      (artifact) => artifact.name === "hold-option.png"
    );
    const videoArtifact = artifacts.body.artifacts.find(
      (artifact) => artifact.name === "hold-option.webm"
    );
    assert.equal(imageArtifact.kind, "image");
    assert.equal(videoArtifact.kind, "video");
    assert.equal(videoArtifact.mimeType, "video/webm");
    assert.ok(
      artifacts.body.artifacts.some((artifact) =>
        /test-results[\\/]nested-journey[\\/]nested-proof\.png/u.test(
          artifact.relativePath
        )
      )
    );
    assert.match(
      imageArtifact.relativePath,
      /test-results[\\/]hold-option\.png/
    );
    const image = await fetch(
      `${url}${imageArtifact.url}`
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), screenshot);
    const recording = await fetch(`${url}${videoArtifact.url}`);
    assert.equal(recording.status, 200);
    assert.equal(recording.headers.get("content-type"), "video/webm");
    assert.deepEqual(Buffer.from(await recording.arrayBuffer()), video);
    const partialRecording = await fetch(`${url}${videoArtifact.url}`, {
      headers: { Range: "bytes=0-3" }
    });
    assert.equal(partialRecording.status, 206);
    assert.equal(
      partialRecording.headers.get("content-range"),
      `bytes 0-3/${video.length}`
    );
    assert.deepEqual(
      Buffer.from(await partialRecording.arrayBuffer()),
      video.subarray(0, 4)
    );
    assert.match(receivedPrompt, /Record Playwright video evidence: yes/);
    assert.match(receivedPrompt, /Save the recording as WebM or MP4/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("blocked live-test resumes wait until authentication releases the browser profile", async () => {
  const repository = createRepository();
  const profile = validProfile();
  profile.browserAutomation.authentication = {
    required: true,
    command: "node auth-holder.js",
    statusPaths: ["auth-ready.json"]
  };
  writeFileSync(
    join(repository, ".github", "fixlab", "repository-profile.json"),
    JSON.stringify(profile)
  );
  writeFileSync(join(repository, "auth-ready.json"), "{}");
  writeFileSync(
    join(repository, "auth-holder.js"),
    'const fs = require("node:fs"); setInterval(() => { if (fs.existsSync("auth-finished")) process.exit(0); }, 20);'
  );
  let executions = 0;
  const { dashboard, url } = await startDashboard(repository, ({ onOutput }) => {
    executions += 1;
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|${stage === "live-test" ? "blocked" : "passed"}|Fixture evidence\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  });
  const input = (action) => jsonRequest(url, "/api/job/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, details: "Retry only the blocked browser gate." })
  });
  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Check browser ownership before a live-test retry.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    let job;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      job = await jsonRequest(url, "/api/job");
      if (job.body.job.status === "blocked" && job.body.job.canResume) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(job.body.job.status, "blocked");
    assert.equal(executions, 1);
    const connected = await jsonRequest(url, "/api/playwright/connect", { method: "POST" });
    assert.equal(connected.response.status, 202);
    for (const action of ["retry", "continue", "comment"]) {
      const rejected = await input(action);
      assert.equal(rejected.response.status, 409);
      assert.match(rejected.body.error, /Authentication is still running.*browser profile/);
    }
    assert.equal(executions, 1);
    const unchanged = await jsonRequest(url, "/api/job");
    assert.equal(unchanged.body.job.inputCount, 0);
    writeFileSync(join(repository, "auth-finished"), "");
    let authentication;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      authentication = await jsonRequest(url, "/api/playwright/status");
      if (!authentication.body.running) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(authentication.body.running, false);
    assert.equal(authentication.body.lastResult.ok, true);
    const resumed = await input("retry");
    assert.equal(resumed.response.status, 202);
    assert.equal(executions, 2);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

async function checkFrontendCleanup(cleanup) {
  const repository = createRepository();
  const port = await availablePort();
  writeFileSync(
    join(repository, ".github", "fixlab", "repository-profile.json"),
    JSON.stringify(
      validProfile({
        applications: {
          frontend: {
            workingDirectory: ".",
            command: "node frontend-launcher.js",
            port,
            healthUrl: `http://127.0.0.1:${port}`
          }
        }
      })
    )
  );
  writeFileSync(
    join(repository, "frontend.js"),
    `require("node:http").createServer((q, s) => s.end(process.env.BROWSER ?? "unset")).listen(${port}, "127.0.0.1");`
  );
  writeFileSync(
    join(repository, "frontend-launcher.js"),
    `require("node:child_process").spawn(process.execPath, ["frontend.js"], { stdio: "inherit", detached: process.platform === "win32" }); process.exit(0);`
  );
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise(() => {}),
    terminate() {}
  }));
  const observer = await startDashboard(repository, () => ({
    completion: new Promise(() => {}),
    terminate() {}
  }));

  try {
    const initial = await jsonRequest(url, "/api/frontend/status");
    assert.equal(initial.body.configured, true);
    assert.equal(initial.body.healthy, false);

    const started = await jsonRequest(url, "/api/frontend/start", {
      method: "POST"
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.started, true);

    let status;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      status = await jsonRequest(url, "/api/frontend/status");
      if (status.body.healthy) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.body.healthy, true);
    assert.equal(status.body.owned, true);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "none");

    const again = await jsonRequest(url, "/api/frontend/start", {
      method: "POST"
    });
    assert.equal(again.response.status, 409);
    const conflict = await jsonRequest(observer.url, "/api/frontend/start", {
      method: "POST"
    });
    assert.equal(conflict.response.status, 409);
    const ownerId = conflict.body.owner.id;

    if (cleanup === "close") {
      await dashboard.close();
    } else {
      const stopped = await jsonRequest(observer.url, "/api/sessions/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerId,
          resource: "frontend",
          action: "stop",
          confirmed: true
        })
      });
      assert.equal(stopped.response.status, 202);
    }
    let healthy = true;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(1000)
        });
        await response.body?.cancel();
      } catch (error) {
        if (["ECONNRESET", "UND_ERR_SOCKET"].includes(error.cause?.code)) {
          continue;
        }
        assert.equal(error.cause?.code, "ECONNREFUSED");
        healthy = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(healthy, false);
  } finally {
    await dashboard.close();
    await observer.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
}

test("dashboard starts, reuses and stops the profile-defined frontend", async () => {
  await checkFrontendCleanup("stop");
});

test("dashboard shutdown stops the frontend process tree", async () => {
  await checkFrontendCleanup("close");
});

test("managed frontend input stays open when EOF requests application shutdown", async () => {
  const repository = createRepository();
  const port = await availablePort();
  const profile = validProfile();
  profile.applications.frontend = {
    workingDirectory: ".",
    command: "node frontend-eof.js",
    port,
    healthUrl: `http://127.0.0.1:${port}`
  };
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  writeFileSync(join(repository, "frontend-eof.js"), [
    `const server = require("node:http").createServer((q, s) => s.end("ready")).listen(${port}, "127.0.0.1");`,
    'process.stdin.on("end", () => server.close(() => process.exit(0)));',
    "process.stdin.resume();"
  ].join("\n"));
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise(() => {}),
    terminate() {}
  }));
  try {
    const started = await jsonRequest(url, "/api/frontend/start", { method: "POST" });
    assert.equal(started.response.status, 202);
    let status;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      status = await jsonRequest(url, "/api/frontend/status");
      if (status.body.healthy || !status.body.running) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.body.healthy, true, JSON.stringify(status.body));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await jsonRequest(url, "/api/frontend/status")).body.healthy, true);
    const stopped = await jsonRequest(url, "/api/frontend/stop", { method: "POST" });
    assert.equal(stopped.response.status, 200);
    assert.equal(stopped.body.stopped, true);
    assert.equal(stopped.body.running, false);
    assert.equal(stopped.body.healthy, false);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard does not restart a frontend that is already healthy", async () => {
  const repository = createRepository();
  const port = await availablePort();
  writeFileSync(
    join(repository, ".github", "fixlab", "repository-profile.json"),
    JSON.stringify(
      validProfile({
        applications: {
          frontend: {
            workingDirectory: ".",
            command: "node does-not-exist.js",
            port,
            healthUrl: `http://127.0.0.1:${port}`
          }
        }
      })
    )
  );
  const external = await new Promise((resolve) => {
    const instance = createHttpServer((request, response) =>
      response.end("ok")
    );
    instance.listen(port, "127.0.0.1", () => resolve(instance));
  });
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise(() => {}),
    terminate() {}
  }));

  try {
    const result = await jsonRequest(url, "/api/frontend/start", {
      method: "POST"
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.started, false);
    assert.equal(result.body.healthy, true);
    assert.equal(result.body.owned, false);
    const stopped = await jsonRequest(url, "/api/frontend/stop", {
      method: "POST"
    });
    assert.equal(stopped.body.stopped, false);
    assert.equal(stopped.body.healthy, true);
  } finally {
    await dashboard.close();
    await new Promise((resolve) => external.close(resolve));
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const scenario of [
  { environment: "local", prestartFrontend: true, warm: true },
  { environment: "LOCAL", prestartFrontend: true, warm: true },
  { environment: "local", prestartFrontend: false, warm: false },
  { environment: "dev", prestartFrontend: true, warm: false }
]) {
  test(`React warm-up is parallel and environment-bound (${scenario.environment}, ${scenario.prestartFrontend})`, async () => {
    const repository = createRepository();
    const port = await availablePort();
    writeFileSync(
      join(repository, ".github", "fixlab", "repository-profile.json"),
      JSON.stringify(validProfile({
        environments: scenario.environment === "LOCAL" ? ["LOCAL", "dev", "sit"] : ["local", "dev", "sit"],
        applications: {
          frontend: {
            command: "node frontend.js",
            workingDirectory: ".",
            port,
            healthUrl: `http://127.0.0.1:${port}`
          }
        }
      }))
    );
    writeFileSync(
      join(repository, "frontend.js"),
      `setTimeout(() => require("node:http").createServer((q, s) => s.end(process.env.BROWSER ?? "unset")).listen(${port}, "127.0.0.1"), 500);`
    );
    let invocation;
    const { dashboard, url } = await startDashboard(repository, (input) => {
      invocation = input;
      return { completion: new Promise(() => {}), terminate() {} };
    });
    try {
      const result = await jsonRequest(url, "/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: "Warm the local app while diagnosing.",
          requestType: "bug-fix",
          mode: "validate-only",
          targetEnvironment: scenario.environment,
          prestartFrontend: scenario.prestartFrontend
        })
      });
      assert.equal(result.response.status, 202);
      assert.ok(invocation, "the agent must start before React finishes compilation");
      if (scenario.warm) {
        assert.match(invocation.prompt, /healthy baseline server does not prove the fix/);
        let healthy = false;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const status = await jsonRequest(url, "/api/frontend/status");
          healthy = status.body.healthy;
          if (healthy) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(healthy, true);
        assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "none");
        const job = await jsonRequest(url, "/api/job");
        assert.equal(job.body.job.status, "running");
        assert.equal(job.body.job.stages["local-stack"].status, "pending");
        assert.ok(job.body.job.logs.some((entry) => /warm-up started in parallel/.test(entry.message)));
      } else {
        const session = await jsonRequest(url, "/api/session");
        assert.equal(session.body.frontend.running, false);
        assert.doesNotMatch(invocation.prompt, /React warm-up is requested/);
      }
    } finally {
      await dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("zero exit with missing terminal markers fails as incomplete", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    onOutput("stderr", "original validation error\n");
    onOutput("stdout", "FIXLAB_STAGE|intake|passed|request accepted\n");
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Validate the request.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");

    assert.equal(result.body.job.status, "failed");
    assert.match(result.body.job.error, /Incomplete stage markers/);
    assert.equal(
      result.body.job.logs.some(
        (entry) => entry.message === "original validation error"
      ),
      true
    );
    assert.equal(result.body.job.stages.diagnosis.status, "pending");
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard queues concurrent jobs and starts the next passed job", async () => {
  const repository = createRepository();
  let resolveJob;
  let firstOutput;
  let executorCalls = 0;
  const completion = new Promise((resolve) => {
    resolveJob = resolve;
  });
  const executor = ({ onOutput }) => {
    executorCalls += 1;
    if (executorCalls === 1) {
      firstOutput = onOutput;
      return { completion, terminate() {} };
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const invalid = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "",
        requestType: "unknown",
        mode: "unknown"
      })
    });
    assert.equal(invalid.response.status, 400);

    const invalidRequestType = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Reject this request type.",
        requestType: "feature",
        mode: "validate-only"
      })
    });
    assert.equal(invalidRequestType.response.status, 400);
    assert.match(invalidRequestType.body.error, /requestType/);

    const first = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Keep this job active.",
        requestType: "bug-fix",
        mode: "playwright-only"
      })
    });
    assert.equal(first.response.status, 202);
    assert.equal(first.body.job.mode, "playwright-only");

    const second = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Run this job second.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    assert.equal(second.response.status, 202);
    assert.equal(second.body.queued, true);
    assert.equal(second.body.queue.length, 1);
    assert.equal(second.body.queue[0].position, 1);
    assert.equal(second.body.queue[0].status, "queued");
    assert.equal(second.body.queue[0].mode, "validate-only");
    assert.deepEqual(
      Object.keys(second.body.queue[0].stages),
      FIXLAB_STAGES
    );

    for (const stage of FIXLAB_STAGES) {
      firstOutput(
        "stdout",
        `FIXLAB_STAGE|${stage}|passed|completed\n`
      );
    }
    resolveJob({ code: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const status = await jsonRequest(url, "/api/status");
    assert.equal(executorCalls, 2);
    assert.equal(status.body.job.request, "Run this job second.");
    assert.equal(status.body.job.status, "running");
    assert.deepEqual(status.body.queue, []);
    assert.equal(status.body.history.length, 1);
    assert.equal(status.body.history[0].request, "Keep this job active.");
    assert.equal(status.body.history[0].status, "passed");
    assert.deepEqual(
      Object.values(status.body.history[0].stages).map(
        (stage) => stage.status
      ),
      FIXLAB_STAGES.map(() => "passed")
    );
    assert.deepEqual(status.body.history[0].logs, []);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard cancels waiting jobs without interrupting the active job", async () => {
  const repository = createRepository();
  let executorCalls = 0;
  const executor = () => {
    executorCalls += 1;
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const active = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Keep this job active.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    const second = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Cancel this waiting job by position.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    const third = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Cancel this waiting job by ID.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    const secondId = second.body.queuedJob.id;
    const thirdId = third.body.queuedJob.id;

    const activeRejected = await jsonRequest(url, "/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: active.body.job.id })
    });
    assert.equal(activeRejected.response.status, 404);
    assert.match(activeRejected.body.error, /queued/);

    const invalidPosition = await jsonRequest(url, "/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: 99 })
    });
    assert.equal(invalidPosition.response.status, 400);

    const cancelledSecond = await jsonRequest(url, "/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: 1 })
    });
    assert.equal(cancelledSecond.response.status, 202);
    assert.equal(cancelledSecond.body.job.id, active.body.job.id);
    assert.equal(cancelledSecond.body.job.status, "running");
    assert.equal(cancelledSecond.body.cancelledJob.id, secondId);
    assert.equal(cancelledSecond.body.cancelledJob.status, "cancelled");
    assert.equal(cancelledSecond.body.queue.length, 1);
    assert.equal(cancelledSecond.body.queue[0].id, thirdId);
    assert.equal(cancelledSecond.body.queue[0].position, 1);
    assert.equal(cancelledSecond.body.history[0].id, secondId);

    const cancelledThird = await jsonRequest(url, "/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: thirdId })
    });
    assert.equal(cancelledThird.response.status, 202);
    assert.equal(cancelledThird.body.cancelledJob.id, thirdId);
    assert.deepEqual(cancelledThird.body.queue, []);
    assert.equal(executorCalls, 1);

    const metrics = await jsonRequest(url, "/api/metrics?period=all");
    assert.equal(metrics.body.metrics.cancelled, 2);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard holds queued and active jobs and resumes the same session", async () => {
  const repository = createGitRepository();
  const executions = [];
  const executor = (options) => {
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const execution = {
      options,
      resolveCompletion,
      terminate() {
        resolveCompletion({ code: null, signal: "SIGTERM" });
      }
    };
    executions.push(execution);
    return {
      completion,
      terminate: execution.terminate
    };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const first = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Hold the active lifecycle job.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    const second = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Hold the queued lifecycle job.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    const firstId = first.body.job.id;
    const firstSessionId = executions[0].options.sessionId;
    const secondId = second.body.queuedJob.id;

    const heldQueued = await jsonRequest(url, "/api/jobs/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: secondId })
    });
    assert.equal(heldQueued.response.status, 202);
    assert.equal(heldQueued.body.heldJob.status, "held");
    assert.deepEqual(
      heldQueued.body.held.map((job) => job.id),
      [secondId]
    );

    const historyPath = join(
      dirname(createCacheContext(repository).cachePath),
      "dashboard-jobs.json"
    );
    const persisted = JSON.parse(readFileSync(historyPath, "utf8"));
    const persistedHeldJob = persisted.jobs.find(
      (job) => job.id === secondId
    );
    assert.equal(persistedHeldJob.status, "held");

    const resumedQueued = await jsonRequest(url, "/api/jobs/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: secondId })
    });
    assert.equal(resumedQueued.response.status, 202);
    assert.deepEqual(
      resumedQueued.body.queue.map((job) => job.id),
      [secondId]
    );

    executions[0].options.onOutput(
      "stdout",
      "FIXLAB_STAGE|intake|passed|Intake retainedFIXLAB_ACTIVITY|diagnosis|Retain partial output"
    );
    const holding = await jsonRequest(url, "/api/jobs/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: firstId })
    });
    assert.equal(holding.response.status, 202);
    assert.equal(holding.body.job.status, "holding");

    for (
      let attempt = 0;
      attempt < 20 && executions.length < 2;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(executions.length, 2);
    const activeAfterHold = await jsonRequest(url, "/api/status");
    assert.equal(activeAfterHold.body.job.id, secondId);
    assert.deepEqual(
      activeAfterHold.body.held.map((job) => job.id),
      [firstId]
    );
    assert.deepEqual(activeAfterHold.body.held[0].stages.intake, {
      status: "passed",
      message: "Intake retained"
    });
    assert.equal(activeAfterHold.body.held[0].canResume, true);

    const resumedActive = await jsonRequest(url, "/api/jobs/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: firstId })
    });
    assert.equal(resumedActive.response.status, 202);
    assert.deepEqual(
      resumedActive.body.queue.map((job) => job.id),
      [firstId]
    );

    for (const stage of FIXLAB_STAGES) {
      executions[1].options.onOutput(
        "stdout",
        `FIXLAB_STAGE|${stage}|passed|${stage} completed\n`
      );
    }
    executions[1].resolveCompletion({ code: 0 });

    for (
      let attempt = 0;
      attempt < 20 && executions.length < 3;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(executions.length, 3);
    assert.equal(executions[2].options.resume, true);
    assert.equal(executions[2].options.sessionId, firstSessionId);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard restores held jobs after restart", async () => {
  const repository = createGitRepository();
  const first = await startDashboard(repository, () => ({
    completion: new Promise(() => {}),
    terminate() {}
  }));
  let heldJobId;

  try {
    await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Keep this job active during dashboard restart.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    const queued = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Restore this held job after dashboard restart.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    heldJobId = queued.body.queuedJob.id;
    const held = await jsonRequest(first.url, "/api/jobs/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: heldJobId })
    });
    assert.equal(held.response.status, 202);
  } finally {
    await first.dashboard.close();
  }

  const second = await startDashboard(repository, () => {
    throw new Error("executor should not run while restoring held jobs");
  });
  try {
    const status = await jsonRequest(second.url, "/api/status");
    assert.deepEqual(
      status.body.held.map((job) => job.id),
      [heldJobId]
    );
    assert.equal(status.body.held[0].status, "held");
  } finally {
    await second.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard restarts a completed job with a new id and session", async () => {
  const repository = createGitRepository();
  const executions = [];
  const executor = (options) => {
    executions.push(options);
    if (executions.length === 1) {
      for (const stage of FIXLAB_STAGES) {
        options.onOutput(
          "stdout",
          `FIXLAB_STAGE|${stage}|passed|${stage} completed\n`
        );
      }
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Restart this completed lifecycle job.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    const originalId = started.body.job.id;
    const originalSessionId = executions[0].sessionId;
    let status;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      status = await jsonRequest(url, "/api/status");
      if (status.body.job?.status === "passed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status.body.job.status, "passed");

    const restarted = await jsonRequest(url, "/api/jobs/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: originalId })
    });
    assert.equal(restarted.response.status, 202);
    assert.notEqual(restarted.body.job.id, originalId);
    assert.notEqual(executions[1].sessionId, originalSessionId);
    assert.equal(restarted.body.job.status, "running");
    assert.equal(restarted.body.history[0].id, originalId);
    assert.equal(
      restarted.body.job.request,
      "Restart this completed lifecycle job."
    );
    assert.equal(executions[1].resume, false);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard purges only terminal history older than the selected age", async () => {
  const repository = createGitRepository();
  const executor = ({ onOutput }) => {
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} completed\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const first = await startDashboard(repository, executor);
  let oldJobId;

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Create purgeable history.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    oldJobId = started.body.job.id;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await jsonRequest(first.url, "/api/status");
      if (status.body.job?.status === "passed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await first.dashboard.close();
  }

  const historyPath = join(
    dirname(createCacheContext(repository).cachePath),
    "dashboard-jobs.json"
  );
  const persisted = JSON.parse(readFileSync(historyPath, "utf8"));
  const oldJob = persisted.jobs.find((job) => job.id === oldJobId);
  oldJob.finishedAt = "2020-01-01T00:00:00.000Z";
  const heldJobId = "11111111-2222-4333-8444-555555555555";
  persisted.jobs.push({
    ...oldJob,
    id: heldJobId,
    sessionId: heldJobId,
    request: "Never purge this held job.",
    status: "held",
    startedAt: null,
    heldAt: "2020-01-01T00:00:00.000Z",
    finishedAt: null
  });
  writeFileSync(historyPath, JSON.stringify(persisted, null, 2));

  const second = await startDashboard(repository, () => {
    throw new Error("executor should not run while purging history");
  });
  try {
    const invalid = await jsonRequest(second.url, "/api/history/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ olderThanDays: 0 })
    });
    assert.equal(invalid.response.status, 400);

    const purged = await jsonRequest(second.url, "/api/history/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ olderThanDays: 30 })
    });
    assert.equal(purged.response.status, 200);
    assert.equal(purged.body.deleted, 1);
    assert.equal(purged.body.history.length, 0);
    assert.equal(purged.body.job, null);
    assert.equal(purged.body.queue.length, 0);
    assert.deepEqual(
      purged.body.held.map((job) => job.id),
      [heldJobId]
    );
  } finally {
    await second.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard dismisses a failed job and starts the next queued job", async () => {
  const repository = createRepository();
  let executorCalls = 0;
  const executor = () => {
    executorCalls += 1;
    if (executorCalls === 1) {
      return {
        completion: Promise.resolve({ code: 1 }),
        terminate() {}
      };
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const first = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "This failed job should remain in history.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    assert.equal(first.response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failed = await jsonRequest(url, "/api/job");
    assert.equal(failed.body.job.status, "failed");

    const second = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Start this queued job after dismissal.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    assert.equal(second.response.status, 202);
    assert.equal(second.body.queued, true);

    const dismissed = await jsonRequest(url, "/api/job/dismiss", {
      method: "POST"
    });
    assert.equal(dismissed.response.status, 202, JSON.stringify(dismissed.body));
    assert.equal(dismissed.body.dismissedJob.status, "failed");
    assert.equal(dismissed.body.job.request, "Start this queued job after dismissal.");
    assert.equal(dismissed.body.job.status, "running");
    assert.deepEqual(dismissed.body.queue, []);
    assert.equal(dismissed.body.history[0].status, "failed");
    assert.equal(executorCalls, 2);

    const rejected = await jsonRequest(url, "/api/job/dismiss", {
      method: "POST"
    });
    assert.equal(rejected.response.status, 409);
    assert.match(rejected.body.error, /still running/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard persists privacy-safe token and duration metrics", async () => {
  const repository = createGitRepository();
  const executor = ({ onOutput }) => {
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|completed\n`);
    }
    onOutput(
      "stdout",
      "Tokens ↑ 2.4m (1.9m cached, 367.4k written) • ↓ 14.8k\n"
    );
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const first = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Private request text must not persist.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });

    assert.equal(started.response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const metrics = await jsonRequest(
      first.url,
      "/api/metrics?period=24h"
    );
    assert.equal(metrics.body.metrics.queued, 1);
    assert.equal(metrics.body.metrics.completed, 1);
    assert.equal(metrics.body.metrics.totalInputTokens, 2_400_000);
    assert.equal(metrics.body.metrics.totalCachedInputTokens, 1_900_000);
    assert.equal(metrics.body.metrics.totalCacheWriteTokens, 367_400);
    assert.equal(metrics.body.metrics.totalOutputTokens, 14_800);
    assert.equal(metrics.body.metrics.cacheReusePercent, 79.2);

    const context = createCacheContext(repository);
    const metricsPath = join(
      dirname(context.cachePath),
      "dashboard-metrics.json"
    );
    const persisted = readFileSync(metricsPath, "utf8");
    assert.doesNotMatch(persisted, /Private request text/);
    assert.doesNotMatch(persisted, /comments|screenshots|logs/);
  } finally {
    await first.dashboard.close();
  }

  const second = await startDashboard(repository, () => {
    throw new Error("executor should not run while reading metrics");
  });
  try {
    const metrics = await jsonRequest(
      second.url,
      "/api/metrics?period=all"
    );
    assert.equal(metrics.body.metrics.queued, 1);
    assert.equal(metrics.body.metrics.completed, 1);
    assert.equal(metrics.body.metrics.cacheReusePercent, 79.2);
  } finally {
    await second.dashboard.close();
  }

  rmSync(repository, { recursive: true, force: true });
});

test("dashboard dismisses a blocked job and continues the queue", async () => {
  const repository = createGitRepository();
  let executorCalls = 0;
  const executor = ({ onOutput }) => {
    executorCalls += 1;
    if (executorCalls === 1) {
      for (const stage of FIXLAB_STAGES.slice(0, -1)) {
        onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|completed\n`);
      }
      onOutput(
        "stdout",
        "FIXLAB_STAGE|pr|blocked|Approval is required before creating the pull request.\n"
      );
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const post = (request) =>
      jsonRequest(url, "/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request,
          requestType: "bug-fix",
          mode: "validate-only"
        })
      });
    await post("This job ends blocked.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await jsonRequest(url, "/api/job")).body.job.status, "blocked");

    const queued = await post("This job waits behind the blocked one.");
    assert.equal(queued.body.queued, true);

    const dismissed = await jsonRequest(url, "/api/job/dismiss", {
      method: "POST"
    });
    assert.equal(dismissed.response.status, 202, JSON.stringify(dismissed.body));
    assert.equal(dismissed.body.dismissedJob.status, "blocked");
    assert.equal(dismissed.body.job.request, "This job waits behind the blocked one.");
    assert.equal(dismissed.body.job.status, "running");
    assert.equal(dismissed.body.history[0].status, "blocked");
    assert.equal(executorCalls, 2);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard restores private job summaries and PR readiness after restart", async () => {
  const repository = createGitRepository();
  const executor = ({ onOutput }) => {
    onOutput(
      "stdout",
      "FIXLAB_BUG|17032997|fixed|application|The focused source correction is complete.\n"
    );
    for (const stage of FIXLAB_STAGES.slice(0, -1)) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|completed\n`);
    }
    onOutput(
      "stdout",
      "FIXLAB_STAGE|pr|blocked|Approval is required before creating the pull request.\n"
    );
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const first = await startDashboard(repository, executor);
  let jobId;

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Azure DevOps Bug 17032997: Persist this bug",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    assert.equal(started.response.status, 202);
    jobId = started.body.job.id;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = await jsonRequest(first.url, "/api/status");
    assert.equal(status.body.job.status, "blocked");
    assert.equal(
      status.body.job.pullRequestReadiness.status,
      "blocked"
    );
  } finally {
    await first.dashboard.close();
  }

  const second = await startDashboard(repository, () => {
    throw new Error("executor should not run while restoring dashboard history");
  });
  try {
    const status = await jsonRequest(second.url, "/api/status");
    assert.equal(status.body.job.id, jobId);
    assert.equal(status.body.job.canResume, true);
    assert.equal(status.body.job.bugs[0].id, "17032997");
    assert.equal(
      status.body.job.pullRequestReadiness.status,
      "blocked"
    );

    const context = createCacheContext(repository);
    const historyPath = join(
      dirname(context.cachePath),
      "dashboard-jobs.json"
    );
    const persisted = readFileSync(historyPath, "utf8");
    assert.match(persisted, /Persist this bug/);
    assert.doesNotMatch(
      persisted,
      /logs|screenshots|authentication|source content/
    );
  } finally {
    await second.dashboard.close();
  }

  rmSync(repository, { recursive: true, force: true });
});

test("dashboard recovers an orphaned running job as failed and resumable", async () => {
  const repository = createGitRepository();
  const executor = () => ({
    completion: new Promise(() => {}),
    terminate() {}
  });
  const first = await startDashboard(repository, executor);
  let jobId;

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Persist this running job before restart.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    jobId = started.body.job.id;
    await jsonRequest(first.url, "/api/status");
  } finally {
    await first.dashboard.close();
  }

  const second = await startDashboard(repository, () => {
    throw new Error("executor should not run while recovering a job");
  });
  try {
    const status = await jsonRequest(second.url, "/api/status");
    assert.equal(status.body.job.id, jobId);
    assert.equal(status.body.job.status, "failed");
    assert.equal(status.body.job.canResume, true);
    assert.equal(status.body.job.stages.intake.status, "failed");
    assert.match(status.body.job.error, /without an owned executor process/);
  } finally {
    await second.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard recovery preserves a completed manual localhost gate", async () => {
  const repository = createGitRepository();
  const executor = ({ onOutput }) => {
    onOutput("stdout", "FIXLAB_MANUAL|localhost|pending\n");
    for (const stage of FIXLAB_STAGES) {
      const status =
        stage === "live-test"
          ? "blocked"
          : stage === "fix" || stage === "pr"
            ? "skipped"
            : "passed";
      onOutput(
        "stdout",
        `FIXLAB_STAGE|${stage}|${status}|${stage} completed\n`
      );
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const first = await startDashboard(repository, executor);
  let jobId;

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Retain this manual localhost gate after restart.",
        requestType: "bug-fix",
        mode: "validate-only",
        manualLocalhostTest: true
      })
    });
    jobId = started.body.job.id;
  } finally {
    await first.dashboard.close();
  }

  const historyPath = join(
    dirname(createCacheContext(repository).cachePath),
    "dashboard-jobs.json"
  );
  const legacyHistory = JSON.parse(readFileSync(historyPath, "utf8"));
  delete legacyHistory.jobs.find((job) => job.id === jobId)
    .manualLocalhostPending;
  writeFileSync(historyPath, JSON.stringify(legacyHistory, null, 2));

  let resumedPrompt = "";
  const second = await startDashboard(repository, ({ prompt, onOutput }) => {
    resumedPrompt = prompt;
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} resumed\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  });
  try {
    const status = await jsonRequest(second.url, "/api/status");
    assert.equal(status.body.job.id, jobId);
    assert.equal(status.body.job.status, "blocked");
    assert.equal(status.body.job.manualLocalhostTest, true);
    assert.equal(status.body.job.manualLocalhostPending, true);
    assert.equal(
      status.body.job.manualLocalhostUrl,
      "http://127.0.0.1:3000"
    );
    assert.equal(status.body.job.canResume, true);
    assert.equal(status.body.job.stages["live-test"].status, "blocked");
    assert.equal(status.body.job.error, null);

    const bypass = await jsonRequest(second.url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "continue",
        details: "Continue without a manual result."
      })
    });
    assert.equal(bypass.response.status, 409);
    assert.match(
      bypass.body.error,
      /explicit manual-pass or manual-fail/
    );

    const resumed = await jsonRequest(second.url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "manual-pass" })
    });
    assert.equal(resumed.response.status, 202, JSON.stringify(resumed.body));
    assert.equal(resumed.body.job.manualLocalhostPending, false);
    assert.equal(resumed.body.job.manualLocalhostResult, "passed");
    assert.match(resumedPrompt, /explicitly marked it passed/);
    assert.match(
      resumedPrompt,
      /Persisted manual React localhost result: passed/
    );
    assert.match(resumedPrompt, /stop only frontend processes owned by the current job/);
  } finally {
    await second.dashboard.close();
  }

  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  profile.applications.frontend.healthUrl =
    "http://user:password@localhost:3000";
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));

  const third = await startDashboard(repository, () => {
    throw new Error("executor should not run while restoring accepted evidence");
  });
  try {
    const restored = await jsonRequest(third.url, "/api/status");
    assert.equal(restored.body.job.status, "passed");
    assert.equal(restored.body.job.canResume, false);
    assert.equal(restored.body.job.manualLocalhostPending, false);
    assert.equal(restored.body.job.manualLocalhostResult, "passed");
    assert.equal(restored.body.job.manualLocalhostUrl, "");
  } finally {
    await third.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard disables an unsafe restored manual localhost gate", async () => {
  const repository = createGitRepository();
  const executor = ({ onOutput }) => {
    onOutput("stdout", "FIXLAB_MANUAL|localhost|pending\n");
    for (const stage of FIXLAB_STAGES) {
      const status = stage === "live-test" ? "blocked" : "passed";
      onOutput(
        "stdout",
        `FIXLAB_STAGE|${stage}|${status}|${stage} completed\n`
      );
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const first = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Restore this manual localhost gate safely.",
        requestType: "bug-fix",
        mode: "validate-only",
        manualLocalhostTest: true
      })
    });
    assert.equal(started.response.status, 202);
  } finally {
    await first.dashboard.close();
  }

  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  profile.applications.frontend.healthUrl =
    "http://user:password@localhost:3000";
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));

  const second = await startDashboard(repository, () => {
    throw new Error("unsafe restored job must not resume");
  });
  try {
    const status = await jsonRequest(second.url, "/api/status");
    assert.equal(status.body.job.status, "failed");
    assert.equal(status.body.job.canResume, false);
    assert.equal(status.body.job.manualLocalhostPending, false);
    assert.equal(status.body.job.manualLocalhostUrl, "");
    assert.doesNotMatch(JSON.stringify(status.body), /user:password/);

    const resumed = await jsonRequest(second.url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "continue",
        details: "Resume this unsafe job."
      })
    });
    assert.equal(resumed.response.status, 409);
    assert.match(resumed.body.error, /cannot be resumed safely/);
  } finally {
    await second.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard stops an executor that exceeds the output idle timeout", async () => {
  const repository = createRepository();
  let resolveCompletion;
  let terminated = 0;
  let executorCalls = 0;
  let resumedPrompt = "";
  const executor = ({ onOutput, prompt }) => {
    executorCalls += 1;
    if (executorCalls === 2) {
      resumedPrompt = prompt;
    }
    if (executorCalls === 1) {
      onOutput("stdout", "FIXLAB_STAGE|intake|passed|Intake complete.\n");
      onOutput(
        "stdout",
        "FIXLAB_STAGE|diagnosis|passed|Diagnosis complete.\n"
      );
    }
    onOutput("stdout", "FIXLAB_STAGE|fix|running|Fix in progress.\n");
    return {
      completion: new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
      terminate() {
        terminated += 1;
        resolveCompletion({ code: null, signal: "SIGTERM" });
      }
    };
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    null,
    { executionIdleTimeoutMs: 100 }
  );

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Stop this job when the executor becomes idle.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });

    let status;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await jsonRequest(url, "/api/status");
      if (status.body.job.status === "failed") {
        break;
      }
    }
    assert.equal(terminated, 1);
    assert.equal(status.body.job.status, "failed");
    assert.equal(status.body.job.canResume, true);
    assert.match(status.body.job.error, /produced no output/);
    assert.ok(status.body.job.lastActivityAt);

    const resumed = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "continue" })
    });
    assert.equal(resumed.response.status, 202);
    assert.equal(executorCalls, 2);
    assert.equal(resumed.body.job.status, "running");
    assert.equal(resumed.body.job.stages.intake.status, "passed");
    assert.equal(resumed.body.job.stages.diagnosis.status, "passed");
    assert.equal(resumed.body.job.stages.fix.status, "running");
    assert.match(resumedPrompt, /retained workflow state/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("idle finalization retains the atomic lease and blocks resume until executor termination", async () => {
  const repository = createGitRepository();
  let finish;
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise((resolve) => { finish = resolve; }),
    terminate() {}
  }), null, { executionIdleTimeoutMs: 25, deferTermination: true });
  const contender = createExecutorLease(repository, randomUUID());
  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Wait for confirmed termination before retrying.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    let status;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = await jsonRequest(url, "/api/job");
      if (status.body.job.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status.body.job.status, "failed");
    assert.equal(status.body.job.canResume, false);
    assert.throws(() => contender.acquire("racing-retry"), /lease is reserved/);
    const resume = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", details: "Retry too soon." })
    });
    assert.equal(resume.response.status, 409);
    finish({ code: null, signal: "SIGTERM" });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = await jsonRequest(url, "/api/job");
      if (status.body.job.canResume) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status.body.job.canResume, true);
    contender.acquire("after-exit").release();
  } finally {
    finish?.({ code: null });
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard reports quiet long-running steps without resetting the idle timeout", async () => {
  const repository = createRepository();
  let resolveCompletion;
  const executor = ({ onOutput }) => {
    onOutput(
      "stdout",
      "FIXLAB_STAGE|review|running|Running the production build.\n"
    );
    return {
      completion: new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
      terminate() {}
    };
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    null,
    {
      executionHeartbeatMs: 20,
      executionIdleTimeoutMs: 500
    }
  );

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Show progress while a quiet build runs.",
        requestType: "small-enhancement",
        mode: "fix-and-validate"
      })
    });
    const lastActivityAt = started.body.job.lastActivityAt;

    let status;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await jsonRequest(url, "/api/status");
      if (status.body.job.activity.length > 0) {
        break;
      }
    }

    assert.equal(status.body.job.status, "running");
    assert.equal(status.body.job.lastActivityAt, lastActivityAt);
    assert.equal(status.body.job.activity[0].stage, "review");
    assert.match(
      status.body.job.activity[0].message,
      /still running.*without new output/i
    );
    resolveCompletion({ code: 0 });
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard stops only the active executor when chat requests it", async () => {
  const repository = createRepository();
  let resolveCompletion;
  let terminated = 0;
  const executor = () => ({
    completion: new Promise((resolve) => {
      resolveCompletion = resolve;
    }),
    terminate() {
      terminated += 1;
      resolveCompletion({ code: null, signal: "SIGTERM" });
    }
  });
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Stop this job from terminal chat.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    const stopped = await jsonRequest(url, "/api/job/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });

    assert.equal(stopped.response.status, 202);
    assert.equal(stopped.body.stopping, true);
    assert.equal(terminated, 1);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("terminal chat sends free text to the active dashboard session", async () => {
  const requests = [];
  const job = {
    id: "job-1",
    status: "running",
    request: "Repair the defect",
    durationMs: 1000,
    pullRequestReadiness: { message: "Validation is running." },
    stages: {
      intake: { status: "running", message: "Inspecting the request." },
      pr: { status: "pending", message: "" }
    },
    logs: []
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ job }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/api/job/input")) {
      return new Response(JSON.stringify({ job, queued: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  const exitCode = await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input: Readable.from(["Use my corporate account\n/exit\n"]),
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000
  });

  const submitted = requests.find(({ url }) =>
    url.endsWith("/api/job/input")
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(submitted.options.body), {
    action: "comment",
    details: "Use my corporate account"
  });
  assert.match(output, /FixLab chat is connected/);
  assert.match(output, /Guidance queued for the same session/);
});

test("terminal chat dispatches manual localhost pass and fail actions", async () => {
  const submitted = [];
  const job = {
    id: "manual-job",
    status: "blocked",
    request: "Validate React localhost",
    durationMs: 1000,
    manualLocalhostPending: true,
    pullRequestReadiness: { message: "Manual validation is pending." },
    stages: {
      "live-test": { status: "blocked", message: "Manual result required." },
      pr: { status: "skipped", message: "Manual result required." }
    },
    logs: []
  };
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ job }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/api/job/input")) {
      submitted.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ job, queued: false }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });

  const exitCode = await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input: Readable.from(["manual test passed\n/manual-fail\n/exit\n"]),
    output,
    errorOutput: output,
    fetchImpl,
    pollIntervalMs: 10000
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(
    submitted.map(({ action }) => action),
    ["manual-pass", "manual-fail"]
  );
});

test("terminal chat can recover by starting a dashboard connection", async () => {
  let dashboardStarted = false;
  const job = {
    id: "job-recovered",
    status: "passed",
    request: "Recover the job",
    durationMs: 2000,
    pullRequestReadiness: { message: "PR is ready." },
    stages: {
      pr: { status: "passed", message: "PR is ready." }
    },
    logs: []
  };
  const fetchImpl = async (url) => {
    if (!dashboardStarted) {
      throw new Error("connect ECONNREFUSED");
    }
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ job }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  const exitCode = await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input: Readable.from(["/exit\n"]),
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000,
    recoverConnection: async ({ baseUrl }) => {
      dashboardStarted = true;
      return baseUrl;
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(dashboardStarted, true);
  assert.match(output, /Job job-recovered: passed/);
  assert.match(output, /FixLab chat is connected/);
});

test("terminal chat redraws the prompt while job logs stream", async () => {
  let statusReads = 0;
  const input = new PassThrough();
  input.isTTY = true;
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  outputStream.isTTY = true;
  const fetchImpl = async (url) => {
    if (!url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    statusReads += 1;
    return new Response(JSON.stringify({
      job: {
        id: "job-streaming",
        status: "running",
        request: "Stream progress",
        durationMs: 1000,
        pullRequestReadiness: { message: "Validation is running." },
        stages: {},
        logs: statusReads > 1
          ? [{ index: 1, stream: "stdout", message: "Build is still running." }]
          : []
      }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const chat = runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 5
  });
  for (let attempt = 0; attempt < 100 && !output.includes("Build is still running."); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  input.end("/exit\n");

  assert.equal(await chat, 0);
  assert.match(output, /Build is still running/);
  assert.ok(output.match(/fixlab> /g)?.length >= 2);
});

test("terminal chat batches a poll into one redraw and removes runtime screen controls", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  outputStream.isTTY = true;
  let reads = 0;
  const fetchImpl = async () => {
    reads += 1;
    return new Response(JSON.stringify({
      job: {
        id: "batched-job",
        status: "running",
        request: "Batch output",
        stages: {},
        logs: reads === 1 ? [] : [
          ...Array.from({ length: 50 }, (_, index) => ({
            index,
            stream: "stdout",
            message: `\u001b[2J\u001b[Hprogress-${index}`
          })),
          { index: 50, stream: "stdout", message: "\u001b[2J\r" }
        ]
      }
    }), { headers: { "Content-Type": "application/json" } });
  };
  const chat = runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 5
  });
  for (let attempt = 0; attempt < 100 && reads < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const streamed = output;
  input.end("/exit\n");
  assert.equal(await chat, 0);
  assert.match(streamed, /progress-49/);
  assert.doesNotMatch(streamed, /\u001b\[2J|\u001b\[H/);
  assert.equal(streamed.match(/fixlab> /g)?.length, 2);
});

test("terminal chat reports an unchanged polling failure once and announces recovery", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  outputStream.isTTY = true;
  let reads = 0;
  let disconnected = true;
  const fetchImpl = async () => {
    reads += 1;
    if (reads > 1 && disconnected) {
      throw new Error("connection unavailable");
    }
    return new Response(JSON.stringify({ job: null }), {
      headers: { "Content-Type": "application/json" }
    });
  };
  const chat = runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 5
  });
  for (let attempt = 0; attempt < 100 && reads < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(output.match(/Dashboard polling failed/g)?.length, 1);
  disconnected = false;
  for (let attempt = 0; attempt < 100 && !output.includes("connection restored"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  input.end("/exit\n");
  assert.equal(await chat, 0);
  assert.equal(output.match(/Dashboard connection restored/g)?.length, 1);
});

test("terminal chat buffers streamed output while the user is typing", async () => {
  let statusReads = 0;
  let submittedComments = 0;
  const input = new PassThrough();
  input.isTTY = true;
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  outputStream.isTTY = true;
  const job = {
    id: "job-typing",
    status: "running",
    request: "Analyze a page error",
    durationMs: 1000,
    pullRequestReadiness: { message: "Validation is running." },
    stages: {},
    logs: []
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/status")) {
      statusReads += 1;
      return new Response(JSON.stringify({
        job: {
          ...job,
          logs: statusReads > 1
            ? [{ index: 1, stream: "stdout", message: "Background progress." }]
            : []
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/api/job/input")) {
      submittedComments += 1;
      return new Response(JSON.stringify({ job, queued: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };

  const chat = runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 5
  });
  input.write("Analyze the page");
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.write(" error\n");
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.write("/exit\n");

  assert.equal(await chat, 0);
  assert.equal(submittedComments, 1);
  assert.match(output, /Background progress/);
});

test("terminal chat confirms and switches the connected repository", async () => {
  const input = Readable.from(["/exit\n"]);
  const requests = [];
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const fetchImpl = async (url) => {
    requests.push(url);
    const alternate = url.startsWith("http://127.0.0.1:4318");
    return new Response(JSON.stringify({
      readiness: {
        repository: alternate ? "C:\\repos\\admin-ui" : "C:\\repos\\storefront",
        repositoryReady: true,
        profileReady: true
      },
      job: null
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const exitCode = await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000,
    selectRepository: async ({ readiness }) => {
      assert.equal(readiness.repository, "C:\\repos\\storefront");
      return "http://127.0.0.1:4318";
    }
  });

  assert.equal(exitCode, 0);
  assert.ok(requests.some((url) => url.startsWith("http://127.0.0.1:4318")));
  assert.match(output, /FixLab repository: C:\\repos\\admin-ui/);
});

test("terminal chat recognizes natural operational commands", () => {
  assert.deepEqual(parseNaturalChatCommand("start dashboard"), {
    command: "/dashboard",
    details: ""
  });
  assert.deepEqual(parseNaturalChatCommand("show logs 50"), {
    command: "/logs",
    details: "50"
  });
  assert.deepEqual(parseNaturalChatCommand("show pull request"), {
    command: "/pr",
    details: ""
  });
  assert.deepEqual(
    parseNaturalChatCommand("switch repository to C:\\repos\\admin-ui"),
    {
      command: "/repository",
      details: "C:\\repos\\admin-ui"
    }
  );
  assert.deepEqual(parseNaturalChatCommand("add a bug: Save button is disabled"), {
    command: "/new-bug",
    details: "Save button is disabled"
  });
  assert.deepEqual(parseNaturalChatCommand("cancel waiting job 4"), {
    command: "/cancel-job",
    details: "4"
  });
  assert.deepEqual(parseNaturalChatCommand("manual test passed"), {
    command: "/manual-pass",
    details: ""
  });
  assert.deepEqual(parseNaturalChatCommand("React test failed"), {
    command: "/manual-fail",
    details: ""
  });
  assert.deepEqual(
    parseNaturalChatCommand(
      "remove job 253ef92a-7bdf-47bd-b944-cdb0e6297580 from the queue"
    ),
    {
      command: "/cancel-job",
      details: "253ef92a-7bdf-47bd-b944-cdb0e6297580"
    }
  );
  assert.equal(
    parseNaturalChatCommand("Fix the hierarchy template bug"),
    null
  );
});

test("terminal chat opens the dashboard from natural language", async () => {
  let openedUrl;
  const input = Readable.from(["start dashboard\n/exit\n"]);
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const fetchImpl = async () =>
    new Response(JSON.stringify({
      readiness: {
        repository: "C:\\repos\\storefront",
        repositoryReady: true,
        profileReady: true
      },
      job: null
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  const exitCode = await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000,
    openDashboard: async ({ baseUrl }) => {
      openedUrl = baseUrl;
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(openedUrl, "http://127.0.0.1:4317");
  assert.match(output, /Opened FixLab dashboard/);
});

for (const model of ["", "hydrafusion"]) {
test(`terminal chat creates a separate bug job with ${model || "default model"} from natural language`, async () => {
  const requests = [];
  const input = Readable.from([
    "new bug Product search returns duplicate rows\n",
    "/exit\n"
  ]);
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({
        readiness: {
          repository: "C:\\repos\\storefront",
          repositoryReady: true,
          profileReady: true
        },
        job: {
          id: "current-job",
          status: "running",
          request: "Current work",
          durationMs: 1000,
          pullRequestReadiness: { message: "Validation is running." },
          stages: {},
          logs: []
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/api/jobs")) {
      return new Response(JSON.stringify({
        job: { id: "current-job" },
        queue: [{
          id: "new-bug-job",
          request: "Product search returns duplicate rows"
        }]
      }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };

  assert.equal(await runChat({
    baseUrl: "http://127.0.0.1:4317",
    model,
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000
  }), 0);

  const submitted = requests.find(({ url }) => url.endsWith("/api/jobs"));
  assert.deepEqual(JSON.parse(submitted.options.body), {
    request: "Product search returns duplicate rows",
    ...(model ? { model } : {}),
    mode: "fix-and-validate",
    requestType: "bug-fix",
    pullRequestStrategy: "common",
    runAllUiScenarios: false,
    recordPlaywrightVideo: false,
    manualLocalhostTest: false
  });
  assert.match(output, /New bug queued as job new-bug-job/);
});
}

test("terminal chat cancels a waiting job by queue position", async () => {
  const requests = [];
  const input = Readable.from(["cancel waiting job 2\n", "/exit\n"]);
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({
        readiness: {
          repository: "C:\\repos\\storefront",
          repositoryReady: true,
          profileReady: true
        },
        job: {
          id: "current-job",
          status: "running",
          request: "Current work",
          durationMs: 1000,
          pullRequestReadiness: { message: "Validation is running." },
          stages: {},
          logs: []
        },
        queue: []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/api/jobs/cancel")) {
      return new Response(JSON.stringify({
        job: { id: "current-job" },
        cancelledJob: { id: "cancelled-job", status: "cancelled" },
        queue: [{ id: "remaining-job" }]
      }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };

  assert.equal(await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000
  }), 0);

  const cancelled = requests.find(
    ({ url }) => url.endsWith("/api/jobs/cancel")
  );
  assert.deepEqual(JSON.parse(cancelled.options.body), { position: 2 });
  assert.match(
    output,
    /Cancelled queued job cancelled-job\. 1 job\(s\) waiting\./
  );
});

test("dashboard shutdown terminates only its active executor handle", async () => {
  const repository = createRepository();
  let terminated = 0;
  const executor = () => ({
    completion: new Promise(() => {}),
    terminate() {
      terminated += 1;
    }
  });
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Keep this job active until shutdown.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    await dashboard.close();
    assert.equal(terminated, 1);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("shutdown completes frontend and HTTP cleanup even when executor termination throws", async () => {
  const repository = createRepository();
  const profilePath = join(repository, ".github", "fixlab", "repository-profile.json");
  const profile = validProfile();
  const port = await availablePort();
  profile.applications.frontend = {
    workingDirectory: ".",
    command: 'node -e "setInterval(() => {}, 1000)"',
    port,
    healthUrl: `http://127.0.0.1:${port}`
  };
  writeFileSync(profilePath, JSON.stringify(profile));
  let finish;
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise((resolve) => { finish = resolve; }),
    terminate() { throw new Error("Synthetic executor termination error"); }
  }));
  try {
    const start = await jsonRequest(url, "/api/frontend/start", { method: "POST" });
    assert.equal(start.response.status, 202);
    const session = await jsonRequest(url, "/api/session");
    const pid = session.body.frontend.pid;
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Exercise settled shutdown.", mode: "validate-only" })
    });
    await assert.rejects(dashboard.close(), (error) =>
      error instanceof AggregateError &&
      error.errors.some((failure) => /Synthetic executor termination error/.test(failure.message)));
    await assert.rejects(fetch(`${url}/api/status`));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    finish({ code: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    finish?.({ code: null });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("same-repository session controls confirm the owner, stop and resume saved job context", async () => {
  const repository = createGitRepository();
  const calls = [];
  let finish;
  let stopped = 0;
  const owner = await startDashboard(repository, (input) => {
    calls.push(input);
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() {
        stopped += 1;
        finish({ code: null });
      }
    };
  });
  const other = await startDashboard(repository, () => {
    throw new Error("the other dashboard must not start an agent");
  });
  const post = (url, path, body) => jsonRequest(url, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    const job = await post(owner.url, "/api/jobs", {
      request: "Retain this session context.",
      requestType: "bug-fix",
      mode: "validate-only"
    });
    const listed = await jsonRequest(other.url, "/api/sessions");
    assert.equal(listed.body.sessions.length, 2);
    const session = listed.body.sessions.find((entry) => entry.job?.running);
    assert.equal(session.job.id, job.body.job.id);
    assert.equal(session.url, owner.url);
    const conflict = await post(other.url, "/api/jobs", {
      request: "This must not start while another owner holds the repository.",
      requestType: "bug-fix",
      mode: "validate-only"
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.owner.id, session.id);
    const control = {
      ownerId: session.id,
      jobId: session.job.id,
      resource: "job",
      action: "stop"
    };
    const unconfirmed = await post(other.url, "/api/sessions/control", control);
    assert.equal(unconfirmed.response.status, 409);
    assert.equal(stopped, 0);
    const stale = await post(other.url, "/api/sessions/control", {
      ...control, confirmed: true, jobId: randomUUID()
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stopped, 0);
    const reconnect = await post(other.url, "/api/sessions/control", {
      ...control, action: "resume"
    });
    assert.equal(reconnect.response.status, 202);
    assert.equal(calls.length, 1);
    const confirmed = await post(other.url, "/api/sessions/control", {
      ...control, confirmed: true
    });
    assert.equal(confirmed.response.status, 202);
    assert.equal(stopped, 1);
    const blocked = await jsonRequest(owner.url, "/api/job");
    assert.equal(blocked.body.job.status, "blocked");
    assert.equal(blocked.body.job.canResume, true);
    const resumed = await post(other.url, "/api/sessions/control", {
      ...control, action: "resume"
    });
    assert.equal(resumed.response.status, 202);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].sessionId, calls[0].sessionId);
    assert.equal(calls[1].resume, true);
    const shutdown = await post(other.url, "/api/sessions/control", {
      ...control, action: "shutdown", resource: "all", confirmed: true
    });
    assert.equal(shutdown.response.status, 202);
    assert.equal(stopped, 2);
    assert.equal((await jsonRequest(owner.url, "/api/status")).response.status, 200);
    await owner.dashboard.close();
    const remaining = await jsonRequest(other.url, "/api/sessions");
    assert.equal(remaining.body.sessions.length, 1);
  } finally {
    await owner.dashboard.close();
    await other.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard bounds retained raw logs while preserving stage summaries", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (let index = 0; index < MAX_JOB_LOG_ENTRIES + 20; index += 1) {
      onOutput("stdout", `diagnostic line ${index}\n`);
    }
    onOutput(
      "stdout",
      "FIXLAB_TEST|synthetic-intercepted|intercepted|Bounded logging scenario evidence.\n"
    );
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} summary\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Exercise bounded logging.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");

    assert.equal(result.body.job.status, "passed");
    assert.equal(result.body.job.logs.length, MAX_JOB_LOG_ENTRIES);
    assert.equal(result.body.job.droppedLogs, 29);
    assert.equal(result.body.job.stages.pr.message, "pr summary");
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard exposes bounded safe agent activity separately from raw logs", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (let index = 0; index < MAX_JOB_ACTIVITY_ENTRIES + 5; index += 1) {
      onOutput(
        "stdout",
        `FIXLAB_ACTIVITY|diagnosis|Evidence update ${index}\n`
      );
    }
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} summary\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Show structured agent analysis.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");

    assert.equal(
      result.body.job.status,
      "passed",
      JSON.stringify(result.body.job)
    );
    assert.equal(result.body.job.activity.length, MAX_JOB_ACTIVITY_ENTRIES);
    assert.deepEqual(result.body.job.activity[0], {
      timestamp: result.body.job.activity[0].timestamp,
      stage: "diagnosis",
      message: "Evidence update 5"
    });
    assert.equal(
      result.body.job.logs.some((entry) =>
        entry.message.startsWith("FIXLAB_ACTIVITY|")
      ),
      true
    );
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard cache hits and invalidates on profile or HEAD changes", async () => {
  const repository = createGitRepository();
  const prompts = [];
  const executor = ({ prompt, onOutput }) => {
    prompts.push(prompt);
    onOutput("stdout", "raw diagnostic output that must not be cached\n");
    for (const stage of FIXLAB_STAGES) {
      const summary =
        stage === "review" ? "token=must-not-be-cached" : `${stage} concise`;
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${summary}\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  async function runJob(label) {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: label,
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    assert.equal(started.response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  try {
    await runJob("first request is not cache content");
    assert.doesNotMatch(prompts[0], /Verified same-repository cache summary/);

    await runJob("second request is not cache content");
    assert.match(prompts[1], /Verified same-repository cache summary/);
    assert.match(prompts[1], /"result": "passed"/);

    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    writeFileSync(
      profilePath,
      JSON.stringify(validProfile({ name: "Changed profile" }))
    );
    await runJob("profile hash invalidation");
    assert.doesNotMatch(prompts[2], /Verified same-repository cache summary/);

    await runJob("changed profile cache hit");
    assert.match(prompts[3], /Verified same-repository cache summary/);

    writeFileSync(join(repository, "tracked.txt"), "changed HEAD\n");
    git(repository, ["add", "tracked.txt"]);
    git(repository, ["commit", "--quiet", "-m", "Change HEAD"]);
    await runJob("HEAD invalidation");
    assert.doesNotMatch(prompts[4], /Verified same-repository cache summary/);

    const cacheContext = createCacheContext(repository);
    const cacheContent = readFileSync(cacheContext.cachePath, "utf8");
    const cache = JSON.parse(cacheContent);
    assert.ok(Buffer.byteLength(cacheContent) <= MAX_CACHE_BYTES);
    assert.ok(cache.entries.length <= MAX_CACHE_ENTRIES);
    assert.doesNotMatch(cacheContent, /raw diagnostic output/);
    assert.doesNotMatch(cacheContent, /first request is not cache content/);
    assert.doesNotMatch(cacheContent, /must-not-be-cached/);
    assert.match(cacheContent, /review: passed/);
    assert.doesNotMatch(cacheContent, /concise/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard gate execution rejects forged readiness and stale final-source evidence", async () => {
  const repository = createGitRepository();
  const profilePath = join(repository, ".github", "fixlab", "repository-profile.json");
  writeFileSync(profilePath, JSON.stringify(validProfile({
    validation: {
      gates: [{
        id: "focused-tests",
        command: process.execPath,
        args: ["--test", "focused.test.cjs"],
        workingDirectory: ".",
        reuse: true,
        timeoutSeconds: 30
      }]
    }
  })));
  writeFileSync(join(repository, "focused.test.cjs"),
    "const test=require('node:test');for(let i=0;i<1000;i++)test('check '+i,()=>{});\n");
  let finish;
  let emit;
  let prompt;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    prompt = input.prompt;
    emit = input.onOutput;
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 130 }); }
    };
  });
  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Check focused behavior.", mode: "validate-only" })
    });
    assert.equal(started.response.status, 202);
    const jobId = started.body.job.id;
    assert.match(prompt, /gate --port \d+ --job/);
    assert.match(prompt, /Required gate IDs: focused-tests/);
    for (const stage of FIXLAB_STAGES) {
      emit("stdout", `FIXLAB_STAGE|${stage}|passed|claimed success\n`);
    }
    let status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.pullRequestReadiness.ready, false);
    const run = (overrides = {}, headers = {}) => jsonRequest(url, "/api/validation/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jobId, gateId: "focused-tests", repository, ...overrides })
    });
    assert.equal((await run({ jobId: "different-job" })).response.status, 400);
    assert.equal((await run({ gateId: "invented-gate" })).response.status, 400);
    assert.equal((await run({}, { Origin: "https://example.com" })).response.status, 400);
    const result = await run();
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, 0);
    assert.match(result.body.summary, /1000 passed/);
    status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.validation.status, "passed");
    assert.ok(status.body.job.validation.gates[0].context.reductionPercent > 90);
    assert.ok(Buffer.byteLength(result.body.summary) < 2000);
    let output = "";
    const exitCode = await runValidationGate([
      "--port", new URL(url).port, "--job", jobId,
      "--gate", "focused-tests", "--repository", repository
    ], { stdout: { write(text) { output += text; } }, stderr: { write(text) { output += text; } } });
    assert.equal(exitCode, 0);
    assert.match(output, /unchanged job-local evidence reused/);
    writeFileSync(join(repository, "tracked.txt"), "edited after validation\n");
    finish({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.status, "blocked");
    assert.equal(status.body.job.validation.gates[0].status, "stale");
    assert.equal(status.body.job.pullRequestReadiness.ready, false);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard PR strategies publish after local gates without waiting for remote CI", () => {
  for (const pullRequestStrategy of ["per-bug", "common"]) {
    const prompt = buildJobPrompt({
      request: "Fix the reported behavior.",
      mode: "fix-and-validate",
      requestType: "bug-fix",
      pullRequestStrategy
    });
    assert.match(prompt, /required local validation and approval gates/);
    assert.match(prompt, /publish the authorized PR by marking it ready for review/);
    assert.match(prompt, /Do not wait for remote PR CI or build completion before publication/);
    assert.match(prompt, /Verify the PR is no longer draft before reporting the PR stage passed/);
    assert.match(prompt, /Report remote checks as pending, not passed, and leave merge policies intact/);
    assert.match(prompt, /If publication or state verification fails, report the PR stage blocked or failed/);
    assert.match(prompt, /gh pr ready <number>/);
    assert.match(prompt, /az repos pr update --id <id> --draft false/);
  }
});

test("validate-only prompt prohibits repository changes", () => {
  const prompt = buildJobPrompt({
    request: "Check the current behavior.",
    mode: "validate-only",
    requestType: "bug-fix"
  });

  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /create commits/);
  assert.match(prompt, /create pull requests/);
  assert.match(prompt, /without creating or updating a pull request/);
  assert.match(prompt, /fix and pr stages must be explicitly skipped/);
  assert.match(prompt, /FIXLAB_ACTIVITY\|stage\|summary/);
  assert.match(prompt, /not hidden chain-of-thought/);
  assert.match(prompt, /Do not publish a pull request or change its draft status in read-only mode/);
  assert.doesNotMatch(prompt, /publish the authorized PR by marking it ready for review/);
  assert.doesNotMatch(prompt, /gh pr ready|az repos pr update/);
});

test("selected non-production data falls back to synthetic only when required", () => {
  const prompt = buildJobPrompt({
    request: "Validate result rendering against DEV data.",
    mode: "validate-only",
    requestType: "bug-fix",
    targetEnvironment: "dev",
    testEvidence: {
      enabled: true,
      source: "non-production-read-only",
      mutationMode: "intercepted",
      requireScenarioEvidence: true
    }
  });

  assert.match(prompt, /Use the selected dev backend and API as the primary/);
  assert.match(prompt, /Do not fulfill or intercept business-data reads while the selected backend is available/);
  assert.match(prompt, /returns no safe records capable of exercising/);
  assert.match(prompt, /fall back to synthetic-intercepted data/);
  assert.match(prompt, /Do not replace an expected empty-state assertion with synthetic data/);
  assert.match(prompt, /FIXLAB_TEST with source synthetic-intercepted and mutation mode intercepted/);
  assert.match(prompt, /A synthetic pass proves the UI behavior only/);
  assert.match(prompt, /do not claim the selected backend or its data was validated/);
});

test("backend-first prompt guidance requires environment and read-only source", () => {
  const withoutEnvironment = buildJobPrompt({
    request: "Validate result rendering.",
    mode: "validate-only",
    requestType: "bug-fix",
    testEvidence: {
      enabled: true,
      source: "non-production-read-only",
      mutationMode: "intercepted",
      requireScenarioEvidence: true
    }
  });
  assert.doesNotMatch(
    withoutEnvironment,
    /backend and API as the primary business-data source/
  );

  const withoutReadOnlySource = buildJobPrompt({
    request: "Validate result rendering against DEV data.",
    mode: "validate-only",
    requestType: "bug-fix",
    targetEnvironment: "dev",
    testEvidence: {
      enabled: true,
      source: "profile-defined",
      mutationMode: "profile-defined",
      requireScenarioEvidence: true
    }
  });
  assert.doesNotMatch(
    withoutReadOnlySource,
    /backend and API as the primary business-data source/
  );
});

test("dashboard rejects validation environments outside the profile allowlist", async () => {
  const repository = createRepository();
  const { dashboard, url } = await startDashboard(repository, () => {
    throw new Error("executor should not run");
  });

  try {
    for (const targetEnvironment of ["uat", "production"]) {
      const result = await jsonRequest(url, "/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: "Validate the selected environment.",
          mode: "playwright-only",
          targetEnvironment
        })
      });
      assert.equal(result.response.status, 400);
      assert.match(result.body.error, /targetEnvironment/);
    }
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("playwright-only prompt skips review and runs only required browser steps", () => {
  const prompt = buildJobPrompt({
    request: "Validate the Hold option in the browser.",
    mode: "playwright-only",
    requestType: "bug-fix"
  });

  assert.match(prompt, /Run a FixLab playwright-only job/);
  assert.match(prompt, /^FixLab output protocol/);
  assert.match(prompt, /Never defer or batch stage markers/);
  assert.match(prompt, /minimum setup required by the repository profile/);
  assert.match(prompt, /verify browser authentication/);
  assert.match(prompt, /focused Playwright journey/);
  assert.match(prompt, /Skip source diagnosis, separate reproduction, implementation, diff review/);
  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /Do not reinstall dependencies that are already available/);
  assert.match(
    prompt,
    /diagnosis, reproduce, fix, review, and pr stages must be explicitly skipped/
  );
});

test("small-enhancement prompt uses the risk-scaled fast path", () => {
  const prompt = buildJobPrompt({
    request: "Add a compact optional label.",
    mode: "fix-and-validate",
    requestType: "small-enhancement"
  });

  assert.match(prompt, /Request type: small-enhancement/);
  assert.match(prompt, /concise acceptance contract/);
  assert.match(prompt, /affected surface/);
  assert.match(prompt, /Do not manufacture a failing defect reproduction/);
  assert.match(prompt, /smallest existing focused test/);
  assert.match(prompt, /Skip broad test suites and full builds/);
  assert.match(prompt, /review, live-test, and pull-request evidence/);
  assert.match(prompt, /make no unrelated changes/);
});
