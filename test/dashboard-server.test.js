import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  buildAgencyInvocation,
  buildCopilotInvocation,
  buildJobPrompt,
  createCacheContext,
  createDashboardServer,
  FIXLAB_STAGES,
  MAX_CACHE_BYTES,
  MAX_CACHE_ENTRIES,
  MAX_JOB_LOG_ENTRIES
} from "../dashboard/server.js";

const packageRoot = new URL("..", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1"
);

test("Agency executor keeps long prompts out of process arguments", () => {
  const prompt = `Fix this batch:\n${"x".repeat(40000)}`;
  const invocation = buildAgencyInvocation({
    packageRoot: "C:\\FixLab",
    prompt,
    sessionId: "11111111-1111-4111-8111-111111111111"
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
      "fixlab"
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
    JSON.stringify({ name: "Dashboard test repository" })
  );
  return repository;
}

function git(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
}

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

async function startDashboard(repository, executor, workItemLoader) {
  const dashboard = createDashboardServer({
    repository,
    packageRoot,
    executor,
    ...(workItemLoader ? { workItemLoader } : {})
  });
  const address = await dashboard.listen({ port: await availablePort() });
  return { dashboard, url: address.url };
}

async function jsonRequest(url, path, options) {
  const response = await fetch(`${url}${path}`, options);
  return { response, body: await response.json() };
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
    JSON.stringify({
      name: "ADO intake repository",
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    })
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
  const executor = ({ prompt, onOutput }) => {
    receivedPrompt = prompt;
    onOutput(
      "stdout",
      "FIXLAB_BUG|71|external|MDG|MDG owns the rejected request; no repository change is required.\n"
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
  const repository = createRepository();
  const workItemLoader = async () => {
    throw new Error("single-item loader should not run");
  };
  workItemLoader.loadMany = async ({ workItems }) =>
    workItems.map((value) => ({
      id: Number(value),
      title: `Loaded bug ${value}`,
      description: "",
      reproduction: "",
      acceptanceCriteria: "",
      state: "Active",
      workItemType: "Bug",
      webUrl: `https://dev.azure.com/example/project/_workitems/edit/${value}`
    }));
  const executor = ({ onOutput }) => {
    for (const id of ["101", "202"]) {
      onOutput(
        "stdout",
        `FIXLAB_BUG|${id}|no-change|FMDM|No repository change is required.\n`
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
    workItemLoader
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

    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request:
          "Azure DevOps Bug 101: First bug\n\nAzure DevOps Bug 202: Second bug",
        mode: "fix-and-validate",
        intakeSource: "azure-devops",
        workItems: loaded.body.workItems
      })
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.job.workItems.length, 2);
    assert.equal("description" in started.body.job.workItems[0], false);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.status, "passed");
    assert.deepEqual(
      completed.body.job.bugs.map((bug) => bug.id),
      ["101", "202"]
    );
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
      "FIXLAB_BUG|17037209|external|MDG|MDG rejected parent validation and FMDM surfaced the returned error.\n"
    );
    onOutput(
      "stdout",
      "FIXLAB_BUG|17032997|fixed|FMDM|Generation status displays the generated object type.\n"
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
        mode: "fix-and-validate"
      })
    });
    assert.equal(started.response.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");
    assert.equal(result.body.job.status, "passed");
    assert.equal(result.body.job.error, null);
    assert.equal(result.body.job.requestType, "bug-fix");
    assert.deepEqual(result.body.job.bugs, [
      {
        id: "17037209",
        title: "Remap failed",
        url: "https://dev.azure.com/example/project/_workitems/edit/17037209",
        outcome: "external",
        owner: "MDG",
        summary:
          "MDG rejected parent validation and FMDM surfaced the returned error."
      },
      {
        id: "17032997",
        title: "Generic generation status",
        url: "",
        outcome: "fixed",
        owner: "FMDM",
        summary: "Generation status displays the generated object type."
      }
    ]);
    assert.match(receivedPrompt, /Read \.github\/fixlab\/repository-profile\.json/i);
    assert.match(receivedPrompt, /smallest complete change/i);
    assert.match(receivedPrompt, /Make no code change/i);
    assert.match(receivedPrompt, /self-review the effective diff/i);
    assert.match(receivedPrompt, /tests, type-checks, and builds/i);
    assert.match(receivedPrompt, /applications defined by the repository profile/i);
    assert.match(receivedPrompt, /repository-defined live test/i);
    assert.match(
      receivedPrompt,
      /save at least one non-sensitive screenshot/i
    );
    assert.match(receivedPrompt, /Do not invent or hardcode environment choices/i);
    assert.match(receivedPrompt, /Create or update the pull request only after all required gates pass/i);
    assert.match(receivedPrompt, /authentication, unsafe-data approval/i);
    assert.match(receivedPrompt, /git status and effective diff/i);
    assert.match(receivedPrompt, /task-relevant symbols and files/i);
    assert.match(receivedPrompt, /Reuse this job\/session context/i);
    assert.match(receivedPrompt, /Do not reread unchanged files/i);
    assert.match(receivedPrompt, /reinstall available dependencies/i);
    assert.match(receivedPrompt, /commit changes and repository-profile or instruction changes as invalidation boundaries/i);
    assert.match(receivedPrompt, /do not feed unbounded raw output back into prompts/i);
    assert.match(receivedPrompt, /FIXLAB_STAGE\|stage\|status\|message/);
    assert.match(receivedPrompt, /FIXLAB_BUG\|id\|outcome\|owner\|summary/);
    assert.match(receivedPrompt, /required machine-readable output/);
    assert.match(receivedPrompt, /before the terminal pr stage/);
    assert.match(
      receivedPrompt,
      /Do not call task_complete or return the final response/
    );
    assert.match(receivedPrompt, /external with owner MDG/);
    assert.match(receivedPrompt, /Do not create an empty pull request/);
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
        mode: "validate-only"
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
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  writeFileSync(
    profilePath,
    JSON.stringify({
      name: "Playwright authentication repository",
      browserAutomation: {
        workingDirectory: ".",
        authentication: {
          command: "node playwright-auth.js",
          statusPaths: ["e2e/.auth/user.json"]
        }
      }
    })
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
  const { dashboard, url } = await startDashboard(
    repository,
    () => ({ completion: new Promise(() => {}), terminate() {} })
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await jsonRequest(url, "/api/playwright/status");
      if (!status.body.running) {
        break;
      }
    }
    assert.equal(status.body.ready, true);
    assert.equal(status.body.lastResult.ok, true);
    assert.equal(status.body.paths[0].path, "e2e/.auth/user.json");

    const job = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Capture browser evidence.",
        requestType: "bug-fix",
        mode: "playwright-only"
      })
    });
    assert.equal(job.response.status, 202);
    mkdirSync(screenshotDirectory, { recursive: true });
    writeFileSync(
      join(screenshotDirectory, "hold-option.png"),
      screenshot
    );
    const artifacts = await jsonRequest(
      url,
      `/api/playwright/artifacts?jobId=${job.body.job.id}`
    );
    assert.equal(artifacts.response.status, 200);
    assert.equal(artifacts.body.artifacts.length, 1);
    assert.equal(artifacts.body.artifacts[0].name, "hold-option.png");
    assert.match(
      artifacts.body.artifacts[0].relativePath,
      /test-results[\\/]hold-option\.png/
    );
    const image = await fetch(
      `${url}${artifacts.body.artifacts[0].url}`
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), screenshot);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

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
    rmSync(repository, { recursive: true, force: true });
  }
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

test("dashboard bounds retained raw logs while preserving stage summaries", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (let index = 0; index < MAX_JOB_LOG_ENTRIES + 20; index += 1) {
      onOutput("stdout", `diagnostic line ${index}\n`);
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
        request: "Exercise bounded logging.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");

    assert.equal(result.body.job.status, "passed");
    assert.equal(result.body.job.logs.length, MAX_JOB_LOG_ENTRIES);
    assert.equal(result.body.job.droppedLogs, 28);
    assert.equal(result.body.job.stages.pr.message, "pr summary");
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
    writeFileSync(profilePath, JSON.stringify({ name: "Changed profile" }));
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
    assert.match(cacheContent, /omitted potentially sensitive summary/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
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
});

test("playwright-only prompt skips review and runs only required browser steps", () => {
  const prompt = buildJobPrompt({
    request: "Validate the Hold option in the browser.",
    mode: "playwright-only",
    requestType: "bug-fix"
  });

  assert.match(prompt, /Run a FixLab playwright-only job/);
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
