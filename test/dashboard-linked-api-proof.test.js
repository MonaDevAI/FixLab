import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { linkedApiProofPlan, runLinkedApiProof } from "../dashboard/linked-api-proof.js";
import { createDashboardServer } from "../dashboard/server.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const profilePath = (root) => join(root, ".github", "fixlab", "repository-profile.json");
const save = (root, profile) => writeFileSync(profilePath(root), JSON.stringify(profile));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "fixlab-linked-api-proof-"));
  const source = join(directory, "api");
  const target = join(directory, "web");
  for (const root of [source, target]) {
    mkdirSync(join(root, ".github", "fixlab"), { recursive: true });
    assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
  }
  const sourceProfile = {
    environments: ["local"],
    applications: { backend: { healthUrl: "https://localhost:50443/protected" } },
    linkedApplications: [{ id: "web", repository: target, application: "frontend",
      url: "http://localhost:43001", environment: "local" }],
    browserAutomation: { mode: "api", workingDirectory: ".",
      authentication: { linkedApplication: "web", statusPaths: [".auth/ready.json"] },
      dataSafety: { productionAllowed: false, allowedOrigins: ["https://localhost:50443"], allowedMethods: ["GET"] } }
  };
  const targetProfile = {
    environments: ["local"],
    applications: { frontend: { command: "node frontend.mjs", workingDirectory: ".", port: 43001,
      healthUrl: "http://localhost:43001/health" } },
    browserAutomation: { workingDirectory: ".", dataSafety: { productionAllowed: false },
      authentication: { command: "node auth.mjs authenticate", proofCommand: "node auth.mjs proof",
        statusPaths: [".auth/session.json"],
        apiProofFor: [{ repository: source, origin: "https://localhost:50443", method: "GET", path: "/protected" }] } }
  };
  writeFileSync(join(target, "auth.mjs"), `
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
if (process.argv[2] === "authenticate") {
  mkdirSync(".auth", { recursive: true });
  writeFileSync(".auth/session.json", JSON.stringify({ fixture: true }));
  writeFileSync("authentication-started", "yes");
} else if (!existsSync(".auth/session.json")) {
  process.exitCode = 2;
}
`);
  save(source, sourceProfile);
  save(target, targetProfile);
  return { directory, source, target, sourceProfile, targetProfile };
}

test("linked API proof requires reciprocal exact local read-only grants and a safe receipt", () => {
  const current = fixture();
  try {
    assert.equal(linkedApiProofPlan(current.source).method, "GET");
    for (const mutate of [
      (profile) => { profile.browserAutomation.authentication.apiProofFor = []; },
      (profile) => { profile.browserAutomation.authentication.apiProofFor[0].repository = current.target; },
      (profile) => { profile.browserAutomation.authentication.apiProofFor[0].origin = "https://localhost:50444"; },
      (profile) => { profile.browserAutomation.authentication.apiProofFor[0].method = "POST"; },
      (profile) => { profile.browserAutomation.authentication.apiProofFor[0].path = "/another"; },
      (profile) => { profile.browserAutomation.authentication.proofCommand = ""; },
      (profile) => { profile.browserAutomation.dataSafety.productionAllowed = true; }
    ]) {
      const profile = structuredClone(current.targetProfile);
      mutate(profile);
      save(current.target, profile);
      assert.throws(() => linkedApiProofPlan(current.source));
    }
    save(current.target, current.targetProfile);
    for (const path of ["../ready.json", ".auth/../../ready.json", "auth.mjs", ".auth/session.txt"]) {
      current.sourceProfile.browserAutomation.authentication.statusPaths = [path];
      save(current.source, current.sourceProfile);
      assert.throws(() => linkedApiProofPlan(current.source));
    }
  } finally { rmSync(current.directory, { recursive: true, force: true }); }
});

