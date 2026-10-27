import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalExecutionRepository } from "./executor-lease.js";
import { resolveLinkedApplications } from "./linked-applications.js";
import { localRepository } from "./repository-settings.js";
import { SETUP_PROFILE_PATH, setupPath } from "./repository-setup.js";
import { createSessionRegistry } from "./sessions.js";
import { apiAuthenticationConfiguration } from "./api-authentication.js";

function profileAt(repository) {
  const path = setupPath(repository, SETUP_PROFILE_PATH);
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536) {
    throw new Error("Linked API proof requires unlinked repository profiles no larger than 64 KiB.");
  }
  try {
    const profile = JSON.parse(readFileSync(path, "utf8"));
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("Invalid profile object.");
    }
    return profile;
  } catch {
    throw new Error("Linked API proof requires valid JSON repository profiles.");
  }
}

export function linkedApiProofPlan(repository) {
  const root = localRepository(repository);
  const profile = profileAt(root);
  const authentication = profile.browserAutomation?.authentication;
  if (profile.browserAutomation?.mode !== "api" ||
      typeof authentication?.linkedApplication !== "string") {
    throw new Error("The API-only profile must explicitly select authentication.linkedApplication.");
  }
  const link = resolveLinkedApplications(root, profile)
    .find((entry) => entry.id === authentication.linkedApplication);
  if (!link) { throw new Error("The authentication provider must be a configured linked application."); }
  const api = profile.browserAutomation.apiAuthentication
    ? apiAuthenticationConfiguration(root, profile.browserAutomation.apiAuthentication) : null;
  if (api && api.role !== "consumer") {
    throw new Error("A linked API authentication request must use the consumer role.");
  }
  const url = new URL(api?.url ?? profile.applications?.backend?.healthUrl);
  if (new URL(profile.applications?.backend?.healthUrl).origin !== url.origin) {
    throw new Error("API proof must target the consumer's configured local backend origin.");
  }
  const safety = profile.browserAutomation.dataSafety;
  if (url.protocol !== "https:" || !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.search || url.hash ||
      !Array.isArray(safety.allowedOrigins) || !safety.allowedOrigins.includes(url.origin) ||
      !Array.isArray(safety.allowedMethods) || !safety.allowedMethods.includes("GET")) {
    throw new Error("Linked API proof requires an explicitly approved local HTTPS read-only endpoint.");
  }
  const producerProfile = profileAt(link.repository);
  const producer = producerProfile.browserAutomation?.authentication;
  if (api) {
    const producerApi = apiAuthenticationConfiguration(link.repository, producerProfile.browserAutomation?.apiAuthentication);
    if (producerApi.role !== "portal" || producerApi.scope !== api.scope || producerApi.url !== api.url ||
        (producerApi.productionDatabaseReadOnly === true) !== (api.productionDatabaseReadOnly === true)) {
      throw new Error("The frontend and API onboarding must approve the same API scope, exact URL and database environment.");
    }
  }
  const grants = producer?.apiProofFor;
  const consumerMatches = (grant) => grant.repository === root ||
    (grant.includeWorktrees === true &&
      canonicalExecutionRepository(localRepository(grant.repository)).key === canonicalExecutionRepository(root).key);
  if (!producer?.command?.trim() || !producer.proofCommand?.trim() ||
      !Array.isArray(grants) || grants.length > 8 ||
      !grants.some((grant) => grant && Object.keys(grant).every((key) =>
        ["repository", "origin", "method", "path", "includeWorktrees", "productionDatabaseReadOnly"].includes(key)) &&
        (grant.includeWorktrees === undefined || typeof grant.includeWorktrees === "boolean") &&
        (grant.productionDatabaseReadOnly === undefined || typeof grant.productionDatabaseReadOnly === "boolean") &&
        (grant.productionDatabaseReadOnly === true) === (api?.productionDatabaseReadOnly === true) &&
        consumerMatches(grant) && grant.origin === url.origin &&
        grant.method === "GET" && grant.path === url.pathname)) {
    throw new Error("The frontend owner must explicitly grant API proof for this repository and exact endpoint.");
  }
  if (typeof profile.browserAutomation.workingDirectory !== "string" ||
      !Array.isArray(authentication.statusPaths) || authentication.statusPaths.length !== 1 ||
      typeof authentication.statusPaths[0] !== "string") {
    throw new Error("Linked API proof requires one contained non-secret status receipt.");
  }
  const workingDirectory = setupPath(root, profile.browserAutomation.workingDirectory);
  const statusPath = authentication.statusPaths[0];
  if (statusPath.split(/[/\\]/u)[0] !== ".auth" || !statusPath.endsWith(".json")) {
    throw new Error("Linked API proof receipts must be JSON files under the authentication .auth directory.");
  }
  const receipt = setupPath(workingDirectory, statusPath);
  if (!lstatSync(workingDirectory).isDirectory()) {
    throw new Error("The API authentication working directory must exist.");
  }
  return { repository: root, application: link.id, providerRepository: link.repository,
    revision: link.revision, portalApiProof: Boolean(api),
    environment: "local", productionDatabaseReadOnly: api?.productionDatabaseReadOnly === true,
    origin: url.origin, method: "GET", path: url.pathname, receipt };
}

