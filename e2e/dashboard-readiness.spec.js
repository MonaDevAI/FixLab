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
  return {
    completion: Promise.resolve({ code: 0 }),
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
  await expect(page.getByText("passed · bug-fix")).toBeVisible();

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
  await expect(page.getByText("1,900,000 (79.2%)")).toBeVisible();
  await expect(page.getByText("500,000")).toBeVisible();
});
