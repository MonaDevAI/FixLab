import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apiAuthenticationConfiguration } from "../dashboard/api-authentication.js";
import { runPortalApiProof } from "../dashboard/portal-api-proof.js";

function fixture() {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-portal-api-proof-"));
  assert.equal(spawnSync("git", ["init", "--quiet", repository]).status, 0);
  mkdirSync(join(repository, ".github", "fixlab"), { recursive: true });
  const helper = join(repository, "session.mjs");
  writeFileSync(helper, `
export async function withApiToken(options, check) {
  if (options.scope !== "api://fixture/read") throw new Error("Wrong scope.");
  await check("fixture-api-token");
}
export function assertApiResponse(value) { return value.schema === "expected"; }
`);
  const configuration = { role: "portal", url: "https://localhost:50443/protected",
    scope: "api://fixture/read", sessionHelper: "session.mjs" };
  const profile = { environments: ["local"], browserAutomation: {
    workingDirectory: ".", apiAuthentication: configuration,
    dataSafety: { productionAllowed: false, allowedOrigins: ["https://localhost:50443"], allowedMethods: ["GET"] }
  } };
  const profilePath = join(repository, ".github", "fixlab", "repository-profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  return { repository, helper, configuration, profile, profilePath };
}

function factory({ anonymousStatus = 401, authenticatedStatus = 200, schema = "expected", onAuthenticated } = {}) {
  const calls = [];
  let contexts = 0;
  let disposed = 0;
  return {
    calls, get disposed() { return disposed === contexts; }, get contexts() { return contexts; },
    async newContext(options) {
      contexts += 1;
      assert.equal(options.ignoreHTTPSErrors, false);
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.baseURL, "https://localhost:50443");
      assert.deepEqual(options.extraHTTPHeaders, { Accept: "application/json" });
      return {
        async get(path, request) {
          assert.equal(path, "/protected");
          assert.equal(request.maxRedirects, 0);
          calls.push(request);
          assert.equal(request.headers?.Accept ?? options.extraHTTPHeaders.Accept, "application/json");
          if (request.headers?.Authorization) {
            assert.equal(request.headers.Authorization, "Bearer fixture-api-token");
            onAuthenticated?.();
          }
          return {
            status: () => request.headers?.Authorization ? authenticatedStatus : anonymousStatus,
            json: async () => ({ schema }), async dispose() {}
          };
        },
        async dispose() { disposed += 1; }
      };
    }
  };
}

test("portal APIRequestContext receives only an in-memory API token and persists only sanitized proof", async () => {
  const current = fixture();
  const request = factory();
  try {
    await assert.rejects(runPortalApiProof(current.repository), /confirmation/u);
    const receipt = await runPortalApiProof(current.repository, {
      confirmed: true, authenticate: true, requestFactory: request
    });
    assert.equal(request.calls.length, 2);
    assert.equal(request.contexts, 2);
    assert.equal(request.calls[0].headers, undefined);
    assert.equal(request.disposed, true);
    assert.equal(receipt.authenticatedStatus, 200);
    const path = join(current.repository, ".auth", "api-ready.json");
    const saved = readFileSync(path, "utf8");
    assert.doesNotMatch(saved, /fixture-api-token|Authorization|Bearer|accessToken|schema.*expected/u);
    const fresh = await runPortalApiProof(current.repository, { confirmed: true, requestFactory: factory() });
    assert.equal(fresh.schema, "passed");
    assert.equal(readFileSync(path, "utf8"), saved);
  } finally { rmSync(current.repository, { recursive: true, force: true }); }
});

test("failed real API checks and changed configuration never create readiness", async () => {
  const current = fixture();
  try {
    for (const options of [{ anonymousStatus: 200 }, { authenticatedStatus: 403 }, { schema: "wrong" }, {
      onAuthenticated() {
        current.profile.browserAutomation.apiAuthentication.scope = "api://fixture/changed";
        writeFileSync(current.profilePath, JSON.stringify(current.profile));
      }
    }]) {
      const request = factory(options);
      await assert.rejects(runPortalApiProof(current.repository, {
        confirmed: true, authenticate: true, requestFactory: request
      }));
      assert.equal(request.disposed, true);
      assert.equal(existsSync(join(current.repository, ".auth", "api-ready.json")), false);
    }
  } finally { rmSync(current.repository, { recursive: true, force: true }); }
});

test("onboarding API configuration rejects unsafe URLs, scopes and external session helpers", () => {
  const current = fixture();
  try {
    for (const change of [
      { url: "https://example.com/protected" }, { url: "http://localhost:50443/protected" },
      { url: "https://localhost:50443/protected?token=forbidden" },
      { scope: "https://graph.microsoft.com/User.Read" }, { scope: "api://fixture" },
      { scope: "api://fixture/read another-scope" }, { sessionHelper: "../external.mjs" }
    ]) {
      assert.throws(() => apiAuthenticationConfiguration(current.repository, { ...current.configuration, ...change }));
    }
  } finally { rmSync(current.repository, { recursive: true, force: true }); }
});