async function json(url, path, body) {
  const response = await fetch(new URL(path, url), {
    redirect: "error", signal: AbortSignal.timeout(5000),
    ...(body === undefined ? {} : { method: "POST",
      headers: { "Content-Type": "application/json", Origin: url }, body: JSON.stringify(body) })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`The linked workspace rejected API proof (HTTP ${response.status}); inspect its own dashboard.`);
  }
  if (text.length > 65536) { throw new Error("The linked workspace returned oversized proof metadata."); }
  try { return JSON.parse(text); } catch { throw new Error("The linked workspace returned invalid proof metadata."); }
}

export async function runLinkedApiProof(repository, { authenticate = false, confirmed = false } = {}) {
  if (!confirmed) { throw new Error("Linked API proof requires explicit --yes confirmation."); }
  if (process.env.FIXLAB_TARGET_ENVIRONMENT && process.env.FIXLAB_TARGET_ENVIRONMENT !== "local") {
    throw new Error("Linked API proof is permitted only in the local environment.");
  }
  const plan = linkedApiProofPlan(repository);
  const verify = () => {
    const current = linkedApiProofPlan(repository);
    if (JSON.stringify(current) !== JSON.stringify(plan)) {
      throw new Error("Linked API proof configuration changed; rerun the reviewed authentication.");
    }
  };
  const common = canonicalExecutionRepository(plan.providerRepository).repository;
  const registry = createSessionRegistry(plan.providerRepository);
  const catalog = await registry.repositories({ scopeIds: [registry.scopeId,
    createSessionRegistry(createHash("sha256").update(common).digest("hex")).scopeId] });
  const owners = catalog.repositories.filter((entry) => entry.repository === plan.providerRepository);
  if (catalog.unavailableCount || owners.length !== 1) {
    throw new Error("API proof requires exactly one verified, reachable frontend workspace owner.");
  }
  const owner = owners[0];
  const initialSession = await json(owner.url, "/api/session");
  if (initialSession.id !== owner.id || initialSession.repository !== plan.providerRepository) {
    throw new Error("The frontend workspace owner changed before API proof.");
  }
  if (initialSession.job?.running || initialSession.authentication?.running) {
    throw new Error("The frontend workspace is busy; wait for its owned job or authentication to settle.");
  }
  verify();
  const started = await json(owner.url, "/api/playwright/connect", {
    proofOnly: !authenticate, apiProof: plan.portalApiProof, confirmed: true, instanceId: owner.id
  });
  if (typeof started.runId !== "string" || !/^[a-f0-9-]{36}$/u.test(started.runId)) {
    throw new Error("The linked workspace must support identity-bound fresh proof runs.");
  }
  const deadline = Date.now() + (authenticate ? 900000 : 180000);
  while (Date.now() < deadline) {
    await delay(500);
    verify();
    const session = await json(owner.url, "/api/session");
    if (session.id !== owner.id || session.repository !== plan.providerRepository ||
        (session.job?.id ?? null) !== (initialSession.job?.id ?? null)) {
      throw new Error("The frontend owner or job changed during API proof.");
    }
    const status = await json(owner.url, "/api/playwright/status");
    if (status.runId !== started.runId) { throw new Error("The frontend authentication run changed during API proof."); }
    if (status.running) { continue; }
    if (!status.ready || status.lastResult?.ok !== true) {
      throw new Error("The frontend-owned API proof failed; inspect authentication in its own dashboard.");
    }
    verify();
    const receipt = { version: 1, verifiedAt: new Date().toISOString(), environment: plan.environment,
      application: plan.application, providerInstance: owner.id, runId: started.runId,
      configurationRevision: plan.revision, origin: plan.origin, method: plan.method, path: plan.path,
      source: plan.productionDatabaseReadOnly ? "production-read-only" : "non-production-read-only",
      dataEnvironment: plan.productionDatabaseReadOnly ? "production" : "non-production", mutationMode: "none" };
    if (authenticate) {
      const path = linkedApiProofPlan(repository).receipt;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      setupPath(plan.repository, relative(plan.repository, path));
      try {
        const info = lstatSync(path);
        if (!info.isFile() || info.nlink !== 1 || info.isSymbolicLink()) {
          throw new Error("The API receipt must be an unlinked regular file.");
        }
      } catch (error) {
        if (error.code !== "ENOENT") { throw error; }
      }
      writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 });
    }
    return receipt;
  }
  throw new Error("The frontend-owned API proof timed out; inspect its owned authentication before retrying.");
}
