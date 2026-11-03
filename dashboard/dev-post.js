import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { apiScope, apiSessionHelper } from "./api-authentication.js";
import { safeRuntimeText } from "./runtime-requests.js";
import { SETUP_PROFILE_PATH, setupPath } from "./repository-setup.js";

function configurationAt(repository, environment = "dev", jobConsent = false) {
  const path = setupPath(repository, SETUP_PROFILE_PATH);
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536) {
    throw new Error("POST requires an unlinked, bounded repository profile.");
  }
  const raw = readFileSync(path);
  let profile;
  try { profile = JSON.parse(raw.toString("utf8")); } catch {
    throw new Error("POST requires a valid JSON repository profile.");
  }
  const safety = profile.browserAutomation?.dataSafety;
  const configuration = safety?.post?.[environment] ??
    (environment === "dev" ? safety?.devPost : undefined);
  if (!configuration) { return null; }
  const environments = Array.isArray(profile.environments)
    ? profile.environments : Object.keys(profile.environments ?? {});
  if (!environments.some((value) => typeof value === "string" && value.toLowerCase() === environment) ||
      safety.productionAllowed !== false || profile.validation?.liveTestsRequired === false ||
      profile.browserAutomation.mode === "api" ||
      profile.browserAutomation.apiAuthentication?.productionDatabaseReadOnly === true ||
      (jobConsent
        ? !["non-production-approved", "non-production-read-only", "synthetic-intercepted", "local-fixture"]
          .includes(profile.browserAutomation.testSynthesis?.defaultDataSource)
        : profile.browserAutomation.testSynthesis?.defaultDataSource !== "non-production-approved" ||
          profile.browserAutomation.testSynthesis?.mutationMode !== "approved-write")) {
    throw new Error("POST requires explicit non-production endpoint approval; API-only and production-backed read-only contracts remain unchanged.");
  }
  const helper = apiSessionHelper(repository, configuration.sessionHelper);
  if (!helper.endsWith(".mjs")) {
    throw new Error("POST requires an existing .mjs session helper for revision-bound loading.");
  }
  const scope = apiScope(configuration.scope);
  if (!Array.isArray(configuration.actions) || !configuration.actions.length ||
      configuration.actions.length > 16) {
    throw new Error("POST requires 1-16 exact, repository-approved endpoint/test-record actions.");
  }
  for (const action of configuration.actions) {
    const url = new URL(action?.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        url.href !== action.url || !safeRuntimeText(action.url, 1000) ||
        /(?:^|[.-])(?:prod|prd|production)(?:[.-]|$)/iu.test(url.hostname) ||
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(action.testRecord?.field) ||
        typeof action.testRecord?.value !== "string" || !action.testRecord.value.trim() ||
        !safeRuntimeText(action.testRecord.value, 200)) {
      throw new Error("POST actions require exact credential-free HTTPS URLs and an explicit safe test-record field/value.");
    }
  }
  return { configuration, helper, scope,
    revision: createHash("sha256").update(raw).update(readFileSync(helper)).digest("hex") };
}

export function createPostWriteApproval(repository, targetEnvironment, jobId) {
  const environment = typeof targetEnvironment === "string" ? targetEnvironment.toLowerCase() : "";
  if (!["dev", "sit", "uat"].includes(environment) ||
      typeof jobId !== "string" || !/^[a-f0-9-]{36}$/u.test(jobId)) {
    throw new Error("Job-scoped POST approval requires an exact job and DEV/SIT/UAT environment.");
  }
  return { jobId, environment, revision: configurationAt(repository, environment, true)?.revision ?? null };
}

