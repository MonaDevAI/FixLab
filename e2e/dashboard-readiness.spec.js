import { expect, test } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "../dashboard/server.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
let repository;
let dashboard;
let baseUrl;

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
    JSON.stringify({ name: "E2E repository" })
  );

  dashboard = createDashboardServer({
    repository,
    packageRoot,
    executor,
    workItemLoader
  });
  await new Promise((resolve, reject) => {
    dashboard.server.once("error", reject);
    dashboard.server.listen(0, "127.0.0.1", resolve);
  });
  const address = dashboard.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await dashboard.close();
  rmSync(repository, { recursive: true, force: true });
});

test("dashboard exposes repository readiness through the running server", async ({
  request
}) => {
  const response = await request.get(`${baseUrl}/api/status`);

  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.readiness.repositoryReady).toBe(true);
  expect(body.readiness.profileReady).toBe(true);
  expect(body.readiness.profileName).toBe("E2E repository");
});

test("dashboard exposes multi-bug intake and resumable user input", async ({
  page
}) => {
  await page.goto(baseUrl);

  await expect(
    page.getByRole("heading", { name: "Playwright authentication" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check status" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Playwright" })
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", {
      name: /Playwright screenshot/
    })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh screenshots" })
  ).toBeVisible();
  await expect(
    page.getByLabel("Playwright validation only")
  ).toBeVisible();
  await page.getByLabel("Load from Azure DevOps").check();
  await expect(page.getByText("Load bugs")).toBeVisible();
  await expect(
    page.getByPlaceholder("123, 456, or one URL/ID per line")
  ).toBeVisible();
  await page
    .getByPlaceholder("123, 456, or one URL/ID per line")
    .fill("123");
  await page.getByRole("button", { name: "Load bugs" }).click();
  await expect(page.getByAltText("Preview of 123-bug.png")).toBeVisible();
  await expect(page.getByText("1 image(s)")).toBeVisible();
  await expect(page.getByText("Continue this job")).toBeHidden();
  await expect(page.getByText("Workflow statistics")).toBeVisible();
});

test("dashboard accepts pasted images and records exact usage metrics", async ({
  page,
  request
}) => {
  await page.goto(baseUrl);
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
  await expect(page.getByAltText("Preview of clipboard.png")).toBeVisible();

  await requestField.fill("Validate pasted screenshot");
  await page.getByRole("button", { name: "Start job" }).click();
  await expect(page.locator(".stage.inferred strong")).toHaveText("diagnosis");
  await expect(page.locator(".stage.inferred")).toContainText("active now");
  await expect(page.locator("#job-status")).toContainText(
    "passed · bug-fix"
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
  await page.route("**/api/status", async (route) => {
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
        queue: [
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

  await page.goto(baseUrl);
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

  await page.goto(baseUrl);
  await expect(
    page.getByRole("button", { name: "Skip Playwright live test" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry Playwright live test" }).click();
  expect(submittedInput.action).toBe("retry");
  expect(submittedInput.details).toContain("one worker");
  expect(submittedInput.details).toContain("save at least one");
  expect(submittedInput.details).toContain("Do not skip");
});
