import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { apiAuthenticationConfiguration } from "./api-authentication.js";
import { localRepository } from "./repository-settings.js";
import { SETUP_PROFILE_PATH, setupPath } from "./repository-setup.js";

function configurationAt(repository) {
  const path = setupPath(repository, SETUP_PROFILE_PATH);
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536) {
    throw new Error("Portal API proof requires an unlinked, bounded repository profile.");
  }
  const raw = readFileSync(path);
  let profile;
  try { profile = JSON.parse(raw.toString("utf8")); } catch {
    throw new Error("Portal API proof requires a valid JSON profile.");
  }
  const configuration = apiAuthenticationConfiguration(repository, profile.browserAutomation?.apiAuthentication);
  const environments = Array.isArray(profile.environments) ? profile.environments : Object.keys(profile.environments ?? {});
  const safety = profile.browserAutomation?.dataSafety;
  if (configuration.role !== "portal" || profile.browserAutomation?.dataSafety?.productionAllowed !== false ||
      !environments.includes("local") ||
      !Array.isArray(safety.allowedOrigins) || !safety.allowedOrigins.includes(new URL(configuration.url).origin) ||
      !Array.isArray(safety.allowedMethods) || !safety.allowedMethods.includes("GET")) {
    throw new Error("Portal API proof requires explicit local, read-only approval; general production access remains disabled.");
  }
  const helper = setupPath(repository, configuration.sessionHelper);
  const workingDirectory = setupPath(repository, profile.browserAutomation.workingDirectory);
  const receipt = setupPath(workingDirectory, ".auth/api-ready.json");
  return { configuration, helper, receipt, workingDirectory,
    revision: createHash("sha256").update(raw).update(readFileSync(helper)).digest("hex") };
}

export function portalApiProofRevision(repository) {
  return configurationAt(repository).revision;
}

export async function runPortalApiProof(repository, {
  authenticate = false, confirmed = false, requestFactory
} = {}) {
  if (!confirmed) { throw new Error("Portal API proof requires explicit --yes confirmation."); }
  if ((process.env.FIXLAB_TARGET_ENVIRONMENT && process.env.FIXLAB_TARGET_ENVIRONMENT !== "local") ||
      process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_DEBUG) {
    throw new Error("Portal API proof requires the local environment and disabled credential-sensitive debug logging.");
  }
  const root = localRepository(repository);
  const plan = configurationAt(root);
  const adapter = await import(pathToFileURL(plan.helper).href);
  if (typeof adapter.withApiToken !== "function" || typeof adapter.assertApiResponse !== "function") {
    throw new Error("The session helper must export withApiToken and assertApiResponse.");
  }
  const productionDatabaseReadOnly = plan.configuration.productionDatabaseReadOnly === true;
  if (productionDatabaseReadOnly) {
    if (typeof adapter.assertReadOnlyDatabase !== "function" ||
        await adapter.assertReadOnlyDatabase({
          apiUrl: plan.configuration.url, method: "GET", dataEnvironment: "production"
        }) !== true) {
      throw new Error("Production database reads require the session helper to verify database-enforced read-only access.");
    }
    if (configurationAt(root).revision !== plan.revision) {
      throw new Error("Production database approval changed during the read-only preflight.");
    }
  }
  const request = requestFactory ?? createRequire(join(plan.workingDirectory, "package.json"))("@playwright/test").request;
  const url = new URL(plan.configuration.url);
  let calls = 0;
  let passed = false;
  const options = { baseURL: url.origin, ignoreHTTPSErrors: false, maxRedirects: 0, timeout: 15000,
    extraHTTPHeaders: { Accept: "application/json" } };
  const anonymousContext = await request.newContext(options);
  try {
    const anonymous = await anonymousContext.get(url.pathname, { maxRedirects: 0 });
    if (anonymous.status() !== 401) { throw new Error("The approved API must reject anonymous requests with 401."); }
    await anonymous.dispose();
  } finally { await anonymousContext.dispose(); }
  await adapter.withApiToken({ scope: plan.configuration.scope, interactive: authenticate }, async (token) => {
    calls += 1;
    if (calls !== 1 || typeof token !== "string" || token.length > 65536 ||
        !/^[A-Za-z0-9._~+/-]+=*$/u.test(token)) {
      throw new Error("The repository session helper did not provide one valid in-memory API token.");
    }
    const context = await request.newContext(options);
    try {
      const response = await context.get(url.pathname, { maxRedirects: 0,
        headers: { Authorization: `Bearer ${token}` } });
      if (response.status() !== 200 || await adapter.assertApiResponse(await response.json()) !== true) {
        throw new Error("The real authenticated API response or repository-owned schema assertion failed.");
      }
      passed = true;
    } finally { await context.dispose(); }
  });
  if (calls !== 1 || !passed) { throw new Error("The session helper did not complete a real authenticated API assertion."); }
  if (configurationAt(root).revision !== plan.revision) {
    throw new Error("Portal API authentication configuration or session helper changed during proof.");
  }
  const receipt = { version: 1, verifiedAt: new Date().toISOString(), configurationRevision: plan.revision,
    origin: url.origin, path: url.pathname, method: "GET", unauthenticatedStatus: 401,
    authenticatedStatus: 200, schema: "passed",
    source: productionDatabaseReadOnly ? "production-read-only" : "non-production-read-only",
    dataEnvironment: productionDatabaseReadOnly ? "production" : "non-production", mutationMode: "none" };
  if (authenticate) {
    mkdirSync(dirname(plan.receipt), { recursive: true, mode: 0o700 });
    const path = configurationAt(root).receipt;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.nlink !== 1) { throw new Error("The API readiness receipt must be an unlinked regular file."); }
    } catch (error) { if (error.code !== "ENOENT") { throw error; } }
    writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 });
  }
  return receipt;
}