test("portal sign-in alone never counts as an authenticated API check", async () => {
  const current = fixture();
  try {
    writeFileSync(current.helper, `
export async function withApiToken() {}
export function assertApiResponse() { return true; }
`);
    const request = factory();
    await assert.rejects(runPortalApiProof(current.repository, {
      confirmed: true, authenticate: true, requestFactory: request
    }), /did not complete a real authenticated API assertion/u);
    assert.equal(request.contexts, 1);
    assert.equal(existsSync(join(current.repository, ".auth", "api-ready.json")), false);
  } finally { rmSync(current.repository, { recursive: true, force: true }); }
});

test("production database opt-in requires a successful read-only check before any API or token activity", async () => {
  for (const guard of ["", "export async function assertReadOnlyDatabase() { return false; }",
    "export async function assertReadOnlyDatabase() { throw new Error('Permission check failed'); }"]) {
    const current = fixture();
    const request = factory();
    try {
      current.profile.browserAutomation.apiAuthentication.productionDatabaseReadOnly = true;
      writeFileSync(current.profilePath, JSON.stringify(current.profile));
      writeFileSync(current.helper, `
export async function withApiToken() { throw new Error("Token activity must not start"); }
export function assertApiResponse() { return true; }
${guard}
`);
      await assert.rejects(runPortalApiProof(current.repository, {
        confirmed: true, authenticate: true, requestFactory: request
      }));
      assert.equal(request.contexts, 0);
      assert.equal(existsSync(join(current.repository, ".auth", "api-ready.json")), false);
    } finally { rmSync(current.repository, { recursive: true, force: true }); }
  }
});

test("approved production database proof remains local and persists accurately labeled sanitized evidence", async () => {
  const current = fixture();
  const request = factory();
  try {
    current.profile.browserAutomation.apiAuthentication.productionDatabaseReadOnly = true;
    writeFileSync(current.profilePath, JSON.stringify(current.profile));
    writeFileSync(current.helper, `${readFileSync(current.helper, "utf8")}
export async function assertReadOnlyDatabase({ apiUrl, method, dataEnvironment }) {
  return apiUrl === "https://localhost:50443/protected" &&
    method === "GET" && dataEnvironment === "production";
}
`);
    const receipt = await runPortalApiProof(current.repository, {
      confirmed: true, authenticate: true, requestFactory: request
    });
    assert.equal(receipt.source, "production-read-only");
    assert.equal(receipt.dataEnvironment, "production");
    assert.equal(receipt.mutationMode, "none");
    assert.equal(request.disposed, true);
    const saved = readFileSync(join(current.repository, ".auth", "api-ready.json"), "utf8");
    assert.doesNotMatch(saved, /fixture-api-token|Authorization|Bearer/u);
    assert.throws(() => apiAuthenticationConfiguration(current.repository, {
      ...current.configuration, productionDatabaseReadOnly: "true"
    }), /boolean opt-in/u);
    assert.throws(() => apiAuthenticationConfiguration(current.repository, {
      ...current.configuration, productionDatabaseReadOnly: true, url: "https://production.example.invalid/protected"
    }), /local HTTPS/u);
  } finally { rmSync(current.repository, { recursive: true, force: true }); }
});

test("a missing or public local backend blocks before opening a portal session", async () => {
  const current = fixture();
  try {
    writeFileSync(current.helper, `
export async function withApiToken() { throw new Error("Portal must not open before local API preflight."); }
export function assertApiResponse() { return true; }
`);
    await assert.rejects(runPortalApiProof(current.repository, {
      confirmed: true, requestFactory: factory({ anonymousStatus: 200 })
    }), /must reject anonymous/u);
    const unreachable = { async newContext() {
      return { async get() { throw new Error("Local backend unavailable."); }, async dispose() {} };
    } };
    await assert.rejects(runPortalApiProof(current.repository, {
      confirmed: true, requestFactory: unreachable
    }), /Local backend unavailable/u);
  } finally { rmSync(current.repository, { recursive: true, force: true }); }
});

test("Playwright resolves from the configured application rather than the helper directory", async () => {
  const current = fixture();
  try {
    const application = join(current.repository, "web");
    const dependency = join(application, "node_modules", "@playwright", "test");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "package.json"), JSON.stringify({ main: "index.cjs" }));
    writeFileSync(join(dependency, "index.cjs"), `
module.exports.request = { async newContext() { return {
  async get(path, options) { return {
    status: () => options.headers ? 200 : 401,
    json: async () => ({ schema: "expected" }), async dispose() {}
  }; }, async dispose() {}
}; } };
`);
    current.profile.browserAutomation.workingDirectory = "web";
    writeFileSync(current.profilePath, JSON.stringify(current.profile));
    const receipt = await runPortalApiProof(current.repository, { confirmed: true });
    assert.equal(receipt.authenticatedStatus, 200);
  } finally { rmSync(current.repository, { recursive: true, force: true }); }
});
