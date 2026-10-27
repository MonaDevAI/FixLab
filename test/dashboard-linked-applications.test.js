import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configuredLinkedApplications, resolveLinkedApplications } from "../dashboard/linked-applications.js";
import { createDashboardServer, inspectRepository } from "../dashboard/server.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const profilePath = (root) => join(root, ".github", "fixlab", "repository-profile.json");
const save = (root, profile) => writeFileSync(profilePath(root), JSON.stringify(profile));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "fixlab-linked-applications-"));
  const source = join(directory, "api");
  const target = join(directory, "web");
  for (const root of [source, target]) {
    mkdirSync(join(root, ".github", "fixlab"), { recursive: true });
    const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
  }
  const browserAutomation = {
    workingDirectory: ".", package: "@playwright/test", testCommand: "npm run test:e2e",
    testSynthesis: { enabled: true, defaultDataSource: "non-production-read-only", mutationMode: "none", requireScenarioEvidence: true },
    authentication: { required: true, command: "node authenticate.mjs", proofCommand: "node authenticate.mjs --proof", statusPaths: [".auth/ready.json"] },
    dataSafety: { policy: "Read-only local assertions.", productionAllowed: false,
      allowedOrigins: ["https://localhost:5088"], allowedMethods: ["GET"] }
  };
  const link = { id: "web-client", repository: target, application: "frontend",
    url: "http://localhost:43001", environment: "local" };
  const sourceProfile = {
    name: "API owner", environments: ["local"],
    applications: { backend: { workingDirectory: ".", command: "dotnet run", port: 5087, healthUrl: "https://localhost:5088/health" } },
    browserAutomation: { ...browserAutomation, mode: "api" },
    linkedApplications: [link]
  };
  const targetProfile = {
    name: "Frontend owner", environments: ["local"],
    applications: { frontend: { workingDirectory: ".", command: "npm start", port: 43001, healthUrl: "http://127.0.0.1:43001/health" } },
    browserAutomation: { ...browserAutomation, browser: "chromium" },
    environmentVariables: { SYNTHETIC_PRIVATE_VALUE: "must-not-be-returned" }
  };
  save(source, sourceProfile);
  save(target, targetProfile);
  return { directory, source, target, link, sourceProfile, targetProfile };
}

test("linked application schema is opt-in, bounded and rejects unsafe or ambiguous references", () => {
  assert.deepEqual(configuredLinkedApplications({}), []);
  assert.deepEqual(resolveLinkedApplications("not-a-repository", {}), []);
  const link = { id: "web", repository: tmpdir(), application: "frontend", url: "http://localhost:43001", environment: "local" };
  for (const linkedApplications of [
    null, {}, Array(9).fill(link), [link, link],
    [null], [{ ...link, id: "../web" }], [{ ...link, repository: ".." }],
    [{ ...link, application: "backend" }], [{ ...link, environment: "production" }],
    [{ ...link, command: "unreviewed command" }],
    ...["https://example.com:43001", "http://user:password@localhost:43001",
      "http://localhost:43001/path", "http://localhost:43001?token=secret",
      "http://localhost:43001/#state", "http://0.0.0.0:43001"].map((url) => [{ ...link, url }])
  ]) {
    assert.throws(() => configuredLinkedApplications({ linkedApplications }));
  }
});