export function createNonProductionPostTool({ repository, targetEnvironment, mutationMode,
  selectedMutationMode = "", allowPostRequests, postWriteApproval, jobId, isReady, ask,
  request = fetch, now = Date.now }) {
  if (allowPostRequests !== undefined && typeof allowPostRequests !== "boolean") {
    throw new Error("allowPostRequests must be a boolean.");
  }
  const environment = typeof targetEnvironment === "string" ? targetEnvironment.toLowerCase() : "";
  const jobConsent = typeof allowPostRequests === "boolean";
  const jobScoped = postWriteApproval !== undefined && postWriteApproval !== null;
  if (jobScoped &&
      (typeof postWriteApproval !== "object" || Array.isArray(postWriteApproval) ||
        allowPostRequests !== true || postWriteApproval.jobId !== jobId ||
        postWriteApproval.environment !== environment ||
        typeof jobId !== "string" || !/^[a-f0-9-]{36}$/u.test(jobId) ||
        (postWriteApproval.revision !== null &&
          !/^[a-f0-9]{64}$/u.test(postWriteApproval.revision)))) {
    throw new Error("Invalid job-scoped POST approval; start a newly reviewed job.");
  }
  const approvedRevision = postWriteApproval?.revision;
  let approvalStopped = false;
  if (!["dev", "sit", "uat"].includes(environment) || selectedMutationMode ||
      (!jobConsent && (environment !== "dev" || mutationMode !== "approved-write"))) {
    return null;
  }
  const planAt = () => configurationAt(repository, environment, jobConsent);
  if (!jobConsent && !planAt()) { return null; }
  const label = environment.toUpperCase();
  return {
    name: !jobConsent && environment === "dev" ? "fixlab_dev_post" : "fixlab_nonproduction_post",
    description: `Send one ${label} POST using its configured endpoint/test-record allowlist and existing authentication helper. ${jobScoped ? "The user approved this job's configured writes through the POST checkbox; no repeat confirmation is needed. Approval is bound to this job and the reviewed profile/helper revision." : "The complete URL and JSON payload require individual human confirmation, even with Allow all."} Missing setup blocks the action, not unrelated work. No redirects, retries, credentials or response bodies. This is a real write, not intercepted evidence.`,
    skipPermission: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: 1000 },
        payload: { type: "object", additionalProperties: true },
        purpose: { type: "string", minLength: 1, maxLength: 200 }
      },
      required: ["url", "payload", "purpose"],
      additionalProperties: false
    },
    async handler(args) {
      if (process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_DEBUG) {
        throw new Error("POST requires credential-sensitive debug logging to be disabled.");
      }
      if (!isReady()) { throw new Error("POST is blocked by policy, the execution budget or executor shutdown."); }
      if (approvalStopped) {
        throw new Error("The job-scoped POST approval has stopped after an unsuccessful attempt or changed configuration. Inspect the selected environment and start a newly reviewed job; no request was sent.");
      }
      const plan = planAt();
      if (!plan) {
        throw new Error(`${label} POST is not configured. Configure dataSafety.post.${environment} with approved endpoints, test records and an existing API session helper. No request was sent.`);
      }
      if (jobScoped && approvedRevision !== plan.revision) {
        approvalStopped = true;
        throw new Error("POST policy/helper changed or was not configured at approval; start a newly reviewed job. No request was sent.");
      }
      if (!args || Object.keys(args).some((key) => !["url", "payload", "purpose"].includes(key)) ||
          !args.payload || typeof args.payload !== "object" || Array.isArray(args.payload) ||
          !safeRuntimeText(args.purpose, 200) || !args.purpose.trim()) {
        throw new Error("POST requires an exact URL, JSON object and non-sensitive purpose.");
      }
      const payload = JSON.stringify(args.payload);
      if (!safeRuntimeText(payload, 4000)) {
        throw new Error("POST payload is sensitive or oversized; it cannot be reviewed or sent.");
      }
      const body = JSON.parse(payload);
      const action = plan.configuration.actions.find((value) => value.url === args.url &&
        Object.hasOwn(body, value.testRecord.field) &&
        body[value.testRecord.field] === value.testRecord.value);
      if (!action) { throw new Error("POST endpoint or test record is not explicitly allowlisted."); }
      const url = action.url;
      const expiresAt = now() + 300000;
      if (!jobScoped) {
        const details = JSON.stringify({ environment: label, method: "POST", url,
          purpose: args.purpose, payload: body, expiresAt: new Date(expiresAt).toISOString(),
          ...(jobConsent ? { enabledAtJobStart: allowPostRequests } : {}),
          notice: "Real data-changing action. Review every field. One attempt only; no redirects, retries or blanket approval." }, null, 2);
        if (!safeRuntimeText(details)) { throw new Error("POST review is sensitive or oversized."); }
        const decision = await ask({
          kind: "permission", title: `${allowPostRequests === false ? "Allow" : "Confirm"} one ${label} POST action`, details,
          canApprove: true, perAction: true, choices: [], allowFreeform: false
        });
        if (decision.action !== "allow" || decision.scope !== undefined || decision.recover !== undefined) {
          throw new Error("POST was not individually approved; no request was sent.");
        }
      }
      if (!isReady() || now() >= expiresAt || planAt()?.revision !== plan.revision) {
        throw new Error("POST approval expired or its policy/helper changed; no request was sent.");
      }
      let adapter;
      try { adapter = await import(`${pathToFileURL(plan.helper).href}?fixlab=${plan.revision}`); } catch {
        throw new Error("The configured authentication helper could not be loaded; no POST was sent.");
      }
      if (typeof adapter.withApiToken !== "function") {
        throw new Error("The repository session helper must export withApiToken; no request was sent.");
      }
      let attempts = 0;
      let result;
      let accepting = true;
      try {
        await adapter.withApiToken({ scope: plan.scope, interactive: false }, async (value) => {
          if (!accepting || ++attempts !== 1 || typeof value !== "string" || value.length > 65536 ||
              !/^[A-Za-z0-9._~+/-]+=*$/u.test(value) || !isReady() || now() >= expiresAt ||
              process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_DEBUG ||
              planAt()?.revision !== plan.revision) {
            throw new Error("POST approval/authentication is no longer valid.");
          }
          try {
            const response = await request(url, {
              method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000),
              headers: { Accept: "application/json", "Content-Type": "application/json",
                Authorization: `Bearer ${value}` },
              body: payload
            });
            result = { environment: label, method: "POST", status: response.status,
              outcome: "response-received", source: "non-production-approved", mutationMode: "approved-write",
              validationPassed: false, responseBodyReturned: false, automaticRetry: false };
            await response.body?.cancel();
          } catch {
            throw new Error("POST outcome is unknown. Approval is spent. Inspect the selected environment before requesting any new action; no automatic retry was made.");
          }
        });
      } catch {
        approvalStopped = jobScoped;
        if (attempts) {
          throw new Error("POST may have been attempted. Approval is spent. Inspect the selected environment before any new action; no automatic retry was made.");
        }
        throw new Error("POST authentication did not complete; no request was sent. Complete human sign-in using the configured helper.");
      } finally {
        accepting = false;
      }
      if (attempts !== 1 || !result) {
        approvalStopped = jobScoped;
        throw new Error("POST authentication helper did not complete one request. Inspect the selected environment; no automatic retry was made.");
      }
      if (result.status < 200 || result.status >= 300) {
        approvalStopped = jobScoped;
        throw new Error(`POST returned HTTP ${result.status}. Approval is spent; no redirect or automatic retry was made.`);
      }
      return result;
    }
  };
}

export const createDevPostTool = createNonProductionPostTool;
