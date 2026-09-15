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

test.beforeAll(async () => {
  repository = mkdtempSync(join(tmpdir(), "fixlab-e2e-"));
  const profileDirectory = join(repository, ".github", "fixlab");
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(
    join(profileDirectory, "repository-profile.json"),
    JSON.stringify({ name: "E2E repository" })
  );

  dashboard = createDashboardServer({ repository, packageRoot });
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
  await expect(page.getByText("Continue this job")).toBeHidden();
});