test("frontend owns authentication and fresh proof; only sanitized evidence reaches the API", async () => {
  const current = fixture();
  const dashboard = createDashboardServer({ repository: current.target, packageRoot, browserOwnership: () => null });
  try {
    const url = (await dashboard.listen({ port: 0 })).url;
    await assert.rejects(runLinkedApiProof(current.source), /confirmation/u);
    const receipt = await runLinkedApiProof(current.source, { confirmed: true, authenticate: true });
    assert.equal(receipt.origin, "https://localhost:50443");
    assert.ok(existsSync(join(current.target, "authentication-started")));
    assert.equal(existsSync(join(current.source, ".auth", "session.json")), false);
    assert.doesNotMatch(JSON.stringify(receipt), /fixture|session\.json|authorization|accessToken/u);
    const saved = readFileSync(join(current.source, ".auth", "ready.json"), "utf8");
    rmSync(join(current.target, "authentication-started"));
    const fresh = await runLinkedApiProof(current.source, { confirmed: true });
    assert.notEqual(fresh.runId, receipt.runId);
    assert.equal(existsSync(join(current.target, "authentication-started")), false);
    assert.equal(readFileSync(join(current.source, ".auth", "ready.json"), "utf8"), saved);
    const session = await (await fetch(`${url}/api/session`)).json();
    for (const [body, origin, status] of [
      [{ proofOnly: true, confirmed: true, instanceId: session.id }, "http://untrusted.invalid", 403],
      [{ proofOnly: true, confirmed: true, instanceId: "stale" }, url, 409],
      [{ proofOnly: true, confirmed: false, instanceId: session.id }, url, 409]
    ]) {
      const response = await fetch(`${url}/api/playwright/connect`, { method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
      assert.equal(response.status, status);
    }
    rmSync(join(current.target, ".auth", "session.json"));
    await assert.rejects(runLinkedApiProof(current.source, { confirmed: true }), /rejected API proof|proof failed/u);
    assert.equal(readFileSync(join(current.source, ".auth", "ready.json"), "utf8"), saved);
  } finally {
    await dashboard.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("an unreachable or absent frontend owner cannot produce API readiness", async () => {
  const current = fixture();
  try {
    await assert.rejects(runLinkedApiProof(current.source, { confirmed: true }), /exactly one verified/u);
    assert.equal(existsSync(join(current.source, ".auth", "ready.json")), false);
  } finally { rmSync(current.directory, { recursive: true, force: true }); }
});

test("portal API proof is explicitly selected without replacing normal browser authentication", async () => {
  const current = fixture();
  const url = "https://localhost:50443/protected";
  const scope = "api://fixture/read";
  current.sourceProfile.browserAutomation.apiAuthentication = { role: "consumer", url, scope };
  current.targetProfile.browserAutomation.apiAuthentication = {
    role: "portal", url, scope, sessionHelper: "session.mjs",
    command: "node api-auth.mjs authenticate", proofCommand: "node api-auth.mjs proof",
    statusPaths: [".auth/api-ready.json"]
  };
  current.targetProfile.browserAutomation.dataSafety.allowedOrigins = ["https://localhost:50443"];
  current.targetProfile.browserAutomation.dataSafety.allowedMethods = ["GET"];
  writeFileSync(join(current.target, "session.mjs"), "export const fixture = true;");
  writeFileSync(join(current.target, "api-auth.mjs"), `
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
if (process.env.FIXLAB_TARGET_ENVIRONMENT !== "local") process.exit(3);
if (process.argv[2] === "authenticate") {
  mkdirSync(".auth", { recursive: true });
  writeFileSync(".auth/api-ready.json", JSON.stringify({ fixture: true }));
  writeFileSync("api-authentication-started", "yes");
} else if (!existsSync(".auth/api-ready.json")) process.exitCode = 2;
`);
  save(current.source, current.sourceProfile);
  save(current.target, current.targetProfile);
  const dashboard = createDashboardServer({ repository: current.target, packageRoot, browserOwnership: () => null });
  try {
    const url = (await dashboard.listen({ port: 0 })).url;
    const connected = await fetch(`${url}/api/playwright/connect`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: url }, body: "{}" });
    assert.equal(connected.status, 202);
    let status;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = await (await fetch(`${url}/api/playwright/status`)).json();
      if (!status.running) { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status.ready, true);
    assert.equal(existsSync(join(current.target, "authentication-started")), true);
    assert.equal(existsSync(join(current.target, "api-authentication-started")), false);
    const unconfirmed = await fetch(`${url}/api/playwright/connect`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ apiProof: true }) });
    assert.equal(unconfirmed.status, 409);
    const receipt = await runLinkedApiProof(current.source, { confirmed: true, authenticate: true });
    assert.equal(receipt.origin, "https://localhost:50443");
    assert.equal(existsSync(join(current.target, "api-authentication-started")), true);
    assert.equal(existsSync(join(current.source, ".auth", "api-ready.json")), false);
    const fresh = await runLinkedApiProof(current.source, { confirmed: true });
    assert.notEqual(fresh.runId, receipt.runId);
    current.targetProfile.browserAutomation.mode = "api";
    const api = current.targetProfile.browserAutomation.apiAuthentication;
    Object.assign(current.targetProfile.browserAutomation.authentication, {
      command: api.command, proofCommand: api.proofCommand, statusPaths: api.statusPaths
    });
    save(current.target, current.targetProfile);
    const apiConnected = await fetch(`${url}/api/playwright/connect`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: url }, body: "{}" });
    assert.equal(apiConnected.status, 202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = await (await fetch(`${url}/api/playwright/status`)).json();
      if (!status.running) { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status.ready, true);
    writeFileSync(join(current.target, "session.mjs"), "export const changedFixture = true;");
    status = await (await fetch(`${url}/api/playwright/status`)).json();
    assert.equal(status.ready, false);
  } finally {
    await dashboard.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("consumer worktrees need explicit permission and must share the granted Git repository", () => {
  const current = fixture();
  const worktree = join(current.directory, "api-job");
  try {
    const commit = spawnSync("git", ["-c", "user.name=FixLab", "-c", "user.email=fixlab@example.invalid",
      "commit", "--allow-empty", "--quiet", "-m", "fixture"], { cwd: current.source });
    assert.equal(commit.status, 0);
    assert.equal(spawnSync("git", ["worktree", "add", "--quiet", "-b", "fixture-job", worktree],
      { cwd: current.source }).status, 0);
    mkdirSync(join(worktree, ".github", "fixlab"), { recursive: true });
    save(worktree, current.sourceProfile);
    assert.throws(() => linkedApiProofPlan(worktree), /explicitly grant/u);
    current.targetProfile.browserAutomation.authentication.apiProofFor[0].includeWorktrees = true;
    save(current.target, current.targetProfile);
    assert.equal(linkedApiProofPlan(worktree).method, "GET");
    current.targetProfile.browserAutomation.authentication.apiProofFor[0].repository = current.target;
    save(current.target, current.targetProfile);
    assert.throws(() => linkedApiProofPlan(worktree), /explicitly grant/u);
  } finally { rmSync(current.directory, { recursive: true, force: true }); }
});

test("production database reads require matching approvals and a production-specific reciprocal grant", () => {
  const current = fixture();
  try {
    writeFileSync(join(current.target, "session.mjs"), "export async function withApiToken() {}");
    current.sourceProfile.browserAutomation.apiAuthentication = {
      role: "consumer", url: "https://localhost:50443/protected",
      scope: "api://fixture/read", productionDatabaseReadOnly: true
    };
    current.targetProfile.browserAutomation.apiAuthentication = {
      role: "portal", url: "https://localhost:50443/protected",
      scope: "api://fixture/read", sessionHelper: "session.mjs"
    };
    save(current.source, current.sourceProfile);
    save(current.target, current.targetProfile);
    assert.throws(() => linkedApiProofPlan(current.source), /database environment/u);
    current.targetProfile.browserAutomation.apiAuthentication.productionDatabaseReadOnly = true;
    save(current.target, current.targetProfile);
    assert.throws(() => linkedApiProofPlan(current.source), /explicitly grant/u);
    current.targetProfile.browserAutomation.authentication.apiProofFor[0].productionDatabaseReadOnly = true;
    save(current.target, current.targetProfile);
    assert.equal(linkedApiProofPlan(current.source).productionDatabaseReadOnly, true);
    delete current.sourceProfile.browserAutomation.apiAuthentication.productionDatabaseReadOnly;
    save(current.source, current.sourceProfile);
    assert.throws(() => linkedApiProofPlan(current.source), /database environment/u);
  } finally { rmSync(current.directory, { recursive: true, force: true }); }
});
