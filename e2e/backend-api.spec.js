import { expect, request as playwrightRequest, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = process.env.FIXLAB_TEST_PACKAGE_ROOT ??
  fileURLToPath(new URL("..", import.meta.url));
const { createDashboardServer, FIXLAB_STAGES } = await import(
  pathToFileURL(join(packageRoot, "dashboard", "server.js")).href
);
let repository;
let backend;
let dashboard;
let dashboardUrl;
const observed = [];

test.beforeAll(async () => {
  backend = createServer((req, res) => {
    observed.push(`${req.method} ${req.url}`);
    const authorized = req.headers.authorization === "Bearer local-api-fixture";
    res.writeHead(req.url === "/protected" && !authorized ? 401 : 200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({ ready: true }));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendOrigin = `http://127.0.0.1:${backend.address().port}`;
  repository = mkdtempSync(join(tmpdir(), "fixlab-api-e2e-"));
  const directory = join(repository, ".github", "fixlab");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "repository-profile.json"), JSON.stringify({
    name: "API-only local fixture",
    applications: { backend: {
      workingDirectory: ".", command: "node local-fixture.js",
      port: backend.address().port, healthUrl: `${backendOrigin}/health`
    } },
    browserAutomation: {
      mode: "api", workingDirectory: ".", package: "@playwright/test",
      testCommand: "npm test", authentication: { required: false },
      dataSafety: {
        productionAllowed: false, policy: "Read only the owned loopback fixture.",
        allowedOrigins: [backendOrigin], allowedMethods: ["GET"]
      },
      testSynthesis: {
        enabled: true, defaultDataSource: "local-fixture",
        mutationMode: "none", requireScenarioEvidence: true
      }
    }
  }));
  dashboard = createDashboardServer({
    repository, packageRoot,
    browserOwnership() { throw new Error("API-only validation must not inspect a browser profile"); },
    executor({ onOutput }) {
      const completion = (async () => {
        const context = await playwrightRequest.newContext({ baseURL: backendOrigin, maxRedirects: 0 });
        try {
          expect((await context.get("/health")).status()).toBe(200);
          expect((await context.get("/protected")).status()).toBe(401);
          const response = await context.get("/protected", {
            headers: { Authorization: "Bearer local-api-fixture" }
          });
          expect(response.status()).toBe(200);
          expect(typeof (await response.json()).ready).toBe("boolean");
          onOutput("stdout", "FIXLAB_TEST|local-fixture|none|GET health, unauthenticated 401 and authorized 200/schema on the owned fixture.\n");
          for (const stage of FIXLAB_STAGES) {
            onOutput("stdout", `FIXLAB_STAGE|${stage}|${["intake", "local-stack", "live-test"].includes(stage) ? "passed" : "skipped"}|Owned local API fixture only.\n`);
          }
          return { code: 0 };
        } finally {
          await context.dispose();
        }
      })();
      return { completion, terminate() {} };
    }
  });
  dashboardUrl = (await dashboard.listen({ port: 0 })).url;
});

test.afterAll(async () => {
  await dashboard?.close();
  if (backend?.listening) {
    await new Promise((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
  }
  if (repository) { rmSync(repository, { recursive: true, force: true }); }
});

test("API-only Playwright runs real read-only HTTP assertions without a browser", async ({ request }) => {
  const created = await request.post(`${dashboardUrl}/api/jobs`, {
    data: { request: "Validate only the owned local API fixture.", mode: "playwright-only" }
  });
  expect(created.status()).toBe(202);
  await expect.poll(async () => (await (await request.get(`${dashboardUrl}/api/job`)).json()).job.status).toBe("passed");
  expect(observed).toEqual(["GET /health", "GET /protected", "GET /protected"]);
  const job = (await (await request.get(`${dashboardUrl}/api/job`)).json()).job;
  expect(job.testEvidence.source).toBe("local-fixture");
  expect(job.testEvidence.mutationMode).toBe("none");
  expect(job.testEvidence.reported).toBe(true);
});

test("API-only dashboard disables frontend and browser-only options", async ({ page }) => {
  await page.goto(dashboardUrl);
  for (const name of ["prestartFrontend", "manualLocalhostTest", "recordPlaywrightVideo", "runAllUiScenarios"]) {
    await expect(page.locator(`[name="${name}"]`)).toBeDisabled();
    await expect(page.locator(`[name="${name}"]`)).not.toBeChecked();
  }
  await expect(page.locator('[name="testMutationMode"] option[value="intercepted"]')).toBeDisabled();
  await expect(page.locator("#welcome-guidance")).toHaveText("Describe a bug, change, or API check.");
});
