import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createPortProbe } from "node:net";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const packageRoot = process.env.FIXLAB_TEST_PACKAGE_ROOT ??
  fileURLToPath(new URL("..", import.meta.url));
const { createDashboardServer } = await import(
  pathToFileURL(join(packageRoot, "dashboard", "server.js")).href
);
const { createRuntimeRequestBridge, runtimePermissionPrompt, runtimeQuestionPrompt } = await import(
  pathToFileURL(join(packageRoot, "dashboard", "runtime-requests.js")).href
);
let repository;
let dashboard;
let baseUrl;

async function openWorkflowControls(page, url) {
  await page.goto(url);
  await page.locator('.workspace-navigation [data-open="details-group"]').click();
  for (const id of ["run-options", "details-group", "connections-group", "settings-group"]) {
    if (await page.locator(`#${id}`).getAttribute("open") === null) {
      await page.locator(`#${id} > summary`).click();
    }
  }
}

async function availablePort() {
  const probe = createPortProbe();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function executor({ onOutput }) {
  onOutput(
    "stdout",
    "Tracing the affected workflow to diagnose the reported behavior.\n"
  );
  const completion = new Promise((resolve) => {
    setTimeout(() => {
      for (const stage of [
        "intake",
        "diagnosis",
        "reproduce",
        "fix",
        "review",
        "local-stack",
        "live-test",
        "pr"
      ]) {
        onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|done\n`);
      }
      onOutput(
        "stdout",
        "FIXLAB_TEST|synthetic-intercepted|intercepted|Validate the pasted screenshot with local synthetic API data.\n"
      );
      onOutput(
        "stdout",
        "Tokens ↑ 2.4m (1.9m cached, 367.4k written) • ↓ 14.8k\n"
      );
      resolve({ code: 0 });
    }, 500);
  });
  return {
    completion,
    stop() {}
  };
}

const loadedPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]).toString("base64");

const workItemLoader = async () => ({
  id: 123,
  title: "Loaded browser bug",
  state: "Active",
  workItemType: "Bug",
  webUrl:
    "https://dev.azure.com/example/Example/_workitems/edit/123",
  comments: [],
  screenshots: [
    {
      name: "123-bug.png",
      mimeType: "image/png",
      base64: loadedPng
    }
  ]
});
workItemLoader.loadMany = async () => [await workItemLoader()];

test.beforeAll(async () => {
  repository = mkdtempSync(join(tmpdir(), "fixlab-e2e-"));
  const profileDirectory = join(repository, ".github", "fixlab");
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(
    join(profileDirectory, "repository-profile.json"),
    JSON.stringify({
      name: "E2E repository",
      workflow: { mode: "strict" },
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
      environments: ["local", "dev", "sit"]
    })
  );

  dashboard = createDashboardServer({
    repository,
    packageRoot,
    executor,
    browserOpener() {},
    workItemLoader
  });
  baseUrl = (await dashboard.listen({ port: await availablePort() })).url;
});

test.afterAll(async () => {
  await dashboard.close();
  rmSync(repository, { recursive: true, force: true });
});

test("dashboard submits per-run interception without optional folder preflight", async ({ page }) => {
  let submitted;
  await page.route("**/api/jobs", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json", status: 202,
      body: JSON.stringify({
        job: {
          id: "per-run-interception-job", requestType: "bug-fix",
          request: "Synthetic per-run interception scenario.", mode: "playwright-only",
          status: "running", stages: {}, bugs: [], logs: [],
          canComment: true, inputCount: 0, pendingInputCount: 0,
          testEvidence: { source: "synthetic-intercepted", mutationMode: "intercepted" }
        },
        queue: [], history: []
      })
    });
  });
  await openWorkflowControls(page, baseUrl);
  await expect(page.locator('input[name="permissionPreflight"]')).toHaveCount(0);
  await page.locator("#request").fill("Synthetic per-run interception scenario.");
  await page.locator("input[name=mode][value=playwright-only]").check();
  await page.locator("#job-test-mutation-mode").selectOption("intercepted");
  await page.locator("#start-button").click();
  await expect.poll(() => submitted?.testMutationMode).toBe("intercepted");
  expect(submitted.mode).toBe("playwright-only");
  expect(submitted.permissionPreflight).toBeUndefined();
  await page.locator("#job-test-mutation-mode").selectOption("none");
  await expect(page.locator("#job-test-mutation-mode")).toHaveValue("none");
});

test("Allow all is default-off, confirms submission and is cleared for the next job", async ({ page }) => {
  const posts = [];
  await mockChatWorkspace(page);
  await page.route("**/api/jobs", async (route) => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/json", status: 202,
      body: JSON.stringify({
        job: { id: "synthetic-allow-all", request: "Synthetic explicit tool approval.",
          mode: "validate-only", status: "running", stages: {}, bugs: [], logs: [], activity: [] },
        queue: [], history: []
      })
    });
  });
  await openWorkflowControls(page, baseUrl);
  const option = page.locator('input[name="allowAllTools"]');
  await expect(option).not.toBeChecked();
  await page.locator("#request").fill("Synthetic explicit tool approval.");
  await page.locator('input[name="mode"][value="validate-only"]').check();
  await option.check();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#start-button").click();
  expect(posts).toEqual([]);
  await expect(page.locator("#start-button")).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#start-button").click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].toolApprovalMode).toBe("allow-all");
  expect(posts[0].allowAllConfirmed).toBe(true);
  await expect(option).not.toBeChecked();
});

test("live Allow all requires confirmation and is absent without an offered capability", async ({ page }) => {
  const job = pendingApprovalJob(["npm test"]);
  job.runtimeRequests[0].canAllowAll = true;
  const posts = [];
  await mockChatWorkspace(page, { job });
  await page.route("**/api/job/runtime-response", async (route) => {
    posts.push(route.request().postDataJSON());
    job.runtimeRequests = [];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job }) });
  });
  await page.goto(baseUrl);
  const allow = page.getByRole("button", { name: "Allow all for this run", exact: true });
  await expect(allow).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await allow.click();
  expect(posts).toEqual([]);
  page.once("dialog", (dialog) => dialog.accept());
  await allow.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    instanceId: "workspace-owner", jobId: job.id, requestId: expect.any(String),
    confirmed: true, action: "allow", scope: "all-tools", answer: ""
  });
  job.runtimeRequests = pendingApprovalJob(["npm run build"]).runtimeRequests;
  await page.reload();
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect(allow).toHaveCount(0);
});

test("chat composer replies answer the current question instead of creating another job", async ({ page }) => {
  const job = pendingQuestionJob("Which synthetic request should be inspected?");
  const questionId = job.runtimeRequests[0].id;
  const answers = [];
  const newJobs = [];
  await mockChatWorkspace(page, { job });
  await page.route("**/api/jobs", async (route) => {
    newJobs.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job, queue: [], history: [] }) });
  });
  await page.route("**/api/job/runtime-response", async (route) => {
    answers.push(route.request().postDataJSON());
    job.runtimeRequests = [];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job }) });
  });
  await page.goto(baseUrl);
  await expect(page.locator("#runtime-request-panel")).toBeVisible();
  await page.locator("#request").fill("SYNTHETIC-42");
  await page.locator("#start-button").click();
  await expect.poll(() => answers.length + newJobs.length).toBe(1);
  expect(newJobs).toEqual([]);
  expect(answers).toHaveLength(1);
  expect(answers[0]).toEqual({
    instanceId: "workspace-owner", jobId: job.id, requestId: questionId,
    confirmed: true, action: "answer", answer: "SYNTHETIC-42"
  });
  await expect(page.locator("#request")).toHaveValue("");
  await expect(page.locator("#composer-reply-result")).toContainText("Reply sent to the current run");
});

test("chat composer keeps a rejected reply and never falls back to starting a job", async ({ page }) => {
  const job = pendingQuestionJob("Which synthetic request should be inspected?");
  const posts = [];
  await mockChatWorkspace(page, { job });
  page.on("request", (request) => { if (request.method() === "POST") { posts.push(request.url()); } });
  await page.route("**/api/job/runtime-response", (route) => route.fulfill({
    status: 409, contentType: "application/json",
    body: JSON.stringify({ error: "The question changed. Review the current request." })
  }));
  await page.goto(baseUrl);
  await expect(page.locator("#start-button")).toHaveText("Send reply");
  await page.locator("#request").fill("SYNTHETIC-42");
  await page.locator("#start-button").click();
  await expect(page.locator("#composer-reply-result")).toContainText("The question changed");
  await expect(page.locator("#request")).toHaveValue("SYNTHETIC-42");
  await expect(page.locator("#start-button")).toBeEnabled();
  expect(posts).toEqual([`${baseUrl}/api/job/runtime-response`]);
});

test("chat composer clears an unsent reply when the question identity changes", async ({ page }) => {
  const job = pendingQuestionJob("First synthetic question?");
  const posts = [];
  await mockChatWorkspace(page, { job });
  page.on("request", (request) => { if (request.method() === "POST") { posts.push(request.url()); } });
  await page.goto(baseUrl);
  await expect(page.locator("#start-button")).toHaveText("Send reply");
  await page.locator("#request").fill("An answer meant only for the first question.");
  job.runtimeRequests = pendingQuestionJob("Different synthetic question?").runtimeRequests;
  await expect(page.locator("#composer-question")).toHaveText("Different synthetic question?");
  await expect(page.locator("#request")).toHaveValue("");
  await expect(page.locator("#composer-reply-result")).toContainText("unsent reply was cleared");
  expect(posts).toEqual([]);
});

test("new conversation still queues a job rather than answering a pending question", async ({ page }) => {
  const job = pendingQuestionJob("Which synthetic request should be inspected?");
  const newJobs = [];
  const answers = [];
  await mockChatWorkspace(page, { job });
  await page.route("**/api/jobs", async (route) => {
    newJobs.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job, queue: [], history: [] }) });
  });
  await page.route("**/api/job/runtime-response", async (route) => {
    answers.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job }) });
  });
  await page.goto(baseUrl);
  await expect(page.locator("#start-button")).toHaveText("Send reply");
  await page.locator("#new-conversation").click();
  await expect(page.locator("#start-button")).toHaveText("Add to queue");
  await expect(page.locator("#request")).toHaveAttribute("maxlength", "10000");
  await page.locator("#request").fill("A separate synthetic investigation.");
  await page.locator("#start-button").click();
  await expect.poll(() => newJobs.length).toBe(1);
  expect(newJobs[0].request).toBe("A separate synthetic investigation.");
  expect(answers).toEqual([]);
});

test("runtime guidance distinguishes Allow all exceptions from questions", async ({ page }) => {
  const job = pendingApprovalJob(["Synthetic prerequisite check"]);
  job.toolApprovalMode = "allow-all";
  await mockChatWorkspace(page, { job });
  await page.goto(baseUrl);
  await expect(page.locator("#runtime-request-guidance")).toContainText("Allow all is active");
  await expect(page.locator("#runtime-request-guidance")).toContainText("not eligible for automatic approval");
  await expect(page.getByRole("button", { name: "Allow all for this run", exact: true })).toHaveCount(0);
  job.runtimeRequests = pendingQuestionJob("Which synthetic request should be inspected?").runtimeRequests;
  await expect(page.locator("#runtime-request-guidance")).toContainText("question, not a tool permission");
  await expect(page.locator("#runtime-request-guidance")).toContainText("Allow all never supplies answers");
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
});

test("native Copilot prompts allow once, deny and answer choices in the same live job", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "fixlab-native-ui-"));
  mkdirSync(join(directory, ".github", "fixlab"), { recursive: true });
  writeFileSync(join(directory, ".github", "fixlab", "repository-profile.json"),
    readFileSync(join(repository, ".github", "fixlab", "repository-profile.json")));
  let bridge;
  let launches = 0;
  let incomingPermission = null;
  const sent = [];
  const instance = createDashboardServer({
    repository: directory, packageRoot, runtime: "copilot", browserOpener() {},
    executor({ onRuntimeRequests }) {
      launches++;
      bridge = createRuntimeRequestBridge({
        send(message) {
          sent.push(message);
          if (message.action === "allow" && incomingPermission) {
            const incoming = incomingPermission;
            incomingPermission = null;
            bridge.receive(incoming);
          }
        },
        onChange: onRuntimeRequests
      });
      let finish;
      return {
        completion: new Promise((resolve) => { finish = resolve; }),
        respondToRuntimeRequest: (id, decision) => bridge.respond(id, decision),
        terminate() { bridge.cancel(); finish({ code: 130 }); },
        hasStopped: () => true
      };
    }
  });
  try {
    const address = await instance.listen({ port: await availablePort() });
    const created = await page.request.post(`${address.url}/api/jobs`, {
      data: { request: "Synthetic native prompt UI scenario.", mode: "validate-only" }
    });
    expect(created.status()).toBe(202);
    const permission = () => ({
      ...runtimePermissionPrompt({ kind: "shell", fullCommandText: "npm test" }), id: randomUUID()
    });
    bridge.receive(permission());
    await openWorkflowControls(page, address.url);
    await expect(page.locator("#job-status")).toContainText("waiting for your response");
    await expect(page.locator("#runtime-request-details")).toContainText("npm test");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect.poll(() => sent[0]?.action).toBe("allow");
    await expect(page.locator("#runtime-request-panel")).toBeHidden();

    bridge.receive(permission());
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect.poll(() => sent[1]?.action).toBe("deny");
    bridge.receive({
      ...runtimeQuestionPrompt({
        question: "Complete authentication in the normal browser, then select an option.",
        choices: ["Authentication complete", "Keep waiting"], allowFreeform: false
      }),
      id: randomUUID()
    });
    await page.getByRole("button", { name: "Authentication complete", exact: true }).click();
    await expect.poll(() => sent[2]?.answer).toBe("Authentication complete");
    expect(sent[2].wasFreeform).toBe(false);
    bridge.receive({
      ...runtimeQuestionPrompt({ question: "Which synthetic scenario should run?" }), id: randomUUID()
    });
    await page.locator("#runtime-request-answer").fill("Selected synthetic scenario");
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect.poll(() => sent[3]?.answer).toBe("Selected synthetic scenario");
    expect(sent[3].wasFreeform).toBe(true);
    bridge.receive({
      ...runtimePermissionPrompt({ kind: "unsupported-native-kind" }), id: randomUUID()
    });
    await expect(page.locator("#runtime-request-details")).toContainText("Approval is unavailable");
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect.poll(() => sent[4]?.action).toBe("deny");

    const first = { ...permission(), grantScope: "exact-test-command" };
    const second = {
      ...runtimePermissionPrompt({ kind: "shell", fullCommandText: "npm run build" }), id: randomUUID()
    };
    const unavailable = {
      ...runtimePermissionPrompt({ kind: "unsupported-native-kind" }), id: randomUUID()
    };
    const question = {
      ...runtimeQuestionPrompt({ question: "Which synthetic journey?", choices: ["First", "Second"] }), id: randomUUID()
    };
    for (const request of [first, second, unavailable, question]) {
      bridge.receive(request);
    }
    await expect(page.locator("#runtime-batch-summary")).toHaveText("Review all 2 pending permissions");
    await page.locator("#runtime-batch-summary").click();
    await expect(page.locator("#runtime-batch-requests")).toContainText("npm test");
    await expect(page.locator("#runtime-batch-requests")).toContainText("npm run build");
    await expect(page.locator("#runtime-batch-requests article")).toHaveCount(2);
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#runtime-allow-pending").click();
    expect(sent).toHaveLength(5);

    const arriving = permission();
    incomingPermission = arriving;
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#runtime-allow-pending").click();
    await expect(page.locator("#runtime-batch-result")).toHaveText(
      "Allowed 2 reviewed permission requests once. New requests still require approval."
    );
    expect(sent.slice(5)).toEqual([
      { type: "response", id: first.id, action: "allow" },
      { type: "response", id: second.id, action: "allow" }
    ]);
    const remaining = await (await page.request.get(`${address.url}/api/job`)).json();
    expect(remaining.job.runtimeRequests.map((request) => request.id)).toEqual([
      unavailable.id, question.id, arriving.id
    ]);
    expect(launches).toBe(1);
    bridge.cancel(false);
    for (const [grantScope, label] of [
      ["exact-test-command", "Allow this test command for this job"],
      ["repository-reads", "Allow repository-file reads for this job"]
    ]) {
      const request = {
        ...runtimePermissionPrompt(grantScope === "repository-reads"
          ? { kind: "read", path: "src/example.ts" }
          : { kind: "shell", fullCommandText: "npm test" }),
        id: randomUUID(), grantScope
      };
      bridge.receive(request);
      const count = sent.length;
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.getByRole("button", { name: label, exact: true }).click();
      expect(sent).toHaveLength(count);
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect.poll(() => sent.at(-1)?.scope).toBe(grantScope);
      expect(sent.at(-1)).toEqual({
        type: "response", id: request.id, action: "allow", scope: grantScope
      });
    }
  } finally {
    await instance.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Copilot file trust requires a stopped exact job and a separate confirmation without resuming", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "fixlab-file-trust-ui-"));
  mkdirSync(join(directory, ".github", "fixlab"), { recursive: true });
  writeFileSync(join(directory, ".github", "fixlab", "repository-profile.json"),
    readFileSync(join(repository, ".github", "fixlab", "repository-profile.json")));
  let finish;
  let launches = 0;
  const instance = createDashboardServer({
    repository: directory, packageRoot, runtime: "copilot", browserOpener() {},
    executor() {
      launches++;
      return {
        completion: new Promise((resolve) => { finish = resolve; }),
        terminate() { finish({ code: 130 }); }, hasStopped: () => true
      };
    }
  });
  try {
    const address = await instance.listen({ port: await availablePort() });
    await openWorkflowControls(page, address.url);
    await page.locator("#request").fill("Synthetic reviewed source file trust.");
    await page.locator("#start-button").click();
    await expect(page.locator("#job-file-access-mode")).toHaveValue("manual");
    await expect(page.locator("#job-file-access-save")).toBeDisabled();
    finish({ code: 1 });
    await expect(page.locator("#job-file-access-save")).toBeEnabled();
    await page.locator("#job-file-access-mode").selectOption("source-read-write");
    await page.locator("#job-file-access-gates").check();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#job-file-access-save").click();
    expect((await (await page.request.get(`${address.url}/api/job`)).json()).job.fileAccess).toBeNull();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#job-file-access-save").click();
    await expect(page.locator("#job-file-access-message")).toContainText("this job only");
    await expect(page.locator("#job-file-access-summary")).toContainText("including resumes");
    expect((await (await page.request.get(`${address.url}/api/job`)).json()).job.fileAccess.mode).toBe("source-read-write");
    expect((await (await page.request.get(`${address.url}/api/job`)).json()).job.fileAccess.allowValidationGates).toBe(true);
    expect(launches).toBe(1);
    await page.reload();
    await openWorkflowControls(page, address.url);
    await expect(page.locator("#job-file-access-mode")).toHaveValue("source-read-write");
    await expect(page.locator("#job-file-access-gates")).toBeChecked();
    await page.locator("#job-file-access-mode").selectOption("manual");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#job-file-access-save").click();
    await expect(page.locator("#job-file-access-summary")).toContainText("Individual file approvals");
  } finally {
    await instance.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Show budget is unchecked by default and reveals usage and stopped-job controls without changing limits", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "fixlab-budget-ui-"));
  mkdirSync(join(directory, ".github", "fixlab"), { recursive: true });
  writeFileSync(join(directory, ".github", "fixlab", "repository-profile.json"),
    readFileSync(join(repository, ".github", "fixlab", "repository-profile.json")));
  let finish;
  let launches = 0;
  let selectedLimit;
  const instance = createDashboardServer({
    repository: directory, packageRoot, runtime: "copilot", browserOpener() {},
    executor(input) {
      launches++;
      selectedLimit = input.inputTokenLimit;
      input.onUsage({
        inputTokens: 110, cachedInputTokens: 90, cacheWriteTokens: 20,
        outputTokens: 5, cacheReusePercent: 90 / 110 * 100
      });
      input.onOutput("stdout", "Tokens \u2191 110 (90 cached, 20 written) \u2022 \u2193 5\n");
      return {
        completion: new Promise((resolve) => { finish = resolve; }),
        terminate() { finish({ code: 130 }); },
        hasStopped: () => true
      };
    }
  });
  try {
    const address = await instance.listen({ port: await availablePort() });
    await openWorkflowControls(page, address.url);
    await expect(page.locator("#show-input-budget")).not.toBeChecked();
    await expect(page.locator("#input-budget-control")).toBeHidden();
    await expect(page.locator("#job-budget-panel")).toBeHidden();
    await page.locator("#show-input-budget").check();
    await expect(page.locator("#input-budget-control")).toBeVisible();
    await expect(page.locator("#input-token-limit")).toHaveValue("0");
    await page.locator("#request").fill("Synthetic input budget browser scenario.");
    await page.locator("#input-token-limit").fill("100");
    await page.locator("#start-button").click();
    await expect.poll(() => selectedLimit).toBe(100);
    await expect(page.locator("#job-budget-summary")).toContainText("110 input tokens (90 cached; 20 uncached)");
    await expect(page.locator("#job-budget-save")).toBeDisabled();
    const error = new Error("Input-token ceiling reached.");
    error.code = "INPUT_TOKEN_LIMIT";
    finish({ code: null, error });
    await expect(page.locator("#job-budget-summary")).toContainText("Paused:");
    await expect(page.locator("#job-budget-save")).toBeEnabled();
    await page.locator("#job-budget-limit").fill("200");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#job-budget-save").click();
    const unchanged = await (await page.request.get(`${address.url}/api/job`)).json();
    expect(unchanged.job.inputTokenLimit).toBe(100);
    expect(unchanged.job.budgetExceeded).toBe(true);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#job-budget-save").click();
    await expect(page.locator("#job-budget-message")).toContainText("Usage is preserved; resume separately");
    await expect(page.locator("#job-budget-summary")).toContainText("Ceiling: 200");
    const updated = await (await page.request.get(`${address.url}/api/job`)).json();
    expect(updated.job.status).toBe("blocked");
    expect(updated.job.usage.inputTokens).toBe(110);
    expect(updated.job.inputTokenLimit).toBe(200);
    expect(launches).toBe(1);
    await page.locator("#show-input-budget").uncheck();
    await expect(page.locator("#job-budget-panel")).toBeHidden();
    await expect(page.locator("#input-budget-control")).toBeHidden();
    const hidden = await (await page.request.get(`${address.url}/api/job`)).json();
    expect(hidden.job.inputTokenLimit).toBe(200);
    expect(hidden.job.usage.inputTokens).toBe(110);
    await page.locator("#show-input-budget").check();
    await expect(page.locator("#job-budget-summary")).toContainText("Ceiling: 200");
  } finally {
    await instance.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const componentPolicy of [false, true]) {
test(`${componentPolicy ? "Component" : "API-only"} gates display not applicable and explicit full coverage still executes frontend tests`, async ({ page }) => {
  test.setTimeout(90_000);
  const scopedRepository = mkdtempSync(join(tmpdir(), "fixlab-api-scope-e2e-"));
  const directory = join(scopedRepository, ".github", "fixlab");
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(scopedRepository, "api"));
  const profile = JSON.parse(readFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), "utf8"));
  profile.validation = {
    apiOnly: {
      baseRef: "HEAD",
      paths: ["api"],
      fullValidationPaths: ["api/Contracts"],
      gateIds: ["backend-tests"]
    },
    gates: [
      { id: "backend-tests", command: process.execPath, args: ["-e", "process.exit(0)"], workingDirectory: ".", timeoutSeconds: 30 },
      { id: "frontend-tests", command: process.execPath, args: ["-e", "process.exit(23)"], workingDirectory: ".", timeoutSeconds: 30 }
    ]
  };
  if (componentPolicy) {
    profile.validation.changeAware = {
      baseRef: "HEAD",
      fullValidationPaths: ["api/Contracts"],
      scopes: [{ paths: ["api"], gateIds: ["backend-tests"] }]
    };
    delete profile.validation.apiOnly;
  }
  writeFileSync(join(directory, "repository-profile.json"), JSON.stringify(profile));
  writeFileSync(join(scopedRepository, "api", "service.cs"), "initial");
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: scopedRepository, encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
  };
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["-c", "user.name=FixLab Test", "-c", "user.email=fixlab@example.test", "commit", "--quiet", "-m", "fixture"]);
  let finish;
  let emit;
  const scopedDashboard = createDashboardServer({
    repository: scopedRepository,
    packageRoot,
    executor(input) {
      emit = input.onOutput;
      writeFileSync(join(scopedRepository, "api", "service.cs"), "corrected");
      return {
        completion: new Promise((resolve) => { finish = resolve; }),
        terminate() { finish({ code: 130 }); }
      };
    }
  });
  try {
    const address = await scopedDashboard.listen({ port: await availablePort() });
    await openWorkflowControls(page, address.url);
    await page.getByRole("radio", { name: "Validate only", exact: true }).check();
    const start = async (coverage) => {
      await page.getByLabel("Bug or required enhancement").fill("Verify internal API validation.");
      await page.getByLabel("Validation coverage").selectOption(coverage);
      const response = page.waitForResponse((result) =>
        result.url().endsWith("/api/jobs") && result.request().method() === "POST");
      await page.getByRole("button", { name: "Start job", exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(202);
      return (await result.json()).job.id;
    };
    const gate = async (jobId, gateId) => {
      const response = await page.request.post(`${address.url}/api/validation/run`, {
        data: { jobId, gateId, repository: scopedRepository }
      });
      expect(response.status()).toBe(200);
      return response.json();
    };
    const complete = () => {
      emit("stdout", "FIXLAB_TEST|synthetic-intercepted|intercepted|Verify API-scope dashboard labels.\n");
      for (const stage of ["intake", "diagnosis", "reproduce", "fix", "review", "local-stack", "live-test", "pr"]) {
        emit("stdout", `FIXLAB_STAGE|${stage}|passed|Verified applicable evidence\n`);
      }
      finish({ code: 0 });
    };
    const jobId = await start(componentPolicy ? "" : "affected");
    expect((await gate(jobId, "frontend-tests")).outcome).toBe("not-applicable");
    expect((await gate(jobId, "backend-tests")).status).toBe(0);
    complete();
    await expect(page.locator("#validation-summary")).toContainText(
      componentPolicy ? "Component-scope validation passed" : "API-scope validation passed");
    const frontend = page.locator("#validation-gates article").filter({ hasText: "frontend-tests" });
    await expect(frontend).toContainText("Not applicable");
    await expect(frontend).not.toContainText("passed");
    await expect(page.locator("#start-button")).toHaveText("Start job");
    const fullJobId = await start("full");
    expect((await gate(fullJobId, "frontend-tests")).status).toBe(23);
    complete();
    await expect(frontend).toContainText("failed");
    await expect(page.locator("#validation-summary")).not.toContainText("API-scope validation passed");
  } finally {
    await scopedDashboard.close();
    rmSync(scopedRepository, { recursive: true, force: true });
  }
});
}

test("explicit API pre-launch folder review starts no executor until the user explicitly approves", async ({ page }) => {
  const preflightRepository = mkdtempSync(join(tmpdir(), "fixlab-preflight-e2e-"));
  const external = mkdtempSync(join(tmpdir(), "fixlab-preflight-folder-e2e-"));
  const directory = join(preflightRepository, ".github", "fixlab");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "repository-profile.json"),
    readFileSync(join(repository, ".github", "fixlab", "repository-profile.json")));
  const calls = [];
  const preflightDashboard = createDashboardServer({
    repository: preflightRepository, packageRoot, runtime: "copilot",
    executor(input) {
      calls.push(input);
      let finish;
      return {
        completion: new Promise((resolve) => { finish = resolve; }),
        terminate() { finish({ code: 130 }); }
      };
    }
  });
  try {
    const address = await preflightDashboard.listen({ port: await availablePort() });
    const created = await page.request.post(`${address.url}/api/jobs`, {
      headers: { Origin: address.url },
      data: {
        request: "Review the required helper folder.", mode: "validate-only",
        targetEnvironment: "local", permissionPreflight: true
      }
    });
    expect(created.status()).toBe(202);
    await page.goto(address.url);
    await expect(page.locator("#permission-review")).toBeEnabled();
    await expect(page.locator("#permission-helper")).toContainText("Pre-launch review");
    expect(calls).toHaveLength(0);
    await page.getByLabel("Exact folder to review").fill(external);
    await page.getByRole("button", { name: "Review folder access" }).click();
    await expect(page.locator("#permission-scope")).toContainText(realpathSync(external));
    expect(calls).toHaveLength(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Grant this folder and start" }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].resume).toBe(false);
    expect(calls[0].runtimeDirectories).toEqual([realpathSync(external)]);
  } finally {
    await preflightDashboard.close();
    rmSync(preflightRepository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("runtime folder approval is reviewed and confirmed in the browser without another terminal", async ({ page }) => {
  const permissionRepository = mkdtempSync(join(tmpdir(), "fixlab-permission-e2e-"));
  const external = mkdtempSync(join(tmpdir(), "fixlab-permission-scope-e2e-"));
  const directory = join(permissionRepository, ".github", "fixlab");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "repository-profile.json"),
    readFileSync(join(repository, ".github", "fixlab", "repository-profile.json")));
  const calls = [];
  const permissionDashboard = createDashboardServer({
    repository: permissionRepository,
    packageRoot,
    runtime: "copilot",
    executor(input) {
      calls.push(input);
      if (calls.length % 2 === 1) {
        input.onOutput("stdout", "FIXLAB_STAGE|diagnosis|running|Inspecting startup.\n");
        input.onOutput("stdout", "Permission denied because no interactive user response was available.\n");
        let finish;
        return {
          completion: new Promise((resolve) => { finish = resolve; }),
          terminate() { finish({ code: null, signal: "SIGTERM" }); }
        };
      }
      input.onOutput("stdout", "FIXLAB_TEST|synthetic-intercepted|intercepted|Scoped runtime approval browser journey.\n");
      for (const stage of ["intake", "diagnosis", "reproduce", "fix", "review", "local-stack", "live-test", "pr"]) {
        input.onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|Verified after approved folder access.\n`);
      }
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    }
  });
  try {
    const address = await permissionDashboard.listen({ port: await availablePort() });
    await page.request.post(`${address.url}/api/jobs`, {
      data: { request: "Verify browser-only scoped runtime approval.", mode: "validate-only" }
    });
    await openWorkflowControls(page, address.url);
    await expect(page.getByRole("heading", { name: "Copilot permission required" })).toBeVisible();
    await expect(page.locator("#job-input-submit")).toBeHidden();
    await expect(page.locator("#permission-review")).toBeEnabled();
    await expect(page.locator("#permission-approve")).toBeHidden();
    await page.getByLabel("Exact folder to review").fill(external);
    await page.getByRole("button", { name: "Review folder access" }).click();
    await expect(page.locator("#permission-scope")).toContainText(realpathSync(external));
    await expect(page.locator("#permission-approve")).toBeVisible();
    expect(calls).toHaveLength(1);
    await page.getByLabel("Exact folder to review").fill(`${external}-changed`);
    await expect(page.locator("#permission-approve")).toBeHidden();
    await page.waitForTimeout(1200);
    await expect(page.locator("#permission-approve")).toBeHidden();
    await page.getByLabel("Exact folder to review").fill(external);
    await page.getByRole("button", { name: "Review folder access" }).click();
    await expect(page.locator("#permission-approve")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Grant this folder and resume" }).click();
    await expect(page.locator("#permission-panel")).toBeHidden();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1].runtimeDirectories).toEqual([realpathSync(external)]);
    expect(calls[1].sessionId).toBe(calls[0].sessionId);
    expect(calls[1].resume).toBe(true);
    await expect.poll(async () =>
      (await (await page.request.get(`${address.url}/api/job`)).json()).job.status
    ).toBe("passed");
    await page.request.post(`${address.url}/api/jobs`, {
      data: { request: "Dismiss an unresolved tool-policy blocker.", mode: "validate-only" }
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Copilot permission required" })).toBeVisible();
    await expect(page.locator("#job-input-submit")).toBeHidden();
    await expect(page.locator("#job-input-details")).toBeHidden();
    await page.request.post(`${address.url}/api/jobs`, {
      data: { request: "Continue the queue after safe dismissal.", mode: "validate-only" }
    });
    const dismiss = page.getByRole("button", { name: "Dismiss blocked job and continue queue" });
    await expect(dismiss).toBeVisible();
    await expect(dismiss).toBeEnabled();
    page.once("dialog", (dialog) => dialog.accept());
    await dismiss.click();
    await expect.poll(() => calls.length).toBe(4);
    expect(calls[3].runtimeDirectories).toEqual([]);
  } finally {
    await permissionDashboard.close();
    rmSync(permissionRepository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("Copilot model control honors configured defaults and explicit per-job selection", async ({ page }) => {
  const modelRepository = mkdtempSync(join(tmpdir(), "fixlab-model-e2e-"));
  const directory = join(modelRepository, ".github", "fixlab");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "repository-profile.json"),
    readFileSync(join(repository, ".github", "fixlab", "repository-profile.json")));
  let selectedModel;
  const modelDashboard = createDashboardServer({
    repository: modelRepository,
    packageRoot,
    runtime: "copilot",
    model: "claude-sonnet-4.5",
    executor(input) {
      selectedModel = input.model;
      return executor(input);
    },
    browserOpener() {}
  });
  try {
    const address = await modelDashboard.listen({ port: await availablePort() });
    await openWorkflowControls(page, address.url);
    await expect(page.locator("#model-control")).toBeVisible();
    await expect(page.locator("#model")).toHaveValue("claude-sonnet-4.5");
    await page.locator("#model").selectOption("hydrafusion");
    await page.locator("#request").fill("Verify the model is retained for this job.");
    await page.locator('input[name="mode"][value="validate-only"]').check();
    await page.locator("#start-button").click();
    await expect.poll(() => selectedModel).toBe("hydrafusion");
    await expect(page.locator("#model")).toHaveValue("hydrafusion");
    await expect(page.locator("#job-status")).toContainText("passed");
  } finally {
    await page.close();
    await modelDashboard.close();
    rmSync(modelRepository, { recursive: true, force: true });
  }
});

test("session controls reconnect, confirm another owner and resume its stopped job", async ({ page }) => {
  const sessionRepository = mkdtempSync(join(tmpdir(), "fixlab-session-e2e-"));
  const directory = join(sessionRepository, ".github", "fixlab");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "repository-profile.json"),
    readFileSync(join(repository, ".github", "fixlab", "repository-profile.json"))
  );
  let finish;
  let stops = 0;
  const calls = [];
  const owner = createDashboardServer({
    repository: sessionRepository,
    packageRoot,
    executor: (input) => {
      calls.push(input);
      return {
        completion: new Promise((resolve) => { finish = resolve; }),
        terminate() {
          stops += 1;
          finish({ code: null });
        }
      };
    }
  });
  const observer = createDashboardServer({
    repository: sessionRepository,
    packageRoot,
    executor: () => { throw new Error("only the owner can start the job"); }
  });
  try {
    const ownerUrl = (await owner.listen({ port: await availablePort() })).url;
    const observerUrl = (await observer.listen({ port: await availablePort() })).url;
    const started = await fetch(`${ownerUrl}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Resume this live session.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    expect(started.status).toBe(202);
    const identity = await (await fetch(`${ownerUrl}/api/session`)).json();
    await test.step("Opening the session observer", () => openWorkflowControls(page, observerUrl));
    const row = page.locator("#sessions-list article").filter({ hasText: identity.id });
    await expect(row).toContainText("Other FixLab dashboard");
    await expect(row.getByRole("link", { name: "Reconnect to live dashboard" }))
      .toHaveAttribute("href", ownerUrl);
    page.once("dialog", (dialog) => dialog.dismiss());
    await test.step("Cancelling the stop confirmation", () =>
      row.getByRole("button", { name: "Stop agent", exact: true }).click()
    );
    expect(stops).toBe(0);
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain(identity.id);
      return dialog.accept();
    });
    await test.step("Stopping the confirmed owner", async () => {
      await row.getByRole("button", { name: "Stop agent", exact: true }).click();
      await expect(row).toContainText("(blocked)");
    });
    expect(stops).toBe(1);
    await test.step("Resuming the stopped owner", async () => {
      await row.getByRole("button", { name: "Resume job", exact: true }).click();
      await expect(row).toContainText("(running)");
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].sessionId).toBe(calls[0].sessionId);
    expect(calls[1].resume).toBe(true);
    page.once("dialog", (dialog) => dialog.accept());
    await test.step("Shutting down the confirmed sessions", async () => {
      await row.getByRole("button", { name: "Shutdown sessions", exact: true }).click();
      await expect(row).toContainText("(blocked)");
    });
    expect(stops).toBe(2);
  } finally {
    await test.step("Closing the polling observer page", () => page.close());
    await test.step("Closing the owner dashboard", () => owner.close());
    await test.step("Closing the observer dashboard", () => observer.close());
    rmSync(sessionRepository, { recursive: true, force: true });
  }
});

test("dashboard exposes repository readiness through the running server", async ({
  page,
  request
}) => {
  const response = await request.get(`${baseUrl}/api/status`);

  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.readiness.repositoryReady).toBe(true);
  expect(body.readiness.profileReady).toBe(true);
  expect(body.readiness.profileName).toBe("E2E repository");
  expect(body.readiness.environments).toEqual(["local", "dev", "sit"]);

  await openWorkflowControls(page, baseUrl);
  await expect(page.locator("#target-environment option")).toHaveText([
    "Profile default",
    "LOCAL",
    "DEV",
    "SIT"
  ]);
  await expect(
    page.locator('input[name="recordPlaywrightVideo"]')
  ).toBeVisible();
});

test("dashboard exposes multi-bug intake and resumable user input", async ({
  page
}) => {
  await openWorkflowControls(page, baseUrl);

  await expect(
    page.getByRole("heading", { name: "Playwright authentication" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Azure DevOps intake (optional)", exact: true })
  ).toBeVisible();
  await page
    .getByLabel("Azure DevOps organization")
    .fill("example");
  await page.getByLabel("Azure DevOps project").fill("Example");
  await page
    .getByRole("button", { name: "Save onboarding settings" })
    .click();
  await expect(page.locator("#onboarding-message")).toContainText(
    "Numeric bug loading is ready"
  );
  await expect(
    page.getByRole("button", { name: "Check status" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Playwright" })
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", {
      name: /Playwright evidence/
    })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh evidence" })
  ).toBeVisible();
  await expect(
    page.getByLabel("Browser reproduction / result check only")
  ).toBeVisible();
  await expect(page.getByLabel("Create a separate PR per bug")).not.toBeChecked();
  await expect(
    page.getByLabel("Run UI tests for all scenarios at the end")
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Open React localhost for manual validation")
  ).not.toBeChecked();
  await page.getByLabel("Load from Azure DevOps").check();
  await expect(page.getByText("Load bugs")).toBeVisible();
  await expect(
    page.getByPlaceholder("123, 456, or one URL/ID per line")
  ).toBeVisible();
  await page
    .getByPlaceholder("123, 456, or one URL/ID per line")
    .fill("123");
  await page.getByRole("button", { name: "Load bugs" }).click();
  await expect(page.locator("#screenshot-list")).toContainText("123-bug.png");
  await expect(page.getByText("1 image(s)")).toBeVisible();
  await expect(page.getByText("Continue this job")).toBeHidden();
  await expect(page.getByText("Workflow statistics")).toBeVisible();
});

test("dashboard accepts pasted images and records exact usage metrics", async ({
  page,
  request
}) => {
  await openWorkflowControls(page, baseUrl);
  const requestField = page.getByLabel("Bug or required enhancement");
  const textPastePrevented = await requestField.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "ordinary text");
    return !element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer
      })
    );
  });
  expect(textPastePrevented).toBe(false);

  const imagePastePrevented = await page.locator("body").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [
          new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
          ])
        ],
        "clipboard.png",
        { type: "image/png" }
      )
    );
    return !element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer
      })
    );
  });
  expect(imagePastePrevented).toBe(true);
  await expect(page.locator("#screenshot-list")).toContainText("clipboard.png");
  await expect(page.locator("#screenshot-message")).toHaveText(
    "1 pasted screenshot(s) attached. 1 of 5 selected."
  );

  await requestField.fill("Validate pasted screenshot");
  await page.getByRole("button", { name: "Start job" }).click();
  await expect(page.locator(".stage.inferred")).toContainText(/diagnosis\s*active now/);
  await expect(page.locator("#job-status")).toContainText(
    "passed · bug-fix"
  );
  await expect(page.locator("#test-evidence")).toHaveClass(/reported/);
  await expect(page.locator("#test-evidence-scenario")).toContainText(
    "Validate the pasted screenshot"
  );
  await expect(page.locator("#test-data-source")).toHaveText(
    "Data: Synthetic Intercepted"
  );
  await expect(page.locator("#test-mutation-mode")).toHaveText(
    "Mutations: Intercepted"
  );

  const jobResponse = await request.get(`${baseUrl}/api/job`);
  const job = (await jobResponse.json()).job;
  expect(job.screenshots).toHaveLength(1);
  expect(job.usage).toEqual({
    inputTokens: 2_400_000,
    cachedInputTokens: 1_900_000,
    cacheWriteTokens: 367_400,
    outputTokens: 14_800,
    cacheReusePercent: 79.2
  });

  const metricsResponse = await request.get(
    `${baseUrl}/api/metrics?period=24h`
  );
  const metrics = (await metricsResponse.json()).metrics;
  expect(metrics.queued).toBe(1);
  expect(metrics.bugs).toBe(0);
  expect(metrics.completed).toBe(1);
  expect(metrics.totalInputTokens).toBe(2_400_000);
  expect(metrics.totalCachedInputTokens).toBe(1_900_000);
  expect(metrics.totalCacheWriteTokens).toBe(367_400);
  expect(metrics.totalOutputTokens).toBe(14_800);
  expect(metrics.cacheReusePercent).toBe(79.2);
  await expect(page.getByText("79.2%")).toBeVisible();
  await expect(page.getByText("2,400,000")).toBeHidden();
});

test("dashboard lets users select active and queued job roadmaps", async ({
  page
}) => {
  let cancelledBody;
  let cancelledJob;
  let cancellationObserved = false;
  await page.route("**/api/jobs/cancel", async (route) => {
    cancelledBody = route.request().postDataJSON();
    cancelledJob = {
      id: "queued-job",
      request: "Queued bug",
      requestType: "bug-fix",
      status: "cancelled",
      durationMs: 0,
      stages: {},
      bugs: [],
      logs: [],
      canComment: false,
      canResume: false,
      inputCount: 0,
      pendingInputCount: 0
    };
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          id: "active-job",
          request: "Active bug",
          requestType: "bug-fix",
          status: "running",
          durationMs: 1000,
          stages: {},
          bugs: [],
          logs: [],
          canComment: true,
          canResume: false,
          inputCount: 0,
          pendingInputCount: 0
        },
        cancelledJob,
        queue: [],
        history: [cancelledJob]
      })
    });
  });
  await page.route("**/api/status", async (route) => {
    cancellationObserved ||= Boolean(cancelledJob);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        readiness: {
          repository: "C:\\repo",
          repositoryReady: true,
          profileReady: true,
          profileName: "Queued jobs",
          error: null
        },
        job: {
          id: "active-job",
          request: "Active bug",
          requestType: "bug-fix",
          status: "running",
          durationMs: 1000,
          stages: Object.fromEntries(
            [
              "intake",
              "diagnosis",
              "reproduce",
              "fix",
              "review",
              "local-stack",
              "live-test",
              "pr"
            ].map((stage) => [
              stage,
              { status: "pending", message: "" }
            ])
          ),
          bugs: [],
          logs: [{ message: "Diagnosing the active bug." }],
          canComment: true,
          canResume: false,
          inputCount: 0,
          pendingInputCount: 0
        },
        queue: cancelledJob ? [] : [
          {
            id: "queued-job",
            position: 1,
            request:
              "Queued bug with enough reproduction details to require a compact preview in the job list while preserving the full text behind an explicit expand control for users who need to inspect all of the supplied evidence.",
            requestType: "bug-fix",
            mode: "playwright-only",
            status: "queued",
            bugCount: 1,
            screenshotCount: 0,
            stages: Object.fromEntries(
              [
                "intake",
                "diagnosis",
                "reproduce",
                "fix",
                "review",
                "local-stack",
                "live-test",
                "pr"
              ].map((stage) => [
                stage,
                { status: "pending", message: "" }
              ])
            ),
            bugs: []
          }
        ],
        history: [
          ...(cancelledJob ? [cancelledJob] : []),
          {
            id: "completed-job",
            request: "Completed bug",
            requestType: "bug-fix",
            status: "passed",
            durationMs: 2000,
            stages: Object.fromEntries(
              [
                "intake",
                "diagnosis",
                "reproduce",
                "fix",
                "review",
                "local-stack",
                "live-test",
                "pr"
              ].map((stage) => [
                stage,
                { status: "passed", message: "done" }
              ])
            ),
            bugs: [],
            logs: [],
            canComment: false,
            canResume: true,
            inputCount: 0,
            pendingInputCount: 0
          }
        ]
      })
    });
  });

  await openWorkflowControls(page, baseUrl);
  const queuedText = page.locator(".job-row").filter({
    has: page.getByRole("button", { name: /Waiting #1/ })
  });
  await expect(queuedText).not.toHaveClass(/expanded/);
  await page.getByRole("button", { name: "Expand bug text for Waiting #1" }).click();
  await expect(queuedText).toHaveClass(/expanded/);
  await expect(
    page.getByRole("button", { name: "Collapse bug text for Waiting #1" })
  ).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: /^Waiting #1 ·/ }).click();
  await expect(page.locator("#job-status")).toContainText("queued · bug-fix");
  await expect(page.locator(".stage.pending")).toHaveCount(8);
  await page.getByRole("button", { name: /^Current ·/ }).click();
  await expect(page.locator(".stage.inferred strong")).toHaveText("diagnosis");
  await page.getByRole("button", { name: /Recent · passed/ }).click();
  await expect(page.locator("#job-status")).toContainText("passed · bug-fix");
  await expect(page.locator(".stage.passed")).toHaveCount(8);
  await page.getByRole("button", { name: /^Waiting #1 ·/ }).click();
  await expect(
    page.getByRole("button", { name: "Remove from queue" })
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove from queue" }).click();
  await expect.poll(() => cancellationObserved).toBe(true);
  await expect(page.locator("#job-status")).toContainText(
    "cancelled · bug-fix"
  );
  expect(cancelledBody).toEqual({ jobId: "queued-job" });
});

test("dashboard clears the bug input after adding a job to the queue", async ({
  page
}) => {
  const activeJob = {
    id: "active-job",
    request: "Active bug",
    requestType: "bug-fix",
    mode: "validate-only",
    status: "running",
    stages: {},
    bugs: [],
    logs: [],
    canComment: true,
    canResume: false,
    inputCount: 0,
    pendingInputCount: 0
  };
  let submittedRequest;
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        readiness: {
          repository: "C:\\repo",
          repositoryReady: true,
          profileReady: true,
          profileName: "Queued submission",
          error: null
        },
        job: activeJob,
        queue: [],
        history: []
      })
    });
  });
  await page.route("**/api/jobs", async (route) => {
    submittedRequest = route.request().postDataJSON().request;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        job: activeJob,
        queued: true,
        queuedJob: {
          id: "queued-job",
          position: 1,
          request: submittedRequest,
          requestType: "bug-fix",
          mode: "validate-only",
          status: "queued",
          bugCount: 0,
          screenshotCount: 0,
          stages: {}
        },
        queue: [
          {
            id: "queued-job",
            position: 1,
            request: submittedRequest,
            requestType: "bug-fix",
            mode: "validate-only",
            status: "queued",
            bugCount: 0,
            screenshotCount: 0,
            stages: {}
          }
        ],
        history: []
      })
    });
  });

  await openWorkflowControls(page, baseUrl);
  const requestField = page.getByLabel("Bug or required enhancement");
  await requestField.fill("Queue this bug and clear the form.");
  await page.getByRole("button", { name: "Add to queue" }).click();

  await expect.poll(() => submittedRequest).toBe(
    "Queue this bug and clear the form."
  );
  await expect(requestField).toHaveValue("");
  await expect(requestField).toBeFocused();
});

test("dashboard explains how to resume a failed job and release the queue", async ({
  page
}) => {
  let dismissed = false;
  const failedJob = {
    id: "failed-job",
    status: "failed",
    request: "Validate the current pull request.",
    requestType: "bug-fix",
    mode: "validate-only",
    error: "The runtime prerequisite is unavailable.",
    stages: {},
    bugs: [],
    logs: [],
    canResume: true,
    canComment: false,
    inputCount: 0,
    pendingInputCount: 0
  };
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        instanceId: "recovery-owner",
        readiness: {
          repository: "C:\\repo",
          repositoryReady: true,
          profileReady: true,
          profileName: "Failed job guidance",
          error: null
        },
        job: failedJob,
        queue: [
          {
            id: "queued-job",
            position: 1,
            request: "Validate the next pull request.",
            requestType: "bug-fix",
            mode: "validate-only",
            status: "queued",
            bugCount: 0,
            screenshotCount: 0,
            stages: {}
          }
        ],
        history: []
      })
    });
  });
  await page.route("**/api/job/dismiss", async (route) => {
    dismissed = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          id: "queued-job",
          status: "running",
          request: "Validate the next pull request.",
          requestType: "bug-fix",
          mode: "validate-only",
          stages: {},
          bugs: [],
          logs: [],
          canResume: false,
          canComment: true,
          inputCount: 0,
          pendingInputCount: 0
        },
        dismissedJob: failedJob,
        queue: [],
        history: [failedJob]
      })
    });
  });

  await openWorkflowControls(page, baseUrl);

  await expect(page.getByRole("heading", { name: "Retry or correct this job" })).toBeVisible();
  await expect(page.locator("#job-input-guidance")).toContainText(
    "choose Retry with the available prerequisite"
  );
  await expect(page.locator("#job-input-guidance")).toContainText(
    "dismiss it as failed"
  );
  await expect(page.getByRole("button", { name: "Resume FixLab" })).toBeVisible();
  const mutations = [];
  const review = {
    branch: "users/test/fixlab-existing", fingerprint: "review-one",
    freshBranch: { remote: "origin", baseBranch: "develop",
      files: ["e2e/preserved.auth.spec.ts"], available: true, reason: "" }
  };
  failedJob.status = "blocked";
  failedJob.workspaceReview = review;
  await page.route("**/api/conversation", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({
      instanceId: "recovery-owner", repository: "C:\\repo",
      job: failedJob, question: { kind: "workspace" }, workspaceReview: review
    })
  }));
  await page.route("**/api/jobs/restart", async (route) => {
    mutations.push(route.request().postDataJSON());
    if (mutations.length === 1) {
      return route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ error: "The workspace changed since review. Review again." }) });
    }
    failedJob.id = "fresh-job";
    failedJob.status = "failed";
    failedJob.workspaceReview = null;
    failedJob.workspaceStash = { stashRef: "b".repeat(40) };
    return route.fulfill({ status: 202, contentType: "application/json",
      body: JSON.stringify({ job: failedJob, restartedJob: failedJob }) });
  });
  await expect(page.locator("#workspace-recovery-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume FixLab", exact: true })).toBeHidden();
  await page.locator("#workspace-recovery-review").click();
  await expect(page.locator("#workspace-recovery-summary")).toContainText("origin/develop");
  await expect(page.locator("#workspace-recovery-summary")).toContainText("e2e/preserved.auth.spec.ts");
  expect(mutations).toEqual([]);
  await page.locator("#workspace-recovery-cancel").click();
  await expect(page.locator("#workspace-recovery-start")).toBeHidden();
  expect(mutations).toEqual([]);
  await page.locator("#workspace-recovery-review").click();
  await expect(page.locator("#workspace-recovery-start")).toBeEnabled();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#workspace-recovery-start").click();
  expect(mutations).toEqual([]);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#workspace-recovery-start").click();
  await expect(page.locator("#workspace-recovery-message")).toContainText("changed since review");
  await expect(page.locator("#workspace-recovery-start")).toBeHidden();
  review.fingerprint = "review-two";
  await page.locator("#workspace-recovery-review").click();
  await expect(page.locator("#workspace-recovery-start")).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#workspace-recovery-start").click();
  await expect.poll(() => mutations.length).toBe(2);
  expect(mutations[1]).toMatchObject({
    confirmed: true, instanceId: "recovery-owner", jobId: "failed-job",
    repository: "C:\\repo", workspaceRecovery: { fingerprint: "review-two", branch: review.branch }
  });
  await expect(page.locator("#workspace-stash-result")).toContainText("b".repeat(40));
  const dismissButton = page.getByRole("button", {
    name: "Dismiss failed job and continue queue"
  });
  await expect(dismissButton).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await dismissButton.click();
  await expect.poll(() => dismissed).toBe(true);
  await expect(page.locator("#job-input-message")).toContainText(
    "next queued job has started"
  );
});

test("dashboard resumes a failed job without requiring extra details", async ({
  page
}) => {
  let submittedInput;
  const failedJob = {
    id: "failed-job",
    status: "failed",
    request: "Resume this interrupted validation.",
    requestType: "bug-fix",
    mode: "fix-and-validate",
    error: "The executor exceeded its output idle timeout.",
    stages: {},
    bugs: [],
    logs: [],
    canResume: true,
    canComment: false,
    inputCount: 0,
    pendingInputCount: 0
  };
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        readiness: {
          repository: "C:\\repo",
          repositoryReady: true,
          profileReady: true,
          profileName: "One-click resume",
          error: null
        },
        job: failedJob,
        queue: [],
        history: []
      })
    });
  });
  await page.route("**/api/job/input", async (route) => {
    submittedInput = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          ...failedJob,
          status: "running",
          error: null,
          canResume: false,
          canComment: true,
          inputCount: 1
        },
        queue: []
      })
    });
  });

  await openWorkflowControls(page, baseUrl);
  await page.getByRole("button", { name: "Resume FixLab" }).click();

  await expect.poll(() => submittedInput?.action).toBe("continue");
  expect(submittedInput.details).toContain("retained workflow state");
  await expect(page.locator("#job-input-message")).toContainText(
    "resumed the same session"
  );
});

test("dashboard retries a blocked Playwright gate without shell input", async ({
  page
}) => {
  let submittedInput;
  const blockedJob = {
    id: "blocked-job",
    request: "Validate grouped details",
    requestType: "bug-fix",
    status: "blocked",
    manualLocalhostTest: true,
    manualLocalhostPending: false,
    durationMs: 1000,
    stages: Object.fromEntries(
      [
        "intake",
        "diagnosis",
        "reproduce",
        "fix",
        "review",
        "local-stack",
        "live-test",
        "pr"
      ].map((stage) => [
        stage,
        {
          status:
            stage === "live-test"
              ? "blocked"
              : stage === "pr"
                ? "skipped"
                : "passed",
          message: ""
        }
      ])
    ),
    bugs: [],
    logs: [],
    canComment: false,
    canResume: true,
    inputCount: 0,
    pendingInputCount: 0
  };
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        readiness: {
          repository: "C:\\repo",
          repositoryReady: true,
          profileReady: true,
          profileName: "Blocked live test",
          error: null
        },
        job: blockedJob,
        queue: [],
        history: []
      })
    });

  });
  await page.route("**/api/job/input", async (route) => {
    submittedInput = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          ...blockedJob,
          status: "running",
          canResume: false
        },
        queued: false
      })
    });
  });

  await openWorkflowControls(page, baseUrl);
  await expect(
    page.getByRole("button", { name: "Skip Playwright live test" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry Playwright live test" }).click();
  expect(submittedInput.action).toBe("retry");
  expect(submittedInput.details).toContain(
    "profile-defined browser and test command"
  );
  expect(submittedInput.details).toContain("save at least one");
  expect(submittedInput.details).toContain("Do not skip");
});

test("dashboard requires explicit manual localhost confirmation", async ({
  page
}) => {
  let submittedInput;
  const stages = Object.fromEntries(
    [
      "intake",
      "diagnosis",
      "reproduce",
      "fix",
      "review",
      "local-stack",
      "live-test",
      "pr"
    ].map((stage) => [
      stage,
      {
        status: stage === "live-test" ? "blocked" : "passed",
        message: ""
      }
    ])
  );
  const blockedJob = {
    id: "manual-localhost-job",
    request: "Manually validate the React app",
    requestType: "bug-fix",
    status: "blocked",
    durationMs: 1000,
    manualLocalhostTest: true,
    manualLocalhostUrl: "http://127.0.0.1:3000",
    manualLocalhostPending: true,
    stages,
    bugs: [],
    logs: [],
    canComment: false,
    canResume: true,
    inputCount: 0,
    pendingInputCount: 0
  };
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        readiness: {
          repository: "C:\\repo",
          repositoryReady: true,
          profileReady: true,
          profileName: "Manual localhost test",
          error: null
        },
        job: blockedJob,
        queue: [],
        history: []
      })
    });
  });
  await page.route("**/api/job/input", async (route) => {
    submittedInput = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          ...blockedJob,
          status: "running",
          canResume: false
        },
        queued: false
      })
    });
  });

  await openWorkflowControls(page, baseUrl);
  await expect(
    page.getByRole("button", { name: "Open React localhost" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Passed", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Failed", exact: true })).toBeVisible();
  await expect(page.locator("#job-input-guidance")).toContainText(
    "confirm Passed or Failed"
  );

  await page.getByRole("button", { name: "Passed", exact: true }).click();
  expect(submittedInput).toEqual({ action: "manual-pass" });
});

test("dashboard exposes explicit pull-request approval when validation is complete", async ({
  page
}) => {
  let submittedInput;
  const blockedJob = {
    id: "pr-ready-job",
    request: "Create the validated pull request",
    requestType: "bug-fix",
    status: "blocked",
    durationMs: 1000,
    pullRequestReadiness: {
      status: "approval-required",
      ready: true,
      message: "Approval is required before creating the pull request."
    },
    stages: Object.fromEntries(
      [
        "intake",
        "diagnosis",
        "reproduce",
        "fix",
        "review",
        "local-stack",
        "live-test",
        "pr"
      ].map((stage) => [
        stage,
        {
          status: stage === "pr" ? "blocked" : "passed",
          message: ""
        }
      ])
    ),
    bugs: [
      {
        id: "17032997",
        title: "Validated bug",
        outcome: "fixed",
        owner: "application",
        summary: "Focused fix passed."
      }
    ],
    logs: [],
    canComment: false,
    canResume: true,
    inputCount: 0,
    pendingInputCount: 0
  };
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        readiness: {
          repository: "C:\\repo",
          repositoryReady: true,
          profileReady: true,
          profileName: "PR-ready job",
          error: null
        },
        job: blockedJob,
        queue: [],
        history: []
      })
    });
  });
  await page.route("**/api/job/input", async (route) => {
    submittedInput = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          ...blockedJob,
          status: "running",
          canResume: false
        },
        queued: false
      })
    });
  });

  await openWorkflowControls(page, baseUrl);
  await expect(
    page.getByRole("button", { name: "Approve and create PR" })
  ).toBeVisible();
  await expect(page.locator("#job-input-guidance")).toContainText(
    "All required validation gates passed"
  );
  await page.getByRole("button", { name: "Approve and create PR" }).click();
  await expect.poll(() => submittedInput).toBeTruthy();
  expect(submittedInput.action).toBe("continue");
  expect(submittedInput.details).toContain("explicitly approve");
});

async function mockChatWorkspace(page, { job = null, queue = [], history = [] } = {}) {
  await page.route("**/api/status", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      instanceId: "workspace-owner",
      readiness: { repositoryReady: true, profileReady: true,
        repository: "C:\\code\\alpha", profileName: "Alpha workspace" },
      runtime: { name: "copilot", supportsModelSelection: true, defaultModel: "" },
      job, queue, held: [], history
    })
  }));
  await page.route("**/api/repositories", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ repositories: [
      { id: "workspace-owner", repository: "C:\\code\\alpha", url: baseUrl, status: "idle" },
      { id: "other-owner", repository: "C:\\code\\beta", url: "http://127.0.0.1:48555", status: "blocked" }
    ], unavailableCount: 0 })
  }));
}

test("chat workspace defaults to a compact composer and local repository navigation", async ({ page }) => {
  const mutations = [];
  page.on("request", (request) => {
    if (request.method() === "POST") {
      mutations.push(request.url());
    }
  });
  await mockChatWorkspace(page);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(baseUrl);
  await expect(page.locator("#workspace-title")).toHaveText("Alpha workspace");
  await expect(page.locator("#chat-welcome")).toBeVisible();
  await expect(page.locator("#run-options")).not.toHaveAttribute("open");
  await expect(page.locator("#details-group")).not.toHaveAttribute("open");
  await expect(page.locator("#connections-group")).not.toHaveAttribute("open");
  await expect(page.locator("#settings-group")).not.toHaveAttribute("open");
  await expect(page.locator("#workspace-tools")).toBeHidden();
  await expect(page.locator("#memory-group")).not.toHaveAttribute("open");
  await expect(page.locator("#repository-list a")).toHaveCount(2);
  await expect(page.locator("#repository-list a").first()).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#repository-list a").last()).toHaveAttribute("href", "http://127.0.0.1:48555/");
  await page.getByRole("button", { name: "Validate a browser workflow", exact: true }).click();
  await expect(page.locator("#request")).toHaveValue("Validate this browser workflow: ");
  await expect(page.locator("input[name=mode][value=playwright-only]")).toBeChecked();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#workspace-tools")).toBeVisible();
  await expect(page.locator("#settings-group")).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await expect(page.locator("#workspace-tools")).toBeHidden();
  await expect(page.locator("#request")).toBeFocused();
  await expect(page.locator("#request")).toHaveValue("Validate this browser workflow: ");
  await page.screenshot({ path: test.info().outputPath("chat-workspace-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#repository-navigation")).toBeHidden();
  await expect(page.locator("#start-button")).toBeInViewport();
  await page.locator("#navigation-toggle").click();
  await expect(page.locator("#navigation-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#repository-list")).toBeVisible();
  await page.locator('.workspace-navigation [data-open="settings-group"]').click();
  await expect(page.locator("#navigation-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#settings-group")).toHaveAttribute("open", "");
  await page.locator("#close-workspace-tools").click();
  await expect(page.locator("#request")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(mutations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("chat-workspace-mobile-composer.png"), fullPage: true });
});

test("repository memory shows saved outcomes safely and selecting one never resumes it", async ({ page }) => {
  let posts = 0;
  page.on("request", (request) => { if (request.method() === "POST") { posts++; } });
  const saved = {
    id: "saved-chat", request: "<img src=x onerror=alert(1)> Synthetic remembered work",
    status: "blocked", requestType: "bug-fix", targetEnvironment: "dev",
    stages: { diagnosis: { status: "passed", message: "Synthetic diagnosis complete" } },
    bugs: [], logs: [], activity: [], canResume: false, canComment: false
  };
  await mockChatWorkspace(page, { history: [saved] });
  await page.goto(baseUrl);
  await page.locator('.workspace-navigation [data-open="memory-group"]').click();
  await expect(page.locator("#repository-memory-list")).toContainText("Synthetic remembered work");
  await expect(page.locator("#repository-memory-list")).toContainText("1 passed stage(s)");
  await page.locator("#repository-memory-list button").click();
  await expect(page.locator("#chat-thread .user-message")).toContainText(saved.request);
  await expect(page.locator("#chat-thread img")).toHaveCount(0);
  await expect(page.locator("#job-input-panel")).toBeHidden();
  await page.locator("#request").fill("Keep this unsent draft");
  await page.locator("#new-conversation").click();
  await expect(page.locator("#chat-welcome")).toBeVisible();
  await expect(page.locator("#chat-thread")).toBeEmpty();
  await expect(page.locator("#request")).toHaveValue("Keep this unsent draft");
  expect(posts).toBe(0);
});

test("chat keeps manual permissions inline and mobile layout within the viewport", async ({ page }) => {
  let grants = 0;
  page.on("request", (request) => {
    if (request.method() === "POST") { grants++; }
  });
  await mockChatWorkspace(page, { job: {
    id: "waiting-chat", request: "Synthetic browser validation",
    requestType: "bug-fix", mode: "playwright-only", status: "running",
    stages: {}, bugs: [], logs: [], activity: [],
    runtimeRequests: [{ id: "manual-read", kind: "permission", canApprove: true,
      title: "Read synthetic source", details: "Read the selected synthetic file once." }]
  } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl);
  await expect(page.locator("#conversation-state-title")).toHaveText("Waiting for your permission");
  await page.locator("#needs-response").click();
  await expect(page.locator("#runtime-request-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(grants).toBe(0);
  await page.screenshot({ path: test.info().outputPath("chat-workspace-mobile.png"), fullPage: true });
});

test("queue navigation opens the inspector at the first card without changing jobs", async ({ page }) => {
  let posts = 0;
  page.on("request", (request) => { if (request.method() === "POST") { posts++; } });
  const job = { id: "queue-current", request: "Synthetic blocked browser check",
    requestType: "bug-fix", mode: "playwright-only", status: "blocked",
    stages: {}, bugs: [], logs: [], activity: [], canResume: false };
  await mockChatWorkspace(page, { job, queue: [{
    id: "queue-next", request: "Synthetic next bug", requestType: "bug-fix",
    mode: "playwright-only", status: "queued", position: 1, bugCount: 1
  }] });
  await page.goto(baseUrl);
  await expect(page.locator("#queue-nav-count")).toHaveText("1");
  await expect(page.locator("#details-group")).not.toHaveAttribute("open");
  await page.locator("[data-open=queue-panel]").click();
  await expect(page.locator("#details-group")).toHaveAttribute("open", "");
  await expect(page.locator("#queue-panel")).toBeInViewport();
  await expect(page.locator("#details-view > :first-child")).toHaveAttribute("id", "queue-panel");
  await expect(page.locator("#queue-list")).toContainText("Waiting #1");
  await expect(page.locator("#queue-list")).toContainText("Synthetic next bug");
  expect(posts).toBe(0);
});

test("browser-only retry preserves browser scope and makes its prerequisite blocker visible", async ({ page }) => {
  const job = { id: "browser-busy-chat", request: "Synthetic browser-only check",
    requestType: "bug-fix", mode: "playwright-only", status: "blocked",
    stages: { "live-test": { status: "blocked", message: "Synthetic browser is busy" } },
    bugs: [], logs: [], activity: [], canResume: true, canComment: false,
    browserBlocker: { kind: "browser-profile-busy", pids: [777],
      message: "Synthetic profile is in use by browser PID 777. Preserve unsaved data before closing it." } };
  let submitted;
  await mockChatWorkspace(page, { job });
  await page.route("**/api/job/input", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 409, contentType: "application/json",
      body: JSON.stringify({ error: job.browserBlocker.message }) });
  });
  await page.goto(baseUrl);
  await expect(page.locator("#conversation-state-title")).toHaveText("Browser launch blocked; no retry running");
  await expect(page.locator("#conversation-state-detail")).toContainText("Preserve unsaved data");
  await page.locator("#retry-live-test").click();
  await expect(page.locator("#form-error")).toContainText("browser PID 777");
  expect(submitted.action).toBe("retry");
  expect(submitted.details).toContain("retained same-job script");
  expect(submitted.details).toContain("Do not retry an unchanged profile lock");
  expect(submitted.details).not.toContain("continue to pull-request creation");
});

function pendingApprovalJob(commands) {
  return {
    id: "synthetic-pending-batch", request: "Synthetic pending permission review",
    requestType: "bug-fix", mode: "playwright-only", status: "running",
    stages: {}, bugs: [], logs: [], activity: [], canResume: false,
    runtimeRequests: commands.map((command) => ({
      ...runtimePermissionPrompt({ kind: "shell", fullCommandText: command }), id: randomUUID()
    }))
  };
}

function pendingQuestionJob(question) {
  const job = pendingApprovalJob([]);
  job.runtimeRequests = [{ ...runtimeQuestionPrompt({ question }), id: randomUUID() }];
  return job;
}

test("current-job full screen ignores historical selection, follows the live job and restores the prior view", async ({ page }) => {
  const posts = [];
  let historicalEvidence;
  page.on("request", (request) => { if (request.method() === "POST") { posts.push(request.url()); } });
  const longRequest = "Detailed expected behavior and evidence. ".repeat(80) +
    "https://example.test/" + "long-path".repeat(40);
  const job = { id: "fullscreen-current", request: `Current synthetic live journey ${longRequest}`,
    requestType: "bug-fix", mode: "playwright-only", status: "running",
    stages: { "live-test": { status: "running", message: "Current stage sentinel" } },
    bugs: [], logs: [], activity: [] };
  const saved = { ...job, id: "fullscreen-history", request: "Historical synthetic journey", status: "passed" };
  await mockChatWorkspace(page, { job, history: [saved] });
  await page.route(/\/api\/playwright\/artifacts\?jobId=/, (route) => {
    const id = new URL(route.request().url()).searchParams.get("jobId");
    if (id === saved.id && !historicalEvidence) {
      historicalEvidence = route;
      return;
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ artifacts: [{
      kind: "screenshot", name: `${id}.png`, relativePath: `test-results/${id}.png`, url: `/synthetic-${id}.png`
    }] }) });
  });
  await page.route("**/synthetic-*.png", (route) => route.fulfill({
    contentType: "image/png", body: Buffer.from(loadedPng, "base64")
  }));
  await page.goto(baseUrl);
  await page.locator('.workspace-navigation [data-open="memory-group"]').click();
  await page.locator("#repository-memory-list button").click();
  await expect(page.locator("#chat-thread .user-message")).toContainText(saved.request);
  await expect.poll(() => Boolean(historicalEvidence)).toBe(true);
  await page.locator("#current-job-fullscreen").click();
  await expect(page.locator("#current-job-dialog")).toBeVisible();
  await expect(page.locator("#current-job-dialog-title")).toContainText(job.request);
  const expectCompactHeader = async () => {
    const title = page.locator("#current-job-dialog-title");
    await expect(title).toHaveAttribute("title", `Current job: ${job.request}`);
    const layout = await title.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const exit = document.querySelector("#current-job-fullscreen-close").getBoundingClientRect();
      return {
        height: bounds.height, lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        scrollHeight: element.scrollHeight, titleRight: bounds.right,
        exitLeft: exit.left, exitRight: exit.right, viewportWidth: window.innerWidth
      };
    });
    expect(layout.height).toBeLessThanOrEqual(layout.lineHeight * 2 + 1);
    expect(layout.scrollHeight).toBeGreaterThan(layout.height);
    expect(layout.exitLeft).toBeGreaterThanOrEqual(layout.titleRight);
    expect(layout.exitRight).toBeLessThanOrEqual(layout.viewportWidth);
    await expect(page.locator("#current-job-fullscreen-close")).toBeVisible();
  };
  await expectCompactHeader();
  await expect(page.locator("#current-job-dialog #details-view")).toHaveCount(1);
  await expect(page.locator("#current-job-dialog #stages")).toContainText("Current stage sentinel");
  await expect(page.locator("#current-job-dialog img").first()).toHaveAttribute("src", "/synthetic-fullscreen-current.png");
  await historicalEvidence.fulfill({ status: 400, contentType: "application/json",
    body: JSON.stringify({ error: "Stale historical evidence sentinel" }) });
  await expect(page.locator("#playwright-evidence-guidance")).toContainText("1 evidence artifact(s)");
  job.id = "fullscreen-next";
  job.request = `Next synthetic live journey ${longRequest}`;
  await expect(page.locator("#current-job-dialog-title")).toContainText(job.request);
  await expect(page.locator("#current-job-dialog img").first()).toHaveAttribute("src", "/synthetic-fullscreen-next.png");
  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await page.locator("#current-job-dialog").evaluate((element) => ({
    width: element.getBoundingClientRect().width, overflow: element.scrollWidth > element.clientWidth
  }));
  expect(dimensions.width).toBe(390);
  expect(dimensions.overflow).toBe(false);
  await expectCompactHeader();
  await page.keyboard.press("Escape");
  await expect(page.locator("#current-job-dialog")).not.toBeVisible();
  await expect(page.locator("#details-group #details-view")).toHaveCount(1);
  await expect(page.locator("#chat-thread .user-message")).toContainText(saved.request);
  await expect(page.locator("#current-job-fullscreen")).toBeFocused();
  expect(posts).toEqual([]);
});

test("local repository chat onboarding and settings require a reviewed apply and never start a job", async ({ page }) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), "fixlab-chat-onboarding-"));
  const git = spawnSync("git", ["init", "--quiet"], { cwd: directory, windowsHide: true, encoding: "utf8" });
  expect(git.status).toBe(0);
  let launches = 0;
  const instance = createDashboardServer({
    repository: directory, packageRoot, browserOpener() {},
    executor() { launches++; throw new Error("Setup must not start an executor"); }
  });
  const startedJobs = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/jobs") { startedJobs.push(request.url()); }
  });
  const { REPOSITORY_SETTING_FIELDS } = await import(pathToFileURL(join(packageRoot, "dashboard", "repository-settings.js")).href);
  try {
    const address = await instance.listen({ port: 0 });
    await page.goto(address.url);
    await page.locator("#add-local-repository").click();
    await page.locator("#repository-onboarding-answer").fill(directory);
    await page.locator("#repository-onboarding-form button[type=submit]").click();
    for (const field of REPOSITORY_SETTING_FIELDS.filter((entry) => !entry.when)) {
      await expect(page.locator("#repository-onboarding-label")).toHaveText(field.label);
      if (field.key === "name" || field.key === "branchUserId") {
        await page.locator("#repository-onboarding-answer").fill(field.key === "name" ? "Configured in chat" : "synthetic-user");
        await page.locator("#repository-onboarding-form button[type=submit]").click();
      } else {
        await page.locator("#repository-onboarding-suggested").click();
      }
    }
    await expect(page.locator("#repository-onboarding-review")).toBeVisible();
    await expect(page.locator("#repository-onboarding-plan")).toContainText("Configured in chat");
    const profilePath = join(directory, ".github", "fixlab", "repository-profile.json");
    expect(() => readFileSync(profilePath)).toThrow();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#repository-onboarding-apply").click();
    expect(() => readFileSync(profilePath)).toThrow();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#repository-onboarding-apply").click();
    await expect(page.locator("#repository-onboarding-open")).toBeVisible();
    expect(JSON.parse(readFileSync(profilePath, "utf8")).name).toBe("Configured in chat");
    await page.locator("#repository-onboarding-close").click();
    await page.locator("[data-open=settings-group]").click();
    await page.locator("#repository-settings-load").click();
    await page.locator("#repository-settings-fields input[name=name]").fill("Updated repository settings");
    let releasePreview;
    const previewReady = new Promise((resolve) => { releasePreview = resolve; });
    await page.route("**/api/repository/configuration", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "preview" && body.install === false) { await previewReady; }
      await route.continue();
    });
    await page.locator("#repository-settings-form button[type=submit]").click();
    try {
      await expect(page.locator("#repository-settings-fields input[name=name]")).toBeDisabled();
      await expect(page.locator("#repository-settings-load")).toBeDisabled();
      await expect(page.locator("#repository-settings-apply")).toBeDisabled();
    } finally {
      releasePreview();
    }
    await expect(page.locator("#repository-settings-review")).toBeVisible();
    await expect(page.locator("#repository-settings-fields input[name=name]")).toBeEnabled();
    expect(JSON.parse(readFileSync(profilePath, "utf8")).name).toBe("Configured in chat");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#repository-settings-apply").click();
    await expect(page.locator("#repository-settings-message")).toContainText("Repository settings saved");
    expect(JSON.parse(readFileSync(profilePath, "utf8")).name).toBe("Updated repository settings");
    expect(launches).toBe(0);
    expect(startedJobs).toEqual([]);
  } finally {
    await instance.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pending approval batch sends nothing when the reviewed snapshot becomes stale", async ({ page }) => {
  const job = pendingApprovalJob(['echo "<img src=x onerror=alert(1)>"', "npm run build"]);
  const posts = [];
  await mockChatWorkspace(page, { job });
  await page.route("**/api/job/runtime-response", (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, contentType: "application/json",
      body: JSON.stringify({ error: "No stale approval should have been sent." }) });
  });
  await page.goto(baseUrl);
  await page.locator("#runtime-batch-summary").click();
  await expect(page.locator("#runtime-batch-requests")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#runtime-batch-requests img")).toHaveCount(0);
  page.once("dialog", async (dialog) => {
    job.runtimeRequests = [job.runtimeRequests[0]];
    await dialog.accept();
  });
  await page.locator("#runtime-allow-pending").click();
  await expect(page.locator("#runtime-batch-result")).toContainText("No approvals were sent.");
  await expect(page.locator("#runtime-batch-result")).toContainText("permissions or live job changed");
  expect(posts).toEqual([]);
});

test("pending approval batch reports partial failure and never retries or sends the remaining request", async ({ page }) => {
  const job = pendingApprovalJob(["npm test", "npm run build", "npm run lint"]);
  const reviewedIds = job.runtimeRequests.map((request) => request.id);
  const posts = [];
  await mockChatWorkspace(page, { job });
  await page.route("**/api/job/runtime-response", async (route) => {
    posts.push(route.request().postDataJSON());
    if (posts.length === 1) {
      job.runtimeRequests = job.runtimeRequests.filter((request) => request.id !== reviewedIds[0]);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job }) });
    } else {
      await route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic second request became stale." }) });
    }
  });
  await page.goto(baseUrl);
  await page.locator("#runtime-batch-summary").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#runtime-allow-pending").click();
  await expect(page.locator("#runtime-batch-result")).toContainText("Batch stopped after 1 confirmed approval(s) out of 3");
  await expect(page.locator("#runtime-batch-result")).toContainText("No automatic retry was made");
  expect(posts).toEqual(reviewedIds.slice(0, 2).map((requestId) => ({
    instanceId: "workspace-owner", jobId: job.id, requestId, action: "allow", confirmed: true
  })));
});