test("resolving a frontend preserves API-only configuration and does not expose commands or credentials", () => {
  const current = fixture();
  try {
    const before = readFileSync(profilePath(current.source), "utf8");
    const [link] = resolveLinkedApplications(current.source, current.sourceProfile);
    assert.equal(link.repository, realpathSync.native(current.target));
    assert.equal(link.url, current.link.url);
    assert.equal(link.healthUrl, "http://127.0.0.1:43001/health");
    assert.match(link.revision, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(link), /must-not-be-returned|authenticate|npm start|environmentVariables/u);
    const readiness = inspectRepository(current.source);
    assert.equal(readiness.profileReady, false);
    assert.match(readiness.error, /authentication is not ready/u);
    assert.equal(readFileSync(profilePath(current.source), "utf8"), before);
    assert.equal(current.sourceProfile.applications.frontend, undefined);
    assert.equal(current.sourceProfile.browserAutomation.mode, "api");
    const malformed = structuredClone(current.sourceProfile);
    malformed.linkedApplications[0].environment = "production";
    save(current.source, malformed);
    assert.match(inspectRepository(current.source).error, /Each linked application/u);
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("linked profiles retain repository containment and explicit local non-production policy", () => {
  const current = fixture();
  try {
    const resolve = () => resolveLinkedApplications(current.source, current.sourceProfile);
    for (const change of [
      (profile) => { profile.applications.frontend.workingDirectory = ".."; },
      (profile) => { profile.applications.frontend.port = 43002; },
      (profile) => { profile.applications.frontend.healthUrl = "https://localhost:43001/health"; },
      (profile) => { profile.browserAutomation.mode = "api"; },
      (profile) => { profile.browserAutomation.dataSafety.productionAllowed = true; },
      (profile) => { delete profile.browserAutomation.dataSafety.productionAllowed; },
      (profile) => { profile.environments = ["production"]; }
    ]) {
      const profile = structuredClone(current.targetProfile);
      change(profile);
      save(current.target, profile);
      assert.throws(resolve);
    }
    save(current.target, current.targetProfile);
    current.link.repository = current.source;
    assert.throws(resolve, /separate repository/u);
    current.link.repository = current.target;
    linkSync(profilePath(current.target), join(current.directory, "hard-linked-profile.json"));
    assert.throws(resolve, /unlinked regular/u);
    rmSync(join(current.directory, "hard-linked-profile.json"));
    const external = join(current.directory, "outside");
    mkdirSync(external);
    symlinkSync(external, join(current.target, "external"), "junction");
    current.targetProfile.applications.frontend.workingDirectory = "external";
    save(current.target, current.targetProfile);
    assert.throws(resolve, /symbolic links|symlink/u);
    writeFileSync(profilePath(current.target), "invalid-private-profile-value");
    assert.throws(resolve, (error) => {
      assert.equal(error.message, "The linked repository profile must contain valid JSON.");
      return true;
    });
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

async function request(url, path, body, origin = url) {
  const response = await fetch(new URL(path, url), body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

for (const existingOwner of [false, true]) {
  test(`linked workspace opening ${existingOwner ? "reuses a verified independent owner" : "creates only one idle owned workspace"} with identity and stale-review checks`, async () => {
    const current = fixture();
    let executions = 0;
    const options = { packageRoot, executor() { executions++; throw new Error("No execution is authorized by opening a link."); } };
    const dashboard = createDashboardServer({ ...options, repository: current.source });
    const independent = existingOwner ? createDashboardServer({ ...options, repository: current.target }) : null;
    let childUrl;
    try {
      const independentUrl = independent ? (await independent.listen({ port: 0 })).url : null;
      const url = (await dashboard.listen({ port: 0 })).url;
      const listed = await request(url, "/api/linked-applications");
      assert.equal(listed.status, 200, listed.body.error);
      const [link] = listed.body.applications;
      const body = { action: "open-linked-application", instanceId: listed.body.instanceId,
        applicationId: link.id, revision: link.revision, confirmed: true };
      const open = (changes = {}, origin = url) => request(url, "/api/repository/configuration", { ...body, ...changes }, origin);
      assert.equal((await open({}, "http://untrusted.invalid")).status, 403);
      assert.equal((await open({ instanceId: "stale-owner" })).status, 409);
      assert.equal((await open({ confirmed: false })).status, 400);
      assert.equal((await open({ applicationId: "not-configured" })).status, 400);
      assert.equal((await open({ revision: "stale" })).status, 400);
      current.targetProfile.customContract = "target changed after review";
      save(current.target, current.targetProfile);
      assert.match((await open()).body.error, /changed/u);
      delete current.targetProfile.customContract;
      save(current.target, current.targetProfile);
      current.sourceProfile.customContract = "source changed after review";
      save(current.source, current.sourceProfile);
      assert.match((await open()).body.error, /changed/u);
      delete current.sourceProfile.customContract;
      save(current.source, current.sourceProfile);
      const [opened, concurrent] = await Promise.all([
        open({ repository: current.source }), open()
      ]);
      assert.equal(opened.status, 200, opened.body.error);
      assert.equal(concurrent.status, 200, concurrent.body.error);
      childUrl = opened.body.url;
      assert.equal(concurrent.body.url, childUrl);
      if (independentUrl) { assert.equal(childUrl, independentUrl); }
      assert.equal(opened.body.repository, realpathSync.native(current.target));
      assert.equal(opened.body.startedJob, false);
      assert.equal((await request(childUrl, "/api/status")).body.job, null);
      assert.equal((await request(url, "/api/status")).body.job, null);
      assert.equal(executions, 0);
      await dashboard.close();
      if (independent) {
        assert.equal((await request(childUrl, "/api/status")).status, 200);
      } else {
        await assert.rejects(fetch(new URL("/api/status", childUrl), { signal: AbortSignal.timeout(1000) }));
      }
    } finally {
      await dashboard.close();
      if (independent) { await independent.close(); }
      rmSync(current.directory, { recursive: true, force: true });
    }
  });
}
