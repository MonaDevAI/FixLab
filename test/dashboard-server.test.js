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
import { join } from "node:path";
import test from "node:test";
import {
  buildAgencyInvocation,
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
    prompt
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
  assert.deepEqual(invocation.args.slice(-4), [
    "--allow-all-tools",
    "--no-ask-user",
    "--stream",
    "on"
  ]);
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
    assert.match(receivedPrompt, /Azure DevOps work item/);
    assert.match(receivedPrompt, /Do not search for or download Azure DevOps attachments/);

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
    assert.match(receivedPrompt, /external with owner MDG/);
    assert.match(receivedPrompt, /Do not create an empty pull request/);
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

test("dashboard rejects concurrent and invalid job starts", async () => {
  const repository = createRepository();
  let resolveJob;
  const completion = new Promise((resolve) => {
    resolveJob = resolve;
  });
  const executor = () => ({ completion, terminate() {} });
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
        mode: "validate-only"
      })
    });
    assert.equal(first.response.status, 202);

    const second = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "This job must be rejected.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    assert.equal(second.response.status, 409);
    assert.match(second.body.error, /already running/);
  } finally {
    resolveJob({ code: 1 });
    await dashboard.close();
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
