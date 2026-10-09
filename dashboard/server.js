import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import {
  createAzureDevOpsLoader,
  loadRepositoryProfile,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_TOTAL_BYTES,
  MAX_SCREENSHOTS,
  pruneArtifactDirectories,
  removeArtifactDirectory,
  storeScreenshots
} from "./intake.js";
import {
  createStructuredOutput,
  sanitize,
  showStructuredEvidence
} from "../bin/structured-command.js";
import { runPlaywrightTest, withPlaywrightProgress } from "./playwright-runner.js";

export const DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 4317;
export const MAX_JOB_LOG_ENTRIES = 1000;
export const MAX_JOB_ACTIVITY_ENTRIES = 40;
export const MAX_CACHE_ENTRIES = 20;
export const MAX_CACHE_BYTES = 64 * 1024;
export const MAX_METRICS_ENTRIES = 500;
export const MAX_DASHBOARD_HISTORY_ENTRIES = 20;
export const MAX_QUEUED_JOBS = 20;
export const MAX_PLAYWRIGHT_ARTIFACTS = 20;

function validatedManualLocalhostUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("manual localhost URL is required");
  }
  const trimmed = value.trim();
  const url = new URL(trimmed);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "manual localhost URL must use credential-free HTTP(S) on loopback"
    );
  }
  return trimmed;
}

export function openLocalUrl(
  value,
  { platform = process.platform, spawnImpl = spawn } = {}
) {
  const url = new URL(validatedManualLocalhostUrl(value));

  const launchers = {
    win32: ["explorer.exe", [url.href]],
    darwin: ["open", [url.href]],
    linux: ["xdg-open", [url.href]]
  };
  const launcher = launchers[platform];
  if (!launcher) {
    throw new Error(`opening a browser is not supported on ${platform}`);
  }
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawnImpl(launcher[0], launcher[1], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("spawn", () => {
      child.unref?.();
      resolveLaunch();
    });
    child.once("error", rejectLaunch);
  });
}
export const MAX_PLAYWRIGHT_VIDEO_BYTES = 50 * 1024 * 1024;
export const DEFAULT_EXECUTION_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_EXECUTION_HEARTBEAT_MS = 2 * 60 * 1000;
export const FIXLAB_RUNTIMES = ["agency", "copilot"];
export const FIXLAB_STAGES = [
  "intake",
  "diagnosis",
  "reproduce",
  "fix",
  "review",
  "local-stack",
  "live-test",
  "pr"
];

const terminalStatuses = new Set(["passed", "skipped", "blocked", "failed"]);
const allStatuses = new Set(["pending", "running", ...terminalStatuses]);
const bugOutcomeStatuses = new Set([
  "fixed",
  "already-fixed",
  "external",
  "no-change",
  "expected",
  "duplicate",
  "blocked",
  "failed"
]);
const testDataSources = new Set([
  "synthetic-intercepted",
  "local-fixture",
  "non-production-read-only",
  "non-production-approved",
  "profile-defined"
]);
const mutationModes = new Set([
  "intercepted",
  "none",
  "approved-write",
  "profile-defined"
]);
const profileRelativePath = join(
  ".github",
  "fixlab",
  "repository-profile.json"
);
const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"]
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

export function validatePort(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error("dashboard port must be an integer between 1 and 65535");
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("dashboard port must be an integer between 1 and 65535");
  }
  return port;
}

export function validateLiveTestProfile(profile, repository) {
  const missing = [];
  const frontend = profile?.applications?.frontend;
  const browserAutomation = profile?.browserAutomation;
  const authentication = browserAutomation?.authentication;
  const dataSafety = browserAutomation?.dataSafety;
  const testSynthesis = browserAutomation?.testSynthesis;
  const agentIdleTimeoutMinutes =
    profile?.validation?.agentIdleTimeoutMinutes;
  const preflightRecovery = profile?.validation?.preflightRecovery;
  const requiredString = (value) =>
    typeof value === "string" && Boolean(value.trim());

  if (
    agentIdleTimeoutMinutes !== undefined &&
    (!Number.isInteger(agentIdleTimeoutMinutes) ||
      agentIdleTimeoutMinutes < 1 ||
      agentIdleTimeoutMinutes > 120)
  ) {
    missing.push(
      "validation.agentIdleTimeoutMinutes (integer from 1 to 120)"
    );
  }
  if (preflightRecovery !== undefined) {
    if (preflightRecovery?.enabled !== true) {
      missing.push("validation.preflightRecovery.enabled=true");
    }
    if (
      !Number.isInteger(preflightRecovery?.maxAttempts) ||
      preflightRecovery.maxAttempts < 1 ||
      preflightRecovery.maxAttempts > 3
    ) {
      missing.push(
        "validation.preflightRecovery.maxAttempts (integer from 1 to 3)"
      );
    }
    if (preflightRecovery?.processCleanup !== "owned-only") {
      missing.push(
        "validation.preflightRecovery.processCleanup=owned-only"
      );
    }
  }

  if (!frontend || typeof frontend !== "object") {
    missing.push("applications.frontend");
  } else {
    if (!requiredString(frontend.workingDirectory)) {
      missing.push("applications.frontend.workingDirectory");
    }
    if (!requiredString(frontend.command)) {
      missing.push("applications.frontend.command");
    }
    if (
      !Number.isInteger(frontend.port) ||
      frontend.port < 1 ||
      frontend.port > 65535
    ) {
      missing.push("applications.frontend.port");
    }
    if (!requiredString(frontend.healthUrl)) {
      missing.push("applications.frontend.healthUrl");
    } else {
      try {
        validatedManualLocalhostUrl(frontend.healthUrl);
      } catch {
        missing.push(
          "applications.frontend.healthUrl (credential-free loopback URL required)"
        );
      }
    }
  }

  if (!browserAutomation || typeof browserAutomation !== "object") {
    missing.push("browserAutomation");
  } else {
    for (const field of ["workingDirectory", "package", "browser", "testCommand"]) {
      if (!requiredString(browserAutomation[field])) {
        missing.push(`browserAutomation.${field}`);
      }
    }

    if (typeof authentication?.required !== "boolean") {
      missing.push("browserAutomation.authentication.required");
    } else if (authentication.required) {
      if (!requiredString(authentication.command)) {
        missing.push("browserAutomation.authentication.command");
      }
      if (
        !Array.isArray(authentication.statusPaths) ||
        authentication.statusPaths.length === 0 ||
        authentication.statusPaths.some((value) => !requiredString(value))
      ) {
        missing.push("browserAutomation.authentication.statusPaths");
      } else if (repository) {
        const authenticationRoot = resolve(
          repository,
          browserAutomation.workingDirectory
        );
        const missingStatusPaths = authentication.statusPaths.filter(
          (statusPath) => !existsSync(resolve(authenticationRoot, statusPath))
        );
        if (missingStatusPaths.length > 0) {
          missing.push(
            `browserAutomation authentication is not ready (${missingStatusPaths.join(", ")})`
          );
        }
      }
    }

    if (!requiredString(dataSafety?.policy)) {
      missing.push("browserAutomation.dataSafety.policy");
    }
    if (dataSafety?.productionAllowed !== false) {
      missing.push("browserAutomation.dataSafety.productionAllowed=false");
    }
    if (testSynthesis === undefined) {
      missing.push("browserAutomation.testSynthesis");
    } else {
      if (testSynthesis?.enabled !== true) {
        missing.push("browserAutomation.testSynthesis.enabled=true");
      }
      if (!testDataSources.has(testSynthesis?.defaultDataSource)) {
        missing.push(
          "browserAutomation.testSynthesis.defaultDataSource"
        );
      }
      if (!mutationModes.has(testSynthesis?.mutationMode)) {
        missing.push("browserAutomation.testSynthesis.mutationMode");
      }
      if (testSynthesis?.requireScenarioEvidence !== true) {
        missing.push(
          "browserAutomation.testSynthesis.requireScenarioEvidence=true"
        );
      }
    }
  }
  if (
    profile?.environments &&
    !Array.isArray(profile.environments) &&
    typeof profile.environments === "object"
  ) {
    for (const [environment, configuration] of Object.entries(
      profile.environments
    )) {
      if (!configuration || typeof configuration !== "object") {
        missing.push(`environments.${environment}`);
        continue;
      }
      if (!requiredString(configuration.frontendCommand)) {
        missing.push(`environments.${environment}.frontendCommand`);
      }
      if (!requiredString(configuration.healthUrl)) {
        missing.push(`environments.${environment}.healthUrl`);
      } else {
        try {
          validatedManualLocalhostUrl(configuration.healthUrl);
        } catch {
          missing.push(
            `environments.${environment}.healthUrl (credential-free loopback URL required)`
          );
        }
      }
      if (typeof configuration.authenticationRequired !== "boolean") {
        missing.push(
          `environments.${environment}.authenticationRequired`
        );
      }
      if (configuration.authenticationRequired === true) {
        if (!requiredString(authentication?.command)) {
          missing.push("browserAutomation.authentication.command");
        }
        if (
          !Array.isArray(authentication?.statusPaths) ||
          authentication.statusPaths.length === 0 ||
          authentication.statusPaths.some((value) => !requiredString(value))
        ) {
          missing.push("browserAutomation.authentication.statusPaths");
        }
      }
    }
  }

  return {
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? "startup, health, Playwright, authentication, and data-safety settings configured"
        : `missing or invalid: ${missing.join(", ")}`
  };
}

function configuredTestSynthesis(profile) {
  const configuration = profile?.browserAutomation?.testSynthesis;
  return {
    enabled: configuration?.enabled !== false,
    source: testDataSources.has(configuration?.defaultDataSource)
      ? configuration.defaultDataSource
      : "profile-defined",
    mutationMode: mutationModes.has(configuration?.mutationMode)
      ? configuration.mutationMode
      : "profile-defined",
    requireScenarioEvidence:
      configuration?.requireScenarioEvidence !== false,
    reported: false,
    scenario: ""
  };
}

function configuredAuthenticatedTest(profile) {
  const configuration = profile?.browserAutomation?.authenticatedTest;
  if (!configuration || typeof configuration !== "object") {
    return null;
  }
  const convention = {};
  for (const field of [
    "filePattern",
    "project",
    "fixtureImport",
    "readinessHelper"
  ]) {
    convention[field] =
      typeof configuration[field] === "string"
        ? configuration[field].trim()
        : "";
  }
  return Object.values(convention).some(Boolean) ? convention : null;
}

function configuredPreflightRecovery(profile) {
  const configuration = profile?.validation?.preflightRecovery;
  return {
    enabled: configuration?.enabled !== false,
    maxAttempts:
      Number.isInteger(configuration?.maxAttempts) &&
      configuration.maxAttempts >= 1 &&
      configuration.maxAttempts <= 3
        ? configuration.maxAttempts
        : 2,
    verifyRuntimeVersion: configuration?.verifyRuntimeVersion !== false,
    requireExactHealthUrl: configuration?.requireExactHealthUrl !== false,
    processCleanup: "owned-only"
  };
}

export function configuredValidationEnvironments(profile) {
  const configured = Array.isArray(profile?.environments)
    ? profile.environments
    : Object.keys(profile?.environments ?? {});
  const environments = [];
  const seen = new Set();
  for (const value of configured) {
    if (typeof value !== "string") {
      continue;
    }
    const environment = value.trim();
    const normalized = environment.toLowerCase();
    if (
      !environment ||
      environment.length > 64 ||
      ["prod", "prd", "production"].includes(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    environments.push(environment);
  }
  return environments;
}

export function configuredEnvironmentSettings(profile, environment) {
  if (
    !environment ||
    !profile?.environments ||
    Array.isArray(profile.environments) ||
    typeof profile.environments !== "object"
  ) {
    return null;
  }
  const entry = Object.entries(profile.environments).find(
    ([name]) => name.toLowerCase() === environment.toLowerCase()
  );
  if (!entry || !entry[1] || typeof entry[1] !== "object") {
    return null;
  }
  return {
    frontendCommand:
      typeof entry[1].frontendCommand === "string"
        ? entry[1].frontendCommand.trim()
        : "",
    healthUrl:
      typeof entry[1].healthUrl === "string"
        ? entry[1].healthUrl.trim()
        : "",
    authenticationRequired:
      entry[1].authenticationRequired === true
  };
}

function environmentAuthenticationReadiness(
  profile,
  repository,
  environment
) {
  const settings = configuredEnvironmentSettings(profile, environment);
  if (!settings?.authenticationRequired) {
    return { ok: true, detail: "not required" };
  }
  const authentication = profile?.browserAutomation?.authentication ?? {};
  if (
    typeof authentication.command !== "string" ||
    !authentication.command.trim() ||
    !Array.isArray(authentication.statusPaths) ||
    authentication.statusPaths.length === 0
  ) {
    return {
      ok: false,
      detail: `environment ${environment} requires browser authentication configuration`
    };
  }
  const authenticationRoot = resolve(
    repository,
    profile.browserAutomation?.workingDirectory ?? "."
  );
  const missing = authentication.statusPaths.filter(
    (statusPath) => !existsSync(resolve(authenticationRoot, statusPath))
  );
  return missing.length === 0
    ? { ok: true, detail: "ready" }
    : {
        ok: false,
        detail:
          `environment ${environment} browser authentication is not ready ` +
          `(${missing.join(", ")}); run fixlab authenticate`
      };
}

export function validateTargetEnvironment(value, environments) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error("targetEnvironment must be a string");
  }
  const requested = value.trim();
  if (["prod", "prd", "production"].includes(requested.toLowerCase())) {
    throw new Error("targetEnvironment must be a non-production environment");
  }
  const selected = environments.find(
    (environment) =>
      environment.toLowerCase() === requested.toLowerCase()
  );
  if (!selected) {
    throw new Error(
      "targetEnvironment must be one of the repository profile environments"
    );
  }
  return selected;
}

function publicQueue(jobs) {
  return jobs.map((job, index) => ({
    id: job.id,
    position: index + 1,
    request: safeSummary(job.request),
    requestType: job.requestType,
    pullRequestStrategy: job.pullRequestStrategy,
    runAllUiScenarios: job.runAllUiScenarios,
    targetEnvironment: job.targetEnvironment,
    recordPlaywrightVideo: job.recordPlaywrightVideo,
    manualLocalhostTest: job.manualLocalhostTest,
    manualLocalhostUrl: job.manualLocalhostUrl,
    manualLocalhostOpenedAt: job.manualLocalhostOpenedAt,
    manualLocalhostPending: job.manualLocalhostPending,
    manualLocalhostResult: job.manualLocalhostResult,
    testEvidence: job.testEvidence,
    intakeSource: job.intakeSource,
    mode: job.mode,
    status: job.status,
    bugCount: job.bugs.length,
    bugs: job.bugs,
    screenshotCount: job.screenshots.length,
    stages: job.stages,
    pullRequestReadiness: getPullRequestReadiness(job),
    createdAt: job.createdAt
  }));
}

function publicHistory(jobs) {
  return jobs.map((job) => ({
    ...publicJob(job),
    activity: [],
    logs: []
  }));
}

function safePersistedSummary(value) {
  return safeSummary(value).replace(/https?:\/\/\S+/giu, "[omitted URL]");
}

function dashboardSnapshot(job) {
  return {
    id: job.id,
    request: safePersistedSummary(job.request),
    requestType: job.requestType,
    pullRequestStrategy: job.pullRequestStrategy,
    runAllUiScenarios: job.runAllUiScenarios,
    targetEnvironment: job.targetEnvironment,
    recordPlaywrightVideo: job.recordPlaywrightVideo,
    manualLocalhostTest: job.manualLocalhostTest,
    manualLocalhostUrl: "",
    manualLocalhostOpenedAt: job.manualLocalhostOpenedAt,
    manualLocalhostPending: job.manualLocalhostPending,
    manualLocalhostResult: job.manualLocalhostResult,
    testEvidence: {
      enabled: job.testEvidence.enabled,
      source: job.testEvidence.source,
      mutationMode: job.testEvidence.mutationMode,
      requireScenarioEvidence: job.testEvidence.requireScenarioEvidence,
      reported: job.testEvidence.reported,
      scenario: safePersistedSummary(job.testEvidence.scenario)
    },
    browserRun: job.browserRun ? {
      ...job.browserRun,
      command: safePersistedSummary(job.browserRun.command),
      message: safePersistedSummary(job.browserRun.message),
      currentStep: "",
      commandSummary: ""
    } : null,
    branchNaming: job.branchNaming ?? null,
    intakeSource: job.intakeSource,
    workItem: persistedWorkItem(job.workItem),
    workItems: job.workItems.map(persistedWorkItem),
    mode: job.mode,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastActivityAt: job.lastActivityAt,
    error: job.error ? safePersistedSummary(job.error) : null,
    stages: Object.fromEntries(
      FIXLAB_STAGES.map((stage) => [
        stage,
        {
          status: job.stages[stage].status,
          message: safePersistedSummary(job.stages[stage].message)
        }
      ])
    ),
    bugs: job.bugs.map((bug) => ({
      id: bug.id,
      outcome: bug.outcome,
      owner: safePersistedSummary(bug.owner),
      summary: safePersistedSummary(bug.summary)
    })),
    canResume: false,
    canComment: false
  };
}

function restoreDashboardJob(snapshot, repository) {
  const profile = loadRepositoryProfile(repository);
  let manualLocalhostUrl = "";
  let manualLocalhostProfileError = false;
  try {
    manualLocalhostUrl = validatedManualLocalhostUrl(
      profile.applications?.frontend?.healthUrl
    );
  } catch {
    manualLocalhostProfileError =
      snapshot.manualLocalhostTest ??
      snapshot.holdForManualLiveTest ??
      false;
  }
  const restored = {
    ...snapshot,
    manualLocalhostTest:
      snapshot.manualLocalhostTest ??
      snapshot.holdForManualLiveTest ??
      false,
    manualLocalhostUrl,
    manualLocalhostOpenedAt: snapshot.manualLocalhostOpenedAt ?? null,
    manualLocalhostPending:
      snapshot.manualLocalhostPending ??
      (Boolean(
        snapshot.manualLocalhostTest ??
        snapshot.holdForManualLiveTest
      ) &&
        snapshot.stages?.["live-test"]?.status === "blocked" &&
        !snapshot.manualLocalhostResult),
    manualLocalhostResult: snapshot.manualLocalhostResult ?? null,
    workItem: snapshot.workItem ?? null,
    workItems: snapshot.workItems ?? [],
    screenshots: [],
    artifactDirectory: null,
    inputs: [],
    pendingInputs: [],
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      cacheReusePercent: 0
    },
    activity: [],
    logs: [],
    droppedLogs: 0,
    nextLogIndex: 0,
    cacheContext: createCacheContext(repository),
    partial: { stdout: "", stderr: "" }
  };
  if (manualLocalhostProfileError) {
    restored.resumeDisabled = true;
    restored.manualLocalhostPending = false;
    if (!restored.manualLocalhostResult) {
      const message =
        "Manual localhost validation cannot resume because the profile frontend health URL is no longer a safe credential-free loopback URL.";
      restored.status = "failed";
      restored.error = message;
      restored.stages["live-test"] = { status: "failed", message };
    }
  }
  restored.initialPrompt = buildJobPrompt({
    request: restored.request,
    mode: restored.mode,
    requestType: restored.requestType,
    pullRequestStrategy: restored.pullRequestStrategy,
    runAllUiScenarios: restored.runAllUiScenarios,
    targetEnvironment: restored.targetEnvironment,
    environmentSettings: configuredEnvironmentSettings(
      profile,
      restored.targetEnvironment
    ),
    recordPlaywrightVideo: restored.recordPlaywrightVideo,
    manualLocalhostTest: restored.manualLocalhostTest,
    manualLocalhostUrl: restored.manualLocalhostUrl,
    testEvidence: restored.testEvidence,
    authenticatedTest: configuredAuthenticatedTest(profile),
    preflightRecovery: configuredPreflightRecovery(profile),
    branchNaming: restored.branchNaming,
    intakeSource: restored.intakeSource,
    workItem: restored.workItem,
    workItems: restored.workItems,
    screenshotPaths: [],
    cacheSummary: loadCacheSummary(restored.cacheContext)
  });
  return restored;
}

export function recoverInterruptedDashboardJob(
  snapshot,
  recoveredAt = new Date().toISOString()
) {
  if (snapshot?.browserRun?.status === "running") {
    snapshot = {
      ...snapshot,
      browserRun: {
        ...snapshot.browserRun,
        status: "blocked",
        finishedAt: recoveredAt,
        currentStep: "",
        message: "Dashboard restarted; the previous browser process is not owned by this instance."
      }
    };
  }
  if (snapshot?.status !== "running") {
    return snapshot;
  }

  const stages = Object.fromEntries(
    FIXLAB_STAGES.map((stage) => [
      stage,
      snapshot.stages?.[stage] ?? { status: "pending", message: "" }
    ])
  );
  const failedStages = FIXLAB_STAGES.filter(
    (stage) => stages[stage].status === "failed"
  );
  const blockedStages = FIXLAB_STAGES.filter(
    (stage) => stages[stage].status === "blocked"
  );
  const incompleteStages = FIXLAB_STAGES.filter(
    (stage) => !terminalStatuses.has(stages[stage].status)
  );
  const unresolvedBugs = (snapshot.bugs ?? []).filter(
    (bug) => bug.outcome === "pending"
  );
  if (
    failedStages.length === 0 &&
    blockedStages.length > 0 &&
    incompleteStages.length === 0 &&
    unresolvedBugs.length === 0
  ) {
    return {
      ...snapshot,
      status: "blocked",
      stages,
      error: snapshot.error ?? null,
      finishedAt: recoveredAt
    };
  }

  const interruptedStage =
    FIXLAB_STAGES.find((stage) => stages[stage].status === "running") ??
    FIXLAB_STAGES.find((stage) => !terminalStatuses.has(stages[stage].status));
  const message =
    "Dashboard restarted without an owned executor process; resume this interrupted job.";
  if (interruptedStage) {
    stages[interruptedStage] = { status: "failed", message };
  }

  return {
    ...snapshot,
    status: "failed",
    stages,
    error: snapshot.error ? `${snapshot.error}; ${message}` : message,
    finishedAt: recoveredAt
  };
}

function getPullRequestReadiness(job) {
  const prStage = job.stages?.pr ?? { status: "pending", message: "" };
  if (prStage.status === "passed") {
    return {
      status: "created",
      ready: false,
      message: prStage.message || "Pull request created or updated."
    };
  }
  const fixedBugs = (job.bugs ?? []).filter((bug) => bug.outcome === "fixed");
  if (job.browserRun && job.browserRun.status !== "passed") {
    return {
      status: "blocked",
      ready: false,
      message: `Background Playwright is ${job.browserRun.status}; its outcome does not satisfy the browser gate.`
    };
  }
  const hasCodeChange =
    fixedBugs.length > 0 ||
    ((job.bugs ?? []).length === 0 && job.stages?.fix?.status === "passed");
  if (!hasCodeChange && job.status !== "running") {
    return {
      status: "not-applicable",
      ready: false,
      message: "No confirmed FixLab code change requires a pull request."
    };
  }
  const blockers = FIXLAB_STAGES.slice(0, -1).filter((stage) =>
    ["pending", "running", "blocked", "failed"].includes(
      job.stages?.[stage]?.status ?? "pending"
    )
  );
  if (blockers.length > 0) {
    return {
      status: "blocked",
      ready: false,
      message: `Waiting for: ${blockers.join(", ")}.`
    };
  }
  if (prStage.status === "blocked") {
    return {
      status: "approval-required",
      ready: true,
      message: prStage.message || "Pull-request approval is required."
    };
  }
  return {
    status: "ready",
    ready: true,
    message: "Required validation gates are complete; the pull request can be created."
  };
}

export function inspectRepository(repository) {
  const resolvedRepository = resolve(repository);
  pruneArtifactDirectories(resolvedRepository);
  if (
    !existsSync(resolvedRepository) ||
    !statSync(resolvedRepository).isDirectory()
  ) {
    return {
      repository: resolvedRepository,
      repositoryReady: false,
      profileReady: false,
      profilePath: join(resolvedRepository, profileRelativePath),
      profileName: null,
      error: "repository does not exist or is not a directory"
    };
  }

  const profilePath = join(resolvedRepository, profileRelativePath);
  if (!existsSync(profilePath)) {
    return {
      repository: resolvedRepository,
      repositoryReady: true,
      profileReady: false,
      profilePath,
      profileName: null,
      error: "repository profile is missing; run fixlab init"
    };
  }

  try {
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("profile root must be a JSON object");
    }
    const liveTestProfile = validateLiveTestProfile(profile, resolvedRepository);
    if (!liveTestProfile.ok) {
      return {
        repository: resolvedRepository,
        repositoryReady: true,
        profileReady: false,
        profilePath,
        profileName:
          typeof profile.name === "string" && profile.name.trim()
            ? profile.name.trim()
            : null,
        error: `live-test profile is incomplete: ${liveTestProfile.detail}`
      };
    }
    return {
      repository: resolvedRepository,
      repositoryReady: true,
      profileReady: true,
      profilePath,
      environments: configuredValidationEnvironments(profile),
      profileName:
        typeof profile.name === "string" && profile.name.trim()
          ? profile.name.trim()
          : null,
      error: null
    };
  } catch (error) {
    return {
      repository: resolvedRepository,
      repositoryReady: true,
      profileReady: false,
      profilePath,
      profileName: null,
      error: `repository profile is invalid JSON: ${error.message}`
    };
  }
}

export function buildJobPrompt({
  request,
  mode,
  requestType = "bug-fix",
  pullRequestStrategy = "common",
  runAllUiScenarios = false,
  targetEnvironment = "",
  environmentSettings = null,
  recordPlaywrightVideo = false,
  manualLocalhostTest = false,
  manualLocalhostUrl = "",
  testEvidence = {
    enabled: true,
    source: "profile-defined",
    mutationMode: "profile-defined",
    requireScenarioEvidence: true
  },
  authenticatedTest = null,
  preflightRecovery = {
    enabled: true,
    maxAttempts: 2,
    verifyRuntimeVersion: true,
    requireExactHealthUrl: true,
    processCleanup: "owned-only"
  },
  branchNaming = null,
  cacheSummary = null,
  intakeSource = "manual",
  workItem = null,
  workItems = [],
  screenshotPaths = []
}) {
  const validateOnly = mode === "validate-only";
  const playwrightOnly = mode === "playwright-only";
  const readOnly = validateOnly || playwrightOnly;
  const smallEnhancement = requestType === "small-enhancement";
  const intakeWorkItems =
    workItems.length > 0 ? workItems : workItem ? [workItem] : [];
  const intakeSummary = intakeWorkItems.map(
    ({
      id,
      title,
      state,
      workItemType,
      webUrl,
      comments,
      commentCount,
      commentsWarning
    }) => ({
      id,
      title,
      state,
      workItemType,
      webUrl,
      commentCount: Array.isArray(comments)
        ? comments.length
        : Number.isSafeInteger(commentCount)
          ? commentCount
          : 0,
      commentsWarning
    })
  );
  const bugResults = extractBugResults(request, intakeWorkItems);
  const pullRequestGuidance = readOnly
    ? "- Pull-request strategy is informational in read-only mode; do not create or update pull requests."
    : pullRequestStrategy === "per-bug"
      ? `- Process each selected bug as an isolated delivery unit. Keep its code changes, focused validation, browser evidence, commit, and pull-request outcome separate from every other bug.
- After one bug's scoped fix and smallest focused regression pass, remove transient validation artifacts, self-review its diff, and create or update its authorized draft PR before running remaining independent validation. Keep that PR draft until every required gate for that bug is terminal. Never combine unrelated bug changes in one PR.`
      : `- Treat all selected bugs as one common-PR batch. Diagnose and implement every required fix, then run the smallest focused regression checks that protect the combined change.
- After those focused checks pass, remove transient validation artifacts, self-review the combined diff, and create or update one authorized draft PR. Continue shared tests, builds, application startup, and browser scenarios while that draft is open.`;
  const uiScenarioGuidance = runAllUiScenarios
    ? `- After implementation and non-browser validation are complete, run every repository-defined Playwright/UI scenario at the end, not only the focused defect journey.
- Start the required applications once when safe, preserve each scenario result, and attach non-sensitive screenshot evidence for the complete UI run.`
    : "- Run the smallest repository-defined Playwright journey that proves the selected behavior.";
  const environmentGuidance = targetEnvironment
    ? `- The user selected ${targetEnvironment} as the validation environment. Use exactly that repository-approved environment for profile-defined application startup and Playwright live testing.
- The profile-defined frontend startup command for ${targetEnvironment} is ${environmentSettings?.frontendCommand ? `\`${environmentSettings.frontendCommand}\`` : "not configured"}. Run that exact command from applications.frontend.workingDirectory; never guess an environment script or run it from the repository root.
    - The profile-defined health URL for ${targetEnvironment} is ${environmentSettings?.healthUrl ? `\`${environmentSettings.healthUrl}\`` : "not configured"}. Wait for that exact loopback URL; do not substitute localhost and 127.0.0.1 because repositories may bind them differently.
    - Browser authentication for ${targetEnvironment} is ${environmentSettings?.authenticationRequired ? "required" : "not required by the profile"}.
- Do not silently fall back to local or another environment. If ${targetEnvironment} is unavailable, unauthenticated, or cannot be used safely, block the affected stage with the exact prerequisite.
- Focused tests, type-checks, and builds still run locally unless the repository profile explicitly defines otherwise.`
    : "- No environment override was selected. Use the repository profile's safe default and never select production.";
  const testDataGuidance =
    targetEnvironment &&
    testEvidence.source === "non-production-read-only"
      ? `- Use the selected ${targetEnvironment} backend and API as the primary business-data source. Keep all backend access read-only and intercept every mutating request.
- Do not fulfill or intercept business-data reads while the selected backend is available and returns safe records that can prove the required assertions.
- If the selected backend is unreachable, authentication or access prevents the read, or it returns no safe records capable of exercising the required behavior, preserve that exact backend limitation and then fall back to synthetic-intercepted data for the focused UI journey.
- Do not replace an expected empty-state assertion with synthetic data. Use fallback only when records are required to exercise the reported behavior and the selected backend cannot supply them.
- When fallback occurs, emit a FIXLAB_ACTIVITY line explaining why, intercept all mutations, and emit FIXLAB_TEST with source synthetic-intercepted and mutation mode intercepted. A synthetic pass proves the UI behavior only; do not claim the selected backend or its data was validated.`
      : "- Use the configured test data source and mutation mode. For synthetic-intercepted tests, fulfill business-data reads locally, intercept every mutating request, and assert the intended request count and payload without changing an external record.";
  const videoGuidance = recordPlaywrightVideo
    ? `- Record the focused Playwright journey as non-sensitive video evidence using repository-supported Playwright video recording.
- Save the recording as WebM or MP4 under the repository-owned test-results, playwright-report, or artifacts directory. Keep it under 50 MiB and capture only the application surface: no credentials, browser profiles, personal windows, or unrelated data.
- Keep the required screenshot evidence as the lightweight review artifact. If recording is unavailable, report that limitation explicitly instead of claiming video evidence exists.`
    : "- Playwright video recording was not requested. Preserve the required screenshot evidence and any repository-default traces.";
  const authenticatedTestGuidance = authenticatedTest
    ? `- For authenticated Playwright synthesis, follow the repository contract exactly: file pattern ${authenticatedTest.filePattern || "profile-defined"}, project ${authenticatedTest.project || "profile-defined"}, fixture import ${authenticatedTest.fixtureImport || "profile-defined"}, and readiness helper ${authenticatedTest.readinessHelper || "profile-defined"}. Do not substitute plain @playwright/test or storageState when the repository defines an authenticated fixture.`
    : "- For authenticated Playwright synthesis, inspect the repository profile and existing Playwright fixtures/configuration before generating a test. Do not assume storageState is sufficient.";
  const preflightRecoveryGuidance = preflightRecovery.enabled
    ? `- Preflight recovery is bounded to ${preflightRecovery.maxAttempts} attempt(s). Verify the active runtime/version before retrying, use the exact configured health URL, and stop or clean up only processes started and owned by this FixLab job. Never terminate an arbitrary port owner. If recovery needs credentials, runtime installation, or another unsafe/user-owned action, block with that exact action.`
    : "- Do not attempt automatic preflight recovery; block with the exact prerequisite.";
  const manualLocalhostGuidance = manualLocalhostTest
    ? `- Manual React localhost validation is enabled independently of Playwright. After required automated validation finishes, start or reuse only the profile-defined frontend and wait for its health check at ${manualLocalhostUrl || "the profile-defined local health URL"}.
- Emit local-stack passed only after the React frontend is healthy. The dashboard will then open the localhost URL in the user's default browser.
- After every required automated browser gate is terminal, emit FIXLAB_MANUAL|localhost|pending immediately before live-test blocked. Keep the FixLab-owned frontend running and request that the user confirm Passed or Failed. Do not emit this marker for a Playwright, authentication, test-data, or other automated blocker.
- Do not run or rerun Playwright solely because this manual option is enabled.
- If an authorized draft PR already exists, keep it draft with the manual gate pending; otherwise emit pr skipped because manual confirmation is pending.
- When the dashboard resumes this session with the user's manual result, mark live-test passed or failed accordingly, stop only the retained FixLab-owned frontend process, and continue to the gated PR outcome.`
    : "- Stop FixLab-owned applications after automated browser validation unless another explicit workflow requirement needs them.";
  const branchNamingGuidance = branchNaming
    ? `- Repository branch naming is configured as ${branchNaming.prefix}. Create or reuse only branches beneath this prefix. Do not substitute a runtime, bot, or agent name for the configured user ID.`
    : "- Follow the repository's existing branch naming policy; do not invent a bot-specific prefix.";
  const requestGuidance = playwrightOnly
    ? `- Use the request only to select the relevant repository-defined Playwright journey and expected behavior.
- Perform only the minimum setup required by the repository profile: verify browser authentication, start required applications, and run the focused Playwright journey.
- Do not diagnose source code, reproduce through separate non-browser checks, review a diff, run unrelated tests, type-checks, or builds, or inspect implementation files unless the Playwright journey cannot be selected or started without that bounded information.
- Preserve exact browser results, screenshots, traces, skipped gates, blockers, and remaining risks.`
    : smallEnhancement
    ? `- Generate a concise acceptance contract before changing code.
- Check the affected surface and bound the file scope before editing.
- Do not manufacture a failing defect reproduction. Use the smallest existing focused test that proves the acceptance contract.
- Skip broad test suites and full builds unless the repository profile requires them or user-visible/risk evidence makes them necessary.
- Preserve review, live-test, and pull-request evidence, and make no unrelated changes.`
    : `- Generate a concise fix contract from the reported behavior and expected outcome.
- Diagnose and reproduce with repository evidence. Do not claim a cause or reproduction without evidence.
- Use the smallest focused reproduction that demonstrates the reported defect.`;
  return `Run a FixLab ${mode} job.
Request type: ${requestType}
Pull request strategy: ${pullRequestStrategy}
Run all UI scenarios at end: ${runAllUiScenarios ? "yes" : "no"}
Selected validation environment: ${targetEnvironment || "profile-defined"}
Record Playwright video evidence: ${recordPlaywrightVideo ? "yes" : "no"}
Open React localhost for manual validation: ${manualLocalhostTest ? "yes" : "no"}
Test synthesis: ${testEvidence.enabled ? "enabled" : "disabled"}
Configured test data source: ${testEvidence.source}
Configured mutation mode: ${testEvidence.mutationMode}
Intake source: ${intakeSource}
${intakeSummary.length > 0 ? `Loaded Azure DevOps selection:
${JSON.stringify(intakeSummary, null, 2)}
The bounded bug evidence is included in the request below.
` : ""}
${screenshotPaths.length > 0 ? `User-provided screenshots stored locally for this job:
${screenshotPaths.map((path) => `- ${path}`).join("\n")}
Inspect only these local files. Do not search for or download additional Azure DevOps attachments.
` : ""}
${cacheSummary ? `
Verified same-repository cache summary for the current HEAD and profile:
${JSON.stringify(cacheSummary, null, 2)}
Use this concise metadata only to avoid repeated discovery. Verify task-specific facts against the current diff and relevant files; do not treat it as source evidence.
` : ""}

Repository requirements:
- Read .github/fixlab/repository-profile.json and all repository-owned instructions before acting.
- Before diagnosis or source inspection, preflight the actual execution workspace: verify profile-defined frontend and backend restore commands have completed, the configured Playwright package and browser can launch, the selected environment has an explicit startup command, and every required browser-authentication status path exists.
${preflightRecoveryGuidance}
- Run missing profile-defined restores immediately in their configured working directories. If a private package feed returns 401/403 or authentication is interactive, block intake with the exact authentication action instead of deferring setup until live-test.
- Do not start implementation while execution prerequisites are unresolved. Emit intake blocked and mark later stages skipped when restore, browser, environment startup, or required authentication cannot be made ready safely.
- For repeat work, inspect the current git status and effective diff first, then search task-relevant symbols and files instead of rescanning the whole repository.
- Do not perform a whole-repository rescan when the current diff, cached metadata, and focused symbol/path searches are sufficient.
- Reuse this job/session context. Do not reread unchanged files, repeat completed diagnosis, reinstall available dependencies, or rerun broad checks without new evidence.
- Treat commit changes and repository-profile or instruction changes as invalidation boundaries: reread affected context when they change.
${requestGuidance}
${pullRequestGuidance}
${uiScenarioGuidance}
${environmentGuidance}
${videoGuidance}
${manualLocalhostGuidance}
${branchNamingGuidance}
- ${readOnly ? "Do not edit files, create commits, push branches, create pull requests, or update pull requests." : "Make the smallest complete change that resolves the request. Make no code change when the evidence shows none is required."}
- Autonomously complete the lifecycle without asking the user to direct routine engineering steps.
- ${playwrightOnly ? "Skip source diagnosis, separate reproduction, implementation, diff review, and non-browser validation. Mark diagnosis, reproduce, fix, and review skipped with the reason Playwright-only mode was selected." : "Inspect the affected surface, implement the smallest required code when edits are allowed, and self-review the effective diff for correctness, scope, and unrelated changes."}
- ${playwrightOnly ? "Run only setup commands strictly required to launch the profile-defined applications and focused Playwright journey. Do not reinstall dependencies that are already available." : "Run the focused repository-owned tests, type-checks, and builds needed for the affected surface and risk. Preserve exact results."}
- Treat \`fixlab exec\` as the default boundary for verbose repository-owned tests, builds, linters, type checks, and package validation; do not invoke those commands directly. Run them as \`fixlab exec --stage <stage> -- <command> [args...]\`, keep its compact result in context, and expand exact redacted output only through the printed \`fixlab evidence show <evidence-id> --stream <stdout|stderr> --lines <count>\` command.
- Add \`--reuse\` only for deterministic local validation when command, arguments, Git state, working directory, profile, and stage are unchanged. Never reuse startup, health, authentication, Playwright or live-environment validation, external-data checks, dependency installation, deployments, or mutating commands.
- Do not skip Playwright merely because an unrelated non-browser test, build, or backend startup is failed or blocked. If frontend startup, authentication, safe data, and the selected browser journey are independently ready, run the live-test gate and preserve the other blocker separately.
- Use local-stack only for profile-defined application startup and health. Do not mark local-stack failed because a separate test, type-check, lint, or production build reports unrelated baseline diagnostics; preserve that exact validation limitation separately and continue browser execution when startup is healthy.
- Before browser execution, synthesize the smallest focused Playwright scenario and measurable assertions from the reported behavior and expected outcome when an equivalent repository-owned scenario does not already exist.
${authenticatedTestGuidance}
- Treat a synthesized Playwright scenario as a transient validation artifact by default. Remove its source file and any validation-only configuration edits before diff review, commit, push, or pull-request creation.
- Do not add a newly generated authenticated test such as \`*.auth.spec.ts\` to the product change unless the user explicitly requests permanent browser-test coverage or repository instructions require that exact persisted test.
- Existing repository-owned Playwright tests may be changed only when the reported product behavior directly requires that regression update; do not broaden the pull request to repair unrelated or stale browser journeys.
${testDataGuidance}
- Once the scoped production change and its smallest focused regression checks pass, remove transient validation artifacts and self-review the effective diff. When pull-request publication is already authorized, commit and push that reviewed checkpoint and create or update a draft pull request before remaining independent validation completes.
- Start long-running independent validation commands in parallel when the runtime supports it. While those commands run, prepare or refresh the authorized draft PR description with the confirmed symptom, scoped change, checks already passed, checks still running, and known risks.
- Push later reviewed checkpoints to the same branch only after their affected focused checks pass. Reuse the same draft PR and update its evidence instead of waiting to publish one large final update or creating duplicates.
- Keep the pull request draft and clearly marked validation-in-progress while any required gate is pending, running, blocked, skipped with unaccepted risk, or failed. Never mark it ready for review or report the pr stage passed until all required gates pass or repository policy records an explicitly accepted outcome.
- Emit one browser evidence line after the scenario is selected and again if the actual source or mutation behavior changes:
  FIXLAB_TEST|source|mutation-mode|scenario
- source must be one of: ${[...testDataSources].join(", ")}.
- mutation-mode must be one of: ${[...mutationModes].join(", ")}.
- Start only the applications defined by the repository profile, then execute the repository-defined live test against the allowed required system or environment from that profile. Do not invent or hardcode environment choices.
- For every Playwright live test, save at least one non-sensitive screenshot under the test's repository-owned test-results directory so the dashboard can display the browser evidence.
- ${playwrightOnly ? "Collect evidence for required setup, authentication readiness, application startup, the focused Playwright result, skipped gates, blockers, and remaining risks." : "Collect evidence for diagnosis or surface inspection, the effective diff, review, local validation, application startup, live testing, skipped gates, and remaining risks."}
- ${readOnly ? "Report the pull-request outcome without creating or updating a pull request." : "Create or update an authorized draft pull request after the reviewed focused checkpoint; finalize its evidence and readiness only after all required gates pass."}
- Human interaction is limited to authentication, unsafe-data approval, deployment or pull-request approval, and genuine blockers that cannot be resolved from repository evidence.
- When one of those human actions is required, emit FIXLAB_STAGE|stage|blocked|exact action needed, emit blocked outcomes for affected bugs when applicable, mark later stages skipped because of the blocker, and exit. The dashboard will collect user input and resume this same session.
- Emit concise, user-visible analysis updates when evidence changes the diagnosis, validation status, blocker, or next action:
  FIXLAB_ACTIVITY|stage|summary
- FIXLAB_ACTIVITY is a decision and evidence summary, not hidden chain-of-thought. State what was checked, what the evidence means, and what happens next without exposing secrets, credentials, private data, or speculative reasoning.
- Emit no more than two FIXLAB_ACTIVITY lines per stage unless a new blocker materially changes the plan.
- Keep stage messages and retained logs concise. Summarize relevant command evidence and preserve exact errors, but do not feed unbounded raw output back into prompts.
- Keep all execution local unless the repository profile and existing authorization explicitly require an allowed external action.
- For every Azure DevOps bug listed below, emit one terminal outcome line before finishing:
  FIXLAB_BUG|id|outcome|owner|summary
- These bug lines are required machine-readable output, not optional narrative. Emit each line as soon as its diagnosis is final and before the terminal pr stage.
- outcome must be one of: ${[...bugOutcomeStatuses].join(", ")}.
- owner must identify the responsible boundary, such as application, upstream-system, data, deployment, or unknown.
- Use outcome external with owner upstream-system when the application correctly surfaces an error returned by an upstream system and no repository code correction is required.
- Do not create an empty pull request. When every bug is external, no-change, expected, duplicate, or already-fixed, explicitly skip the fix and pr stages and explain the per-bug outcomes.
- The expected bug IDs for this request are: ${bugResults.length > 0 ? bugResults.map((bug) => bug.id).join(", ") : "none detected; no FIXLAB_BUG marker is required"}.
- Emit exactly one or more progress lines in this format:
  FIXLAB_STAGE|stage|status|message
- Write every FIXLAB_STAGE, FIXLAB_ACTIVITY, FIXLAB_BUG, and FIXLAB_TEST marker as a literal plain-text assistant response line. Never generate markers through shell, Write-Output, echo, files, tools, code blocks, or tables because runtime rendering may hide them from the dashboard.
- stage must be one of: ${FIXLAB_STAGES.join(", ")}.
- status must be pending, running, passed, skipped, blocked, or failed.
- Before finishing, emit a terminal passed, skipped, blocked, or failed marker for every stage. Never imply an unmarked stage passed.
- Do not call task_complete or return the final response until every expected FIXLAB_BUG line and every terminal FIXLAB_STAGE line has been emitted.
- Preserve exact command errors in the stage message or adjacent output.
${validateOnly ? "- The fix and pr stages must be explicitly skipped unless they fail for another reason." : ""}
${playwrightOnly ? "- The diagnosis, reproduce, fix, review, and pr stages must be explicitly skipped unless a required setup or browser-validation blocker makes the applicable stage blocked or failed." : ""}

Request:
${request}`;
}

function extractBugResults(request, workItems = []) {
  const bugs = new Map();
  const lines = String(request ?? "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^Azure DevOps Bug (\d+):\s*(.+)$/i);
    if (!match) {
      continue;
    }
    const nextLine = lines[index + 1]?.trim() ?? "";
    const url = nextLine.match(/^URL:\s*(https:\/\/dev\.azure\.com\/\S+)$/i);
    bugs.set(match[1], {
      id: match[1],
      title: safeSummary(match[2]),
      url: url?.[1] ?? "",
      outcome: "pending",
      owner: "",
      summary: ""
    });
  }
  for (const workItem of workItems) {
    if (workItem?.id && !bugs.has(String(workItem.id))) {
      bugs.set(String(workItem.id), {
        id: String(workItem.id),
        title: safeSummary(workItem.title),
        url: workItem.webUrl ?? "",
        outcome: "pending",
        owner: "",
        summary: ""
      });
    }
  }
  return [...bugs.values()];
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function safeSummary(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (
    /(?:password|passwd|secret|token|authorization|bearer|cookie|connection.?string|private.?key|client.?secret|dashboard[-\\/]+artifacts)/i.test(
      text
    )
  ) {
    return "[omitted potentially sensitive summary]";
  }
  return text;
}

function parseTokenCount(value) {
  const match = String(value).trim().match(/^([\d.]+)\s*([kmb]?)$/i);
  if (!match) {
    return null;
  }
  const multiplier = {
    "": 1,
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000
  }[match[2].toLowerCase()];
  const count = Number(match[1]) * multiplier;
  return Number.isFinite(count) ? Math.round(count) : null;
}

function parseUsageLine(line) {
  const match = line.match(
    /Tokens\s+↑\s*([\d.]+\s*[kmb]?)\s+\(([\d.]+\s*[kmb]?)\s+cached,\s*([\d.]+\s*[kmb]?)\s+written\)\s+•\s+↓\s*([\d.]+\s*[kmb]?)/i
  );
  if (!match) {
    return null;
  }
  const values = match.slice(1).map(parseTokenCount);
  if (values.some((value) => value === null)) {
    return null;
  }
  const [inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens] =
    values;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    cacheReusePercent:
      inputTokens > 0
        ? Math.round((cachedInputTokens / inputTokens) * 1000) / 10
        : 0
  };
}

function readMetrics(path) {
  if (!path || !existsSync(path)) {
    return { records: [], warning: null };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value?.jobs)) {
      throw new Error("metrics history has an invalid shape");
    }
    return {
      records: value.jobs.slice(-MAX_METRICS_ENTRIES),
      warning: null
    };
  } catch {
    return {
      records: [],
      warning:
        "The existing dashboard metrics history could not be read and was ignored."
    };
  }
}

function updateJobMetrics(records, job) {
  const retryCount = job.inputs.filter(
    (input) => input.action === "retry"
  ).length;
  const resumeCount = job.inputs.filter((input) =>
    ["retry", "continue", "skip", "manual-pass", "manual-fail"].includes(
      input.action
    )
  ).length;
  const validationReuseCount = job.logs.filter((entry) =>
    /\bREUSED fixlab exec:/u.test(entry.message)
  ).length;
  const preflightRecoveryAttempts = job.logs.filter((entry) =>
    /Playwright preflight recovery attempt/u.test(entry.message)
  ).length;
  const evidenceReductions = job.logs
    .map((entry) =>
      entry.message.match(/(\d+(?:\.\d+)?)% reduction/u)
    )
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const record = {
    id: job.id,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    status: job.status,
    bugCount: job.bugs.length,
    durationMs: job.finishedAt
      ? Math.max(
          0,
          Date.parse(job.finishedAt) -
            Date.parse(job.startedAt ?? job.createdAt)
        )
      : null,
    queueWaitMs: job.startedAt
      ? Math.max(0, Date.parse(job.startedAt) - Date.parse(job.createdAt))
      : null,
    retryCount,
    resumeCount,
    humanInterventionCount: job.inputs.length,
    validationReuseCount,
    browserRunAttempts: job.browserRunAttempts ?? 0,
    preflightRecoveryAttempts,
    commandEvidenceReductionPercent:
      evidenceReductions.length > 0
        ? Math.max(...evidenceReductions)
        : null,
    ...job.usage
  };
  const next = [
    ...records.filter((candidate) => candidate.id !== job.id),
    record
  ].slice(-MAX_METRICS_ENTRIES);
  return next;
}

function writeMetrics(path, records) {
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({ version: 1, jobs: records }),
    { mode: 0o600 }
  );
  renameSync(temporaryPath, path);
}

function readDashboardHistory(path) {
  if (!path || !existsSync(path)) {
    return { jobs: [], warning: null };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value?.jobs)) {
      throw new Error("dashboard history has an invalid shape");
    }
    return {
      jobs: value.jobs
        .filter(
          (job) =>
            job &&
            typeof job.id === "string" &&
            typeof job.request === "string" &&
            typeof job.status === "string"
        )
        .slice(0, MAX_DASHBOARD_HISTORY_ENTRIES)
        .map((job) => ({
          ...job,
          canResume: false,
          canComment: false,
          logs: []
        })),
      warning: null
    };
  } catch {
    return {
      jobs: [],
      warning: "Saved dashboard job history could not be read."
    };
  }
}

function writeDashboardHistory(path, jobs) {
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({
      version: 1,
      jobs: jobs.slice(0, MAX_DASHBOARD_HISTORY_ENTRIES)
    }),
    { mode: 0o600 }
  );
  renameSync(temporaryPath, path);
}

function inferAzureDevOpsSettings(repository) {
  const remote = spawnSync(
    "git",
    ["-C", repository, "remote", "get-url", "origin"],
    { encoding: "utf8", windowsHide: true }
  );
  const match = remote.stdout
    ?.trim()
    .match(
      /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/[^/]+\/?$/i
    );
  return match
    ? {
        organization: decodeURIComponent(match[1]),
        project: decodeURIComponent(match[2])
      }
    : null;
}

function azureDevOpsProfile(repository, profile) {
  if (profile.azureDevOps?.organization && profile.azureDevOps?.project) {
    return profile;
  }
  const inferred = inferAzureDevOpsSettings(repository);
  return inferred
    ? {
        ...profile,
        azureDevOps: {
          ...profile.azureDevOps,
          ...inferred
        }
      }
    : profile;
}

function summarizeMetrics(records, period) {
  const durations = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000
  };
  const cutoff = durations[period] ? Date.now() - durations[period] : 0;
  const selected = records.filter(
    (record) => Date.parse(record.createdAt) >= cutoff
  );
  const completed = selected.filter((record) => record.finishedAt);
  const usageJobs = completed.filter(
    (record) => Number.isFinite(record.inputTokens) && record.inputTokens > 0
  );
  const totalInputTokens = usageJobs.reduce(
    (total, record) => total + record.inputTokens,
    0
  );
  const totalCachedInputTokens = usageJobs.reduce(
    (total, record) => total + record.cachedInputTokens,
    0
  );
  const evidenceReductionJobs = completed.filter((record) =>
    Number.isFinite(record.commandEvidenceReductionPercent)
  );
  return {
    period,
    queued: selected.length,
    completed: completed.length,
    passed: completed.filter((record) => record.status === "passed").length,
    failed: completed.filter((record) => record.status === "failed").length,
    blocked: completed.filter((record) => record.status === "blocked").length,
    cancelled: completed.filter((record) => record.status === "cancelled").length,
    bugs: selected.reduce((total, record) => total + record.bugCount, 0),
    retries: selected.reduce(
      (total, record) => total + (record.retryCount ?? 0),
      0
    ),
    resumes: selected.reduce(
      (total, record) => total + (record.resumeCount ?? 0),
      0
    ),
    humanInterventions: selected.reduce(
      (total, record) => total + (record.humanInterventionCount ?? 0),
      0
    ),
    validationReuses: selected.reduce(
      (total, record) => total + (record.validationReuseCount ?? 0),
      0
    ),
    browserRunAttempts: selected.reduce(
      (total, record) => total + (record.browserRunAttempts ?? 0),
      0
    ),
    preflightRecoveryAttempts: selected.reduce(
      (total, record) => total + (record.preflightRecoveryAttempts ?? 0),
      0
    ),
    averageCommandEvidenceReductionPercent:
      evidenceReductionJobs.length > 0
        ? Math.round(
            evidenceReductionJobs.reduce(
              (total, record) =>
                total + record.commandEvidenceReductionPercent,
              0
            ) *
              10 /
              evidenceReductionJobs.length
          ) / 10
        : null,
    averageDurationMs:
      completed.length > 0
        ? Math.round(
            completed.reduce(
              (total, record) => total + (record.durationMs ?? 0),
              0
            ) / completed.length
          )
        : null,
    usageJobs: usageJobs.length,
    totalInputTokens,
    totalCachedInputTokens,
    totalCacheWriteTokens: usageJobs.reduce(
      (total, record) => total + record.cacheWriteTokens,
      0
    ),
    totalOutputTokens: usageJobs.reduce(
      (total, record) => total + record.outputTokens,
      0
    ),
    cacheReusePercent:
      totalInputTokens > 0
        ? Math.round((totalCachedInputTokens / totalInputTokens) * 1000) / 10
        : null
  };
}

export function createCacheContext(repository) {
  try {
    const profilePath = join(repository, profileRelativePath);
    if (!existsSync(profilePath)) {
      return null;
    }
    const commonGitDirectory = runGit(repository, [
      "rev-parse",
      "--git-common-dir"
    ]);
    const head = runGit(repository, ["rev-parse", "HEAD"]);
    if (!commonGitDirectory || !head) {
      return null;
    }

    const gitDirectoryPath = isAbsolute(commonGitDirectory)
      ? commonGitDirectory
      : resolve(repository, commonGitDirectory);
    const repositoryIdentity = realpathSync.native(gitDirectoryPath);
    const profileContent = readFileSync(profilePath);
    const profile = JSON.parse(profileContent.toString("utf8"));
    const profileSummary = {
      name: safeSummary(profile.name ?? ""),
      sections: Object.keys(profile).sort().slice(0, 30),
      applications: Object.keys(profile.applications ?? {})
        .sort()
        .slice(0, 30)
    };
    const profileHash = hash(profileContent);
    return {
      key: hash(`${repositoryIdentity}\0${head}\0${profileHash}`),
      repositoryIdentityHash: hash(repositoryIdentity),
      head,
      profileHash,
      profileSummary,
      cachePath: join(gitDirectoryPath, "fixlab", "dashboard-cache.json")
    };
  } catch {
    return null;
  }
}

function readCache(cachePath) {
  if (!existsSync(cachePath)) {
    return { version: 1, entries: [] };
  }
  try {
    const content = readFileSync(cachePath);
    if (content.length > MAX_CACHE_BYTES) {
      return { version: 1, entries: [] };
    }
    const cache = JSON.parse(content.toString("utf8"));
    if (cache?.version !== 1 || !Array.isArray(cache.entries)) {
      return { version: 1, entries: [] };
    }
    return cache;
  } catch {
    return { version: 1, entries: [] };
  }
}

export function loadCacheSummary(context) {
  if (!context) {
    return null;
  }
  const cache = readCache(context.cachePath);
  const entry = cache.entries.find((candidate) => candidate.key === context.key);
  if (!entry) {
    return null;
  }
  return {
    profile: entry.profile,
    priorJob: entry.priorJob
  };
}

function writeCacheSummary(context, job) {
  if (!context) {
    return;
  }
  try {
    const cache = readCache(context.cachePath);
    const entry = {
      key: context.key,
      repositoryIdentityHash: context.repositoryIdentityHash,
      head: context.head,
      profileHash: context.profileHash,
      updatedAt: new Date().toISOString(),
      profile: context.profileSummary,
      priorJob: {
        result: job.status,
        mode: job.mode,
        requestType: job.requestType,
        stages: Object.fromEntries(
          FIXLAB_STAGES.map((stage) => [
            stage,
            {
              status: job.stages[stage].status,
              summary: safeSummary(job.stages[stage].message)
            }
          ])
        )
      }
    };
    cache.entries = [
      entry,
      ...cache.entries.filter((candidate) => candidate.key !== context.key)
    ].slice(0, MAX_CACHE_ENTRIES);

    mkdirSync(dirname(context.cachePath), { recursive: true });
    let content = JSON.stringify(cache);
    while (
      Buffer.byteLength(content) > MAX_CACHE_BYTES &&
      cache.entries.length > 1
    ) {
      cache.entries.pop();
      content = JSON.stringify(cache);
    }
    if (Buffer.byteLength(content) > MAX_CACHE_BYTES) {
      return;
    }
    writeFileSync(context.cachePath, content, { mode: 0o600 });
  } catch {
    // Cache reuse is an optimization and must never change the job outcome.
  }
}

export function buildAgencyInvocation({
  packageRoot,
  prompt,
  sessionId,
  resume = false
}) {
  if (!sessionId) {
    throw new Error("Agency invocation requires a session ID");
  }
  return {
    args: [
      "copilot",
      "--plugin-dir",
      packageRoot,
      "--agent",
      "fixlab:fixlab",
      "--allow-all-tools",
      "--no-ask-user",
      "--stream",
      "on",
      ...(resume ? [`--resume=${sessionId}`] : ["--session-id", sessionId])
    ],
    input: prompt
  };
}

export function buildCopilotInvocation({
  packageRoot,
  prompt,
  sessionId,
  resume = false
}) {
  if (!sessionId) {
    throw new Error("Copilot invocation requires a session ID");
  }
  return {
    args: [
      "--plugin-dir",
      packageRoot,
      "--agent",
      "fixlab:fixlab",
      "--allow-all-tools",
      "--no-ask-user",
      "--autopilot",
      "--stream",
      "on",
      ...(resume ? [`--resume=${sessionId}`] : ["--session-id", sessionId])
    ],
    input: prompt
  };
}

function findDirectExecutable(command) {
  const lookup = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [command],
    { encoding: "utf8", shell: false }
  );
  const candidates = lookup.stdout
    ?.split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  return process.platform === "win32"
    ? candidates?.find((value) => /\.exe$/i.test(value))
    : candidates?.[0];
}

function createExecutor({ command, packageRoot, buildInvocation }) {
  return ({ repository, prompt, sessionId, resume, onOutput }) => {
    const executable = findDirectExecutable(command);
    if (!executable) {
      throw new Error(
        `${command} executable is unavailable or is not a directly executable binary`
      );
    }
    const invocation = buildInvocation({
      packageRoot,
      prompt,
      sessionId,
      resume
    });
    const child = spawn(executable, invocation.args, {
      cwd: repository,
      env: {
        ...process.env,
        FIXLAB_DASHBOARD_OUTPUT_COMPRESSION: "1",
        FIXLAB_OUTPUT_REPOSITORY: repository,
        FIXLAB_OUTPUT_SESSION_ID: sessionId,
        FIXLAB_NODE_EXECUTABLE: process.execPath,
        FIXLAB_OUTPUT_HOOK: join(packageRoot, "bin", "output-compression-hook.js")
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => onOutput("stdout", chunk.toString()));
    child.stderr.on("data", (chunk) => onOutput("stderr", chunk.toString()));
    child.stdin.on("error", (error) =>
      onOutput("stderr", `Could not send the FixLab prompt: ${error.message}\n`)
    );
    child.stdin.end(invocation.input);

    const completion = createProcessCompletion(child, onOutput);

    return {
      completion,
      terminate() {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }
    };
  };
}

export function createProcessCompletion(
  child,
  onOutput,
  outputDrainTimeoutMs = 500
) {
  return new Promise((resolveCompletion) => {
    let settled = false;
    let outputDrainTimer = null;
    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(outputDrainTimer);
      resolveCompletion(result);
    };

    child.once("error", (error) => {
      onOutput("stderr", `${error.message}\n`);
      settle({ code: null, error });
    });
    child.once("exit", (code, signal) => {
      outputDrainTimer = setTimeout(
        () => settle({ code, signal }),
        outputDrainTimeoutMs
      );
    });
    child.once("close", (code, signal) => {
      settle({ code, signal });
    });
  });
}

export function createAgencyExecutor({ packageRoot }) {
  return createExecutor({
    command: "agency",
    packageRoot,
    buildInvocation: buildAgencyInvocation
  });
}

export function createCopilotExecutor({ packageRoot }) {
  return createExecutor({
    command: "copilot",
    packageRoot,
    buildInvocation: buildCopilotInvocation
  });
}

export function createRuntimeExecutor({ packageRoot, runtime = "agency" }) {
  if (!FIXLAB_RUNTIMES.includes(runtime)) {
    throw new Error(
      `FixLab runtime must be one of: ${FIXLAB_RUNTIMES.join(", ")}`
    );
  }
  return runtime === "copilot"
    ? createCopilotExecutor({ packageRoot })
    : createAgencyExecutor({ packageRoot });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function publicJob(job) {
  if (!job) {
    return null;
  }
  return {
    id: job.id,
    request: job.request,
    requestType: job.requestType,
    pullRequestStrategy: job.pullRequestStrategy,
    runAllUiScenarios: job.runAllUiScenarios,
    targetEnvironment: job.targetEnvironment,
    recordPlaywrightVideo: job.recordPlaywrightVideo,
    manualLocalhostTest: job.manualLocalhostTest,
    manualLocalhostUrl: job.manualLocalhostUrl,
    manualLocalhostOpenedAt: job.manualLocalhostOpenedAt,
    manualLocalhostPending: job.manualLocalhostPending,
    manualLocalhostResult: job.manualLocalhostResult,
    testEvidence: job.testEvidence,
    browserRun: job.browserRun ?? null,
    execution: dashboardExecutionState(job),
    runtimeApproval: requiresInteractiveApproval(job)
      ? { command: job.interactiveApprovalCommand ?? null }
      : null,
    intakeSource: job.intakeSource,
    workItem: publicWorkItem(job.workItem),
    workItems: job.workItems.map(publicWorkItem),
    screenshots: job.screenshots.map(({ name, mimeType, bytes }) => ({
      name,
      mimeType,
      bytes
    })),
    mode: job.mode,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastActivityAt: job.lastActivityAt,
    error: job.error,
    canResume:
      job.browserRun?.status !== "running" &&
      !job.resumeDisabled &&
      ["blocked", "failed", "passed"].includes(job.status),
    canComment: job.status === "running",
    inputCount: job.inputs.length,
    pendingInputCount: job.pendingInputs.length,
    durationMs: Math.max(
      0,
      job.startedAt
        ? Date.parse(job.finishedAt ?? new Date().toISOString()) -
            Date.parse(job.startedAt)
        : 0
    ),
    usage: job.usage,
    stages: job.stages,
    pullRequestReadiness: getPullRequestReadiness(job),
    bugs: job.bugs,
    activity: job.activity,
    logs: job.logs,
    droppedLogs: job.droppedLogs
  };
}

function requiresInteractiveApproval(job) {
  if (!["blocked", "failed"].includes(job.status)) {
    return false;
  }
  const messages = [
    job.error ?? "",
    ...Object.values(job.stages).filter((stage) => stage.status === "blocked")
      .map((stage) => stage.message)
  ].join("\n");
  return /no interactive (?:user )?response.*available|interactive approval.*(?:required|unavailable)|permission denied.*interactive/iu.test(messages);
}

function dashboardExecutionState(job) {
  if (job.browserRun?.status === "running") {
    return { running: true, owner: "playwright", message: "Playwright is running; agent workflow gates remain separate." };
  }
  if (job.status === "running") {
    return { running: true, owner: "agent", message: "The agent is running." };
  }
  if (job.browserRun && ["failed", "blocked", "timed-out", "cancelled"].includes(job.browserRun.status)) {
    return {
      running: false, owner: null,
      message: `No process is running. Latest Playwright run: ${job.browserRun.status}. Agent workflow: ${job.status}.`
    };
  }
  return {
    running: false, owner: null,
    message: requiresInteractiveApproval(job)
      ? "No process is running. CLI permission approval requires an interactive terminal; Retry does not grant it."
      : `No process is running. Agent workflow: ${job.status}.`
  };
}

export function buildInteractiveResumeCommand({
  repository, packageRoot, runtime, sessionId, platform = process.platform
}) {
  if (!FIXLAB_RUNTIMES.includes(runtime) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(sessionId)) {
    throw new Error("Interactive approval requires a supported runtime and a valid session ID.");
  }
  const quote = platform === "win32"
    ? (value) => `'${String(value).replace(/'/gu, "''")}'`
    : (value) => `'${String(value).replace(/'/gu, "'\\''")}'`;
  const arguments_ = [
    ...(runtime === "agency" ? ["copilot"] : []),
    "--plugin-dir", packageRoot, "--agent", "fixlab:fixlab", `--resume=${sessionId}`
  ].map(quote).join(" ");
  return platform === "win32"
    ? `Set-Location -LiteralPath ${quote(repository)}; & ${quote(runtime)} ${arguments_}`
    : `cd -- ${quote(repository)} && ${quote(runtime)} ${arguments_}`;
}

function publicWorkItem(workItem) {
  if (!workItem) {
    return null;
  }
  const {
    id,
    title,
    state,
    workItemType,
    webUrl,
    comments,
    commentCount,
    commentsWarning
  } = workItem;
  return {
    id,
    title,
    state,
    workItemType,
    webUrl,
    commentCount: Array.isArray(comments)
      ? comments.length
      : Number.isSafeInteger(commentCount)
        ? commentCount
        : 0,
    commentsWarning
  };
}

function persistedWorkItem(workItem) {
  const summary = publicWorkItem(workItem);
  if (!summary) {
    return null;
  }
  return {
    ...summary,
    title: safePersistedSummary(summary.title),
    webUrl: "",
    commentsWarning: safePersistedSummary(summary.commentsWarning)
  };
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw new Error("request body is required");
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be a JSON object");
  }
  return body;
}

function validateWorkItemSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Azure DevOps intake requires a loaded work item");
  }
  const textFields = [
    "title",
    "description",
    "reproduction",
    "acceptanceCriteria",
    "state",
    "workItemType",
    "webUrl"
  ];
  const result = {};
  if (!Number.isSafeInteger(value.id) || value.id < 1) {
    throw new Error("loaded work item ID is invalid");
  }
  result.id = value.id;
  for (const field of textFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`loaded work item ${field} must be a string`);
    }
    const maximum = [
      "description",
      "reproduction",
      "acceptanceCriteria"
    ].includes(field)
      ? 20000
      : 1000;
    result[field] = (value[field] ?? "").trim().slice(0, maximum);
  }
  if (value.comments !== undefined && !Array.isArray(value.comments)) {
    throw new Error("loaded work item comments must be an array");
  }
  result.comments = (value.comments ?? []).slice(0, 20).map((comment) => {
    if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
      throw new Error("loaded work item comments must be objects");
    }
    for (const field of ["author", "createdAt", "text"]) {
      if (comment[field] !== undefined && typeof comment[field] !== "string") {
        throw new Error(`loaded work item comment ${field} must be a string`);
      }
    }
    return {
      author: (comment.author ?? "").trim().slice(0, 200),
      createdAt: (comment.createdAt ?? "").trim().slice(0, 100),
      text: (comment.text ?? "").trim().slice(0, 2000)
    };
  });
  if (
    value.commentsWarning !== undefined &&
    typeof value.commentsWarning !== "string"
  ) {
    throw new Error("loaded work item comments warning must be a string");
  }
  result.commentsWarning = (value.commentsWarning ?? "")
    .trim()
    .slice(0, 500);
  if (
    result.webUrl &&
    !/^https:\/\/dev\.azure\.com\//i.test(result.webUrl)
  ) {
    throw new Error("loaded work item URL must use https://dev.azure.com");
  }
  return result;
}

function validateLoadedScreenshots(value, state) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("loaded Azure DevOps screenshots must be an array");
  }
  const result = [];
  for (const screenshot of value) {
    if (state.count >= MAX_SCREENSHOTS) {
      throw new Error(
        `loaded Azure DevOps screenshots exceed the ${MAX_SCREENSHOTS}-image limit`
      );
    }
    if (!screenshot || typeof screenshot !== "object") {
      throw new Error("loaded Azure DevOps screenshots must be objects");
    }
    const name =
      typeof screenshot.name === "string" ? screenshot.name.trim() : "";
    const mimeType =
      typeof screenshot.mimeType === "string"
        ? screenshot.mimeType.toLowerCase()
        : "";
    const base64 =
      typeof screenshot.base64 === "string" ? screenshot.base64 : "";
    if (
      !name ||
      name !== basename(name) ||
      name.includes("..") ||
      !["image/png", "image/jpeg", "image/webp"].includes(mimeType) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        base64
      )
    ) {
      throw new Error("loaded Azure DevOps screenshot metadata is invalid");
    }
    const bytes = Buffer.from(base64, "base64").length;
    if (bytes > MAX_SCREENSHOT_BYTES) {
      throw new Error("loaded Azure DevOps screenshot exceeds 2 MiB");
    }
    state.totalBytes += bytes;
    if (state.totalBytes > MAX_SCREENSHOT_TOTAL_BYTES) {
      throw new Error("loaded Azure DevOps screenshots exceed 8 MiB total");
    }
    state.count += 1;
    result.push({ name, mimeType, base64 });
  }
  return result;
}

function appendOutput(job, stream, text) {
  const normalized = text.replace(/\r\n/g, "\n");
  job.partial[stream] += normalized;
  const lines = job.partial[stream].split("\n");
  job.partial[stream] = lines.pop();
  for (const line of lines) {
    appendLine(job, stream, line);
  }
}

function appendLine(job, stream, line) {
  pushLog(job, {
    index: job.nextLogIndex,
    timestamp: new Date().toISOString(),
    stream,
    message: line
  });
  const usage = parseUsageLine(line);
  if (usage) {
    job.usage = usage;
  }
  const activityMarker = line.match(/^FIXLAB_ACTIVITY\|([^|]+)\|(.*)$/);
  if (activityMarker) {
    const [, stage, message] = activityMarker;
    if (!FIXLAB_STAGES.includes(stage)) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `Ignored invalid activity marker: ${line}`
      });
      return;
    }
    pushActivity(job, {
      timestamp: new Date().toISOString(),
      stage,
      message: safeSummary(message)
    });
    return;
  }
  const bugMarker = line.match(
    /^FIXLAB_BUG\|(\d+)\|([^|]+)\|([^|]+)\|(.*)$/
  );
  if (bugMarker) {
    const [, id, outcome, owner, summary] = bugMarker;
    const bug = job.bugs.find((candidate) => candidate.id === id);
    if (!bug || !bugOutcomeStatuses.has(outcome)) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `Ignored invalid bug outcome marker: ${line}`
      });
      return;
    }

    bug.outcome = outcome;
    bug.owner = safeSummary(owner);
    bug.summary = safeSummary(summary);
    return;
  }

  const testMarker = line.match(
    /^FIXLAB_TEST\|([^|]+)\|([^|]+)\|(.*)$/
  );
  if (testMarker) {
    const [, source, mutationMode, scenario] = testMarker;
    if (!testDataSources.has(source) || !mutationModes.has(mutationMode)) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `Ignored invalid test evidence marker: ${line}`
      });
      return;
    }
    job.testEvidence = {
      ...job.testEvidence,
      source,
      mutationMode,
      reported: true,
      scenario: safeSummary(scenario)
    };
    return;
  }

  if (line === "FIXLAB_MANUAL|localhost|pending") {
    if (!job.manualLocalhostTest) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: "Ignored manual localhost marker for a job without that option."
      });
      return;
    }
    job.manualLocalhostPending = true;
    job.manualLocalhostResult = null;
    return;
  }

  const marker =
    line.match(/^FIXLAB_STAGE\|([^|]+)\|([^|]+)\|(.*)$/) ??
    line.match(/^FIXLAB_STAGE\s+(\S+)\s+(\S+)\s+-\s+(.*)$/);
  if (!marker) {
    return;
  }
  const [, stage, status, message] = marker;
  if (!FIXLAB_STAGES.includes(stage) || !allStatuses.has(status)) {
    pushLog(job, {
      index: job.nextLogIndex,
      timestamp: new Date().toISOString(),
      stream: "dashboard",
      message: `Ignored invalid stage marker: ${line}`
    });
    return;
  }
  job.stages[stage] = { status, message: message.trim() };
  if (status === "failed" && !job.error) {
    job.error = message.trim() || `${stage} failed`;
  }
}

function pushLog(job, entry) {
  job.nextLogIndex += 1;
  job.logs.push(entry);
  if (job.logs.length > MAX_JOB_LOG_ENTRIES) {
    job.logs.shift();
    job.droppedLogs += 1;
  }
}

function pushActivity(job, entry) {
  job.activity.push(entry);
  if (job.activity.length > MAX_JOB_ACTIVITY_ENTRIES) {
    job.activity.shift();
  }
}

function finishJob(job, result) {
  for (const stream of ["stdout", "stderr"]) {
    if (job.partial[stream]) {
      appendLine(job, stream, job.partial[stream]);
      job.partial[stream] = "";
    }
  }

  if (
    job.testEvidence.enabled &&
    job.testEvidence.requireScenarioEvidence &&
    job.stages["live-test"].status === "passed" &&
    (!job.testEvidence.reported || !job.testEvidence.scenario)
  ) {
    const message =
      "Live-test passed without required FIXLAB_TEST scenario evidence.";
    job.stages["live-test"] = { status: "failed", message };
    job.error = job.error ? `${job.error}; ${message}` : message;
  }

  if (job.manualLocalhostPending) {
    job.stages["live-test"] = {
      status: "blocked",
      message:
        "Manual React localhost validation requires an explicit Passed or Failed result."
    };
  }
  if (job.manualLocalhostResult === "failed") {
    const message = "Manual React localhost validation failed.";
    job.stages["live-test"] = { status: "failed", message };
    job.error = job.error ? `${job.error}; ${message}` : message;
  }

  const missing = FIXLAB_STAGES.filter(
    (stage) => !terminalStatuses.has(job.stages[stage].status)
  );
  const failed = FIXLAB_STAGES.filter(
    (stage) => job.stages[stage].status === "failed"
  );
  const blocked = FIXLAB_STAGES.filter(
    (stage) => job.stages[stage].status === "blocked"
  );
  const unresolvedBugs = job.bugs.filter(
    (bug) => bug.outcome === "pending"
  );
  if (result?.error && !job.error) {
    job.error = result.error.message;
  }
  if (result?.code !== 0 && !job.error) {
    job.error = `Agency exited with code ${result?.code ?? "unknown"}${
      result?.signal ? ` (${result.signal})` : ""
    }`;
  }
  if (missing.length > 0) {
    const incomplete = `Incomplete stage markers: ${missing.join(", ")}`;
    job.error = job.error ? `${job.error}; ${incomplete}` : incomplete;
  }
  if (failed.length > 0 && !job.error) {
    job.error = `Failed stages: ${failed.join(", ")}`;
  }
  if (unresolvedBugs.length > 0) {
    const incomplete = `Missing bug outcomes: ${unresolvedBugs
      .map((bug) => bug.id)
      .join(", ")}`;
    job.error = job.error ? `${job.error}; ${incomplete}` : incomplete;
  }
  job.status =
    result?.code === 0 &&
    missing.length === 0 &&
    failed.length === 0 &&
    unresolvedBugs.length === 0
      ? blocked.length > 0
        ? "blocked"
        : "passed"
      : "failed";
  job.finishedAt = new Date().toISOString();
  writeCacheSummary(job.cacheContext, job);
}

function buildResumePrompt(job, { action, details }) {
  const expectedBugs = job.bugs.map((bug) => bug.id).join(", ");
  const manualResult = job.manualLocalhostResult
    ? `Persisted manual React localhost result: ${job.manualLocalhostResult}.
- Preserve this accepted result as job evidence across retries or dashboard restarts.
- Do not ask for another manual result unless a new frontend change invalidates it.`
    : "No persisted manual React localhost result is available.";
  return `Resume the existing FixLab dashboard session for job ${job.id}.
User action: ${action}
User input:
${details}
${manualResult}
Latest job-linked background Playwright outcome: ${job.browserRun
  ? `${job.browserRun.status}. ${safeSummary(job.browserRun.message)}`
  : "No background test has been recorded."}

Resume requirements:
- Reuse the completed diagnosis, current worktree, validation evidence, branch, and pull request from this session.
- Re-read repository instructions and the effective diff only when the new input changes them.
- Continue from the blocked or failed stage, or treat this as a focused addition to the completed job.
- Do not repeat completed investigation, dependency installation, broad tests, or builds without new risk evidence.
- If the user selected skip, mark only the affected gate skipped, preserve the risk, and continue safe remaining work.
- Emit one updated FIXLAB_BUG line for every expected bug before finishing. Expected IDs: ${expectedBugs || "none"}.
- Emit terminal FIXLAB_STAGE lines for every stage before finishing.
- Do not create a duplicate or empty pull request. Reuse an existing pull request when one belongs to this session.
- Do not call task_complete or return the final response until all required machine-readable lines are emitted.`;
}

function backgroundCommandSummary(job, repository) {
  if (!job.browserRun) {
    return "";
  }
  let summary = job.browserRun.commandSummary ?? "";
  if (!summary && job.browserRun.evidenceId && job.cacheContext) {
    try {
      showStructuredEvidence(
        ["show", job.browserRun.evidenceId],
        repository,
        { stdout: { write(text) { summary += text; } } }
      );
    } catch (error) {
      return `Background command evidence is unavailable: ${safeSummary(error.message)}`;
    }
  }
  return summary ? `Compact background command evidence (not raw logs):\n${summary}` : "";
}

function dashboardCommandOutputContract(packageRoot) {
  return `
Dashboard command-output contract for this turn:
- Route every finite, non-interactive shell command through \`fixlab exec\`, not just validation. This includes repository discovery, Git queries and mutations, searches, dependency restores, browser tests, health probes, and external-data commands when already authorized.
- Use the current Node executable ${JSON.stringify(process.execPath)} and installed CLI entrypoint ${JSON.stringify(join(packageRoot, "bin", "fixlab.js"))} when the global fixlab command is unavailable. Pass \`exec <repository> --cwd <repository-relative-directory> --stage <stage> -- <executable> [args...]\`.
- Keep only the compact command summary in agent context. For successful commands whose returned data is needed, inspect the exact bounded redacted stdout using \`fixlab evidence show <evidence-id> --stream stdout --lines <count>\`. Do not dump full evidence or dashboard logs into prompts.
- Do not recursively wrap \`fixlab exec\` or \`fixlab evidence show\` themselves. If the workspace has no Git metadata, report structured capture unavailable and use bounded tool output; do not initialize Git without authorization or claim compressed evidence was retained.
- Compression does not authorize a command, enable caching, or turn a failed, skipped, cancelled, blocked, or timed-out gate into success. Preserve exit status, test counts, new diagnostics, evidence identifiers, and context-reduction measurements.
- Never add \`--reuse\` to live checks, browser tests, installs, startup, authentication, external reads, or mutations.
- Interactive authentication and long-lived applications must retain their existing approved execution and process-ownership paths. Report concise readiness or blocker summaries instead of returning their full output. Do not wrap an interactive program with a non-interactive command capture.
- This contract also applies after retries, queued comments, and session resumption.`;
}

function buildFreshRetryPrompt(job, details) {
  return `${job.initialPrompt}

Retry context:
The previous runtime launch failed before FixLab completed any stage or created
a resumable session. Start this job again from intake.

User input:
${details}`;
}

function requiresFreshRetry(job, action) {
  return (
    action === "retry" &&
    FIXLAB_STAGES.every((stage) => job.stages[stage].status === "pending") &&
    job.usage.inputTokens === 0 &&
    job.usage.outputTokens === 0
  );
}

function isContainedPath(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function resolveContainedPath(root, candidate, label, { mustExist = false } = {}) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  if (!isContainedPath(resolvedRoot, resolvedCandidate)) {
    throw new Error(`${label} must stay within ${resolvedRoot}`);
  }
  if (!existsSync(resolvedCandidate)) {
    if (mustExist) {
      throw new Error(`${label} does not exist`);
    }
    return resolvedCandidate;
  }
  const realRoot = realpathSync(resolvedRoot);
  const realCandidate = realpathSync(resolvedCandidate);
  if (!isContainedPath(realRoot, realCandidate)) {
    throw new Error(`${label} resolves outside ${realRoot}`);
  }
  return realCandidate;
}

function playwrightAuthenticationConfig(repository) {
  const profile = loadRepositoryProfile(repository);
  const browserAutomation = profile.browserAutomation ?? {};
  const authentication = browserAutomation.authentication ?? {};
  const workingDirectory = resolveContainedPath(
    repository,
    browserAutomation.workingDirectory ??
      profile.applications?.frontend?.workingDirectory ??
      ".",
    "browserAutomation.workingDirectory",
    { mustExist: true }
  );
  const command =
    typeof authentication.command === "string"
      ? authentication.command.trim()
      : "";
  const statusPaths = Array.isArray(authentication.statusPaths)
    ? authentication.statusPaths
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
    : [];
  const environment = Object.fromEntries(
    Object.entries(authentication.environment ?? {}).filter(
      ([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        typeof value === "string"
    )
  );
  return {
    command,
    environment,
    required: authentication.required === true,
    statusPaths,
    workingDirectory
  };
}

function playwrightAuthenticationStatus(repository, connection) {
  let configuration;
  try {
    configuration = playwrightAuthenticationConfig(repository);
  } catch (error) {
    return {
      configured: false,
      required: false,
      ready: false,
      running: Boolean(connection.handle),
      error: error.message,
      lastResult: connection.lastResult,
      paths: []
    };
  }
  const paths = configuration.statusPaths.map((relativePath) => {
    const path = resolveContainedPath(
      configuration.workingDirectory,
      relativePath,
      "browserAutomation.authentication.statusPaths entry"
    );
    return {
      path: relativePath,
      ready: existsSync(path)
    };
  });
  return {
    configured: Boolean(
      configuration.command && configuration.statusPaths.length > 0
    ),
    required: configuration.required,
    ready:
      !configuration.required ||
      (Boolean(configuration.command) &&
        paths.length > 0 &&
        paths.every((entry) => entry.ready)),
    running: Boolean(connection.handle),
    error: "",
    lastResult: connection.lastResult,
    paths
  };
}

function playwrightArtifactRoots(repository) {
  const configuration = playwrightAuthenticationConfig(repository);
  return ["test-results", "playwright-report", "artifacts"]
    .map((directory) =>
      resolveContainedPath(
        configuration.workingDirectory,
        directory,
        `Playwright artifact root ${directory}`
      )
    )
    .filter((directory) => existsSync(directory));
}

function collectPlaywrightArtifacts(root, directory = root, depth = 0) {
  if (depth > 6) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectPlaywrightArtifacts(root, path, depth + 1));
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (
      ![".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4"].includes(
        extension
      )
    ) {
      continue;
    }
    const resolvedPath = realpathSync(path);
    const relativePath = relative(root, resolvedPath);
    if (
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    ) {
      continue;
    }
    const stats = statSync(resolvedPath);
    const video = [".webm", ".mp4"].includes(extension);
    if (
      stats.size >
      (video ? MAX_PLAYWRIGHT_VIDEO_BYTES : MAX_SCREENSHOT_BYTES)
    ) {
      continue;
    }
    files.push({
      id: createHash("sha256").update(resolvedPath).digest("hex").slice(0, 24),
      path: resolvedPath,
      name: basename(resolvedPath),
      relativePath,
      bytes: stats.size,
      updatedAt: stats.mtime.toISOString(),
      kind: video ? "video" : "image",
      mimeType:
        extension === ".png"
          ? "image/png"
          : extension === ".webp"
            ? "image/webp"
            : extension === ".webm"
              ? "video/webm"
              : extension === ".mp4"
                ? "video/mp4"
                : "image/jpeg"
    });
  }
  return files;
}

function listPlaywrightArtifacts(repository, { since = null } = {}) {
  return playwrightArtifactRoots(repository)
    .flatMap((root) =>
      collectPlaywrightArtifacts(root)
        .map((artifact) => ({
          ...artifact,
          relativePath: join(basename(root), artifact.relativePath)
        }))
    )
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    )
    .filter(
      (artifact) =>
        !since || Date.parse(artifact.updatedAt) >= Date.parse(since)
    )
    .slice(0, MAX_PLAYWRIGHT_ARTIFACTS);
}

function resetJobForResume(job) {
  const restartIndex =
    job.status === "passed"
      ? FIXLAB_STAGES.indexOf("diagnosis")
      : Math.max(
          0,
          FIXLAB_STAGES.findIndex((stage) =>
            ["blocked", "failed"].includes(job.stages[stage].status)
          )
        );
  for (const stage of FIXLAB_STAGES.slice(restartIndex)) {
    job.stages[stage] = { status: "pending", message: "" };
  }
  for (const bug of job.bugs) {
    bug.outcome = "pending";
    bug.owner = "";
    bug.summary = "";
  }
  job.status = "running";
  job.finishedAt = null;
  job.error = null;
  job.partial = { stdout: "", stderr: "" };
}

export function createDashboardServer({
  repository,
  packageRoot,
  runtime = "agency",
  publicDirectory = join(packageRoot, "dashboard", "public"),
  executor = createRuntimeExecutor({ packageRoot, runtime }),
  workItemLoader = createAzureDevOpsLoader(),
  browserOpener = openLocalUrl,
  playwrightExecutor = runPlaywrightTest,
  executionIdleTimeoutMs,
  executionHeartbeatMs = DEFAULT_EXECUTION_HEARTBEAT_MS
}) {
  const resolvedRepository = resolve(repository);
  let currentJob = null;
  let activeHandle = null;
  let browserHandle = null;
  const queuedJobs = [];
  const completedJobs = [];
  const artifactDirectories = new Set();
  const playwrightConnection = { handle: null, lastResult: null };
  const playwrightArtifacts = new Map();
  const cacheContext = createCacheContext(resolvedRepository);
  const metricsPath = cacheContext
    ? join(dirname(cacheContext.cachePath), "dashboard-metrics.json")
    : null;
  const dashboardHistoryPath = cacheContext
    ? join(dirname(cacheContext.cachePath), "dashboard-jobs.json")
    : null;
  const loadedMetrics = readMetrics(metricsPath);
  let metricsRecords = loadedMetrics.records;
  let metricsWarning = loadedMetrics.warning;
  const loadedDashboardHistory = readDashboardHistory(dashboardHistoryPath);
  let persistedJobs = loadedDashboardHistory.jobs.map((job) =>
    recoverInterruptedDashboardJob(job)
  );
  let dashboardHistoryWarning = loadedDashboardHistory.warning;
  const resumableSnapshot = persistedJobs.find((job) =>
    ["blocked", "failed", "passed"].includes(job.status)
  );
  if (resumableSnapshot) {
    currentJob = restoreDashboardJob(
      resumableSnapshot,
      resolvedRepository
    );
    currentJob.interactiveApprovalCommand = buildInteractiveResumeCommand({
      repository: resolvedRepository, packageRoot, runtime, sessionId: currentJob.id
    });
    persistedJobs = persistedJobs.filter(
      (job) => job.id !== resumableSnapshot.id
    );
  }

  function dashboardHistory() {
    const liveIds = new Set([
      currentJob?.id,
      ...queuedJobs.map((job) => job.id),
      ...completedJobs.map((job) => job.id)
    ]);
    return [
      ...publicHistory(completedJobs),
      ...persistedJobs.filter((job) => !liveIds.has(job.id))
    ].slice(0, MAX_DASHBOARD_HISTORY_ENTRIES);
  }

  function persistDashboardState() {
    const snapshots = [
      ...(currentJob ? [dashboardSnapshot(currentJob)] : []),
      ...queuedJobs.map(dashboardSnapshot),
      ...completedJobs.map(dashboardSnapshot),
      ...persistedJobs
    ];
    const unique = [];
    const ids = new Set();
    for (const job of snapshots) {
      if (!job?.id || ids.has(job.id)) {
        continue;
      }
      ids.add(job.id);
      unique.push(job);
    }
    persistedJobs = unique.slice(0, MAX_DASHBOARD_HISTORY_ENTRIES);
    try {
      writeDashboardHistory(dashboardHistoryPath, persistedJobs);
      dashboardHistoryWarning = null;
    } catch {
      dashboardHistoryWarning =
        "Dashboard jobs remain visible in memory but could not be persisted.";
    }
  }

  function browserRunPlan() {
    if (!currentJob || currentJob.status === "queued") {
      throw new Error("Select a started FixLab job before running Playwright.");
    }
    const profile = loadRepositoryProfile(resolvedRepository);
    const validation = validateLiveTestProfile(profile, resolvedRepository);
    if (!validation.ok) {
      throw new Error(`Playwright profile is not ready: ${validation.detail}`);
    }
    const browser = profile.browserAutomation;
    if (!["@playwright/test", "playwright"].includes(browser.package) ||
        !["chromium", "firefox", "webkit"].includes(browser.browser)) {
      throw new Error("Use a supported Playwright package and browser in the repository profile.");
    }
    if (!["none", "intercepted"].includes(browser.testSynthesis.mutationMode)) {
      throw new Error("Background tests require a repository-owned read-only or intercepted-mutation contract.");
    }
    const configuredCommand = browser.testCommand.trim();
    if (/[&|;<>\r\n]/u.test(configuredCommand)) {
      throw new Error("Background tests require a single repository-owned test command, not shell chaining or redirection.");
    }
    const command = withPlaywrightProgress(
      configuredCommand,
      join(packageRoot, "dashboard", "playwright-reporter.js")
    );
    if (sanitize(command) !== command ||
        safeSummary(command) === "[omitted potentially sensitive summary]") {
      throw new Error("Playwright commands must not contain credentials.");
    }
    const configuration = playwrightAuthenticationConfig(resolvedRepository);
    const environment = validateTargetEnvironment(
      currentJob.targetEnvironment,
      configuredValidationEnvironments(profile)
    );
    const settings = configuredEnvironmentSettings(profile, environment);
    if (environment && !settings) {
      throw new Error("The selected environment requires explicit profile startup settings; no fallback is allowed.");
    }
    if (settings?.authenticationRequired || configuration.required) {
      if (!configuration.statusPaths.length ||
          configuration.statusPaths.some((path) =>
            !existsSync(resolveContainedPath(configuration.workingDirectory, path, "authentication status path")))) {
        throw new Error("Browser authentication is not ready; connect Playwright first.");
      }
    }
    const timeoutMinutes = browser.timeoutMinutes ?? 30;
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) {
      throw new Error("browserAutomation.timeoutMinutes must be an integer from 1 to 120.");
    }
    const executionEnvironment = {
      ...configuration.environment,
      ...(settings ? { E2E_START: settings.frontendCommand } : {})
    };
    const plan = {
      jobId: currentJob.id,
      command,
      workingDirectory: browser.workingDirectory,
      absoluteWorkingDirectory: configuration.workingDirectory,
      environment: environment || "profile default",
      executionEnvironment,
      configuration: {
        package: browser.package,
        browser: browser.browser,
        channel: browser.channel,
        preflightRecovery: configuredPreflightRecovery(profile)
      },
      policy: safeSummary(browser.dataSafety.policy),
      timeoutMs: timeoutMinutes * 60 * 1000
    };
    return {
      ...plan,
      approvalId: createHash("sha256").update(JSON.stringify(plan)).digest("hex")
    };
  }

  function recordJobMetric(job) {
    metricsRecords = updateJobMetrics(metricsRecords, job);
    try {
      writeMetrics(metricsPath, metricsRecords);
      metricsWarning = null;
    } catch {
      metricsWarning =
        "Dashboard metrics were updated in memory but could not be persisted.";
    }
    persistDashboardState();
  }

  function archiveJob(job) {
    if (!job || completedJobs.some((entry) => entry.id === job.id)) {
      return;
    }
    completedJobs.unshift(job);
    completedJobs.splice(20);
  }

  function startJob(job, prompt, resume = false) {
    job.interactiveApprovalCommand = buildInteractiveResumeCommand({
      repository: resolvedRepository, packageRoot, runtime, sessionId: job.id
    });
    const profileIdleTimeoutMinutes = Number(
      loadRepositoryProfile(resolvedRepository).validation
        ?.agentIdleTimeoutMinutes
    );
    const idleTimeoutMs =
      executionIdleTimeoutMs ??
      (Number.isFinite(profileIdleTimeoutMinutes) &&
      profileIdleTimeoutMinutes > 0
        ? profileIdleTimeoutMinutes * 60 * 1000
        : DEFAULT_EXECUTION_IDLE_TIMEOUT_MS);
    let idleTimer = null;
    let heartbeatTimer = null;
    let resolveIdleCompletion;
    let handle;
    const idleCompletion = new Promise((resolveCompletion) => {
      resolveIdleCompletion = resolveCompletion;
    });
    const armIdleWatchdog = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const error = new Error(
          `FixLab agent produced no output for ${Math.round(
            idleTimeoutMs / 60000
          )} minute(s); the owned executor was stopped and the job can be resumed.`
        );
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: error.message
        });
        resolveIdleCompletion({ code: null, error });
        try {
          handle?.terminate?.();
        } catch (terminationError) {
          pushLog(job, {
            index: job.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message: `Could not stop the idle executor: ${terminationError.message}`
          });
        }
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const emitHeartbeat = () => {
      if (job.status !== "running" || !job.lastActivityAt) {
        return;
      }
      const quietMs = Date.now() - Date.parse(job.lastActivityAt);
      if (quietMs < executionHeartbeatMs) {
        return;
      }
      const stage =
        FIXLAB_STAGES.find(
          (candidate) => job.stages[candidate].status === "running"
        ) ?? "intake";
      const quietMinutes = Math.max(1, Math.round(quietMs / 60000));
      const timeoutMinutes = Math.max(1, Math.round(idleTimeoutMs / 60000));
      pushActivity(job, {
        timestamp: new Date().toISOString(),
        stage,
        message:
          `This ${stage.replaceAll("-", " ")} step is still running after ` +
          `${quietMinutes} minute(s) without new output. Long-running builds ` +
          `and tests can remain quiet; FixLab will keep waiting and will stop ` +
          `the executor as resumable after ${timeoutMinutes} idle minute(s).`
      });
    };

    job.lastActivityAt = new Date().toISOString();
    handle = executor({
      repository: resolvedRepository,
      prompt: `${prompt}\n${backgroundCommandSummary(job, resolvedRepository)}\n${dashboardCommandOutputContract(packageRoot)}`,
      sessionId: job.id,
      resume,
      onOutput(stream, text) {
        job.lastActivityAt = new Date().toISOString();
        armIdleWatchdog();
        const localStackWasReady =
          job.stages["local-stack"].status === "passed";
        appendOutput(job, stream, text);
        if (
          job.manualLocalhostTest &&
          !job.manualLocalhostOpenedAt &&
          !job.manualLocalhostOpening &&
          !localStackWasReady &&
          job.stages["local-stack"].status === "passed"
        ) {
          job.manualLocalhostOpening = true;
          Promise.resolve()
            .then(() => browserOpener(job.manualLocalhostUrl))
            .then(() => {
              job.manualLocalhostOpenedAt = new Date().toISOString();
              pushLog(job, {
                index: job.nextLogIndex,
                timestamp: job.manualLocalhostOpenedAt,
                stream: "dashboard",
                message: "Opened the React localhost URL for manual validation."
              });
            })
            .catch((error) => {
              pushLog(job, {
                index: job.nextLogIndex,
                timestamp: new Date().toISOString(),
                stream: "dashboard",
                message: `Could not open React localhost automatically: ${error.message}`
              });
            })
            .finally(() => {
              job.manualLocalhostOpening = false;
            });
        }
      }
    });
    activeHandle = handle;
    armIdleWatchdog();
    heartbeatTimer = setInterval(emitHeartbeat, executionHeartbeatMs);
    heartbeatTimer.unref?.();
    Promise.race([Promise.resolve(handle.completion), idleCompletion])
      .then((result) => {
        finishJob(job, result);
        recordJobMetric(job);
      })
      .catch((error) => {
        finishJob(job, { code: null, error });
        recordJobMetric(job);
      })
      .finally(() => {
        clearTimeout(idleTimer);
        clearInterval(heartbeatTimer);
        if (activeHandle === handle) {
          activeHandle = null;
        }
        if (job.pendingInputs.length > 0) {
          const pendingInputs = job.pendingInputs.splice(0);
          const details = pendingInputs
            .map(
              (input, index) =>
                `Comment ${index + 1} (${input.createdAt}):\n${input.details}`
            )
            .join("\n\n");
          const prompt = buildResumePrompt(job, {
            action: "continue",
            details
          });
          resetJobForResume(job);
          recordJobMetric(job);
          try {
            startJob(job, prompt, true);
          } catch (error) {
            finishJob(job, { code: null, error });
            recordJobMetric(job);
            activeHandle = null;
          }
          return;
        }
        startNextJob();
      });
  }

  function startNextJob() {
    if (
      activeHandle ||
      browserHandle ||
      queuedJobs.length === 0 ||
      (currentJob && currentJob.status !== "passed")
    ) {
      return;
    }
    if (currentJob?.artifactDirectory) {
      removeArtifactDirectory(currentJob.artifactDirectory);
      artifactDirectories.delete(currentJob.artifactDirectory);
    }
    archiveJob(currentJob);
    currentJob = queuedJobs.shift();
    currentJob.status = "running";
    currentJob.startedAt = new Date().toISOString();
    currentJob.lastActivityAt = currentJob.startedAt;
    recordJobMetric(currentJob);
    try {
      startJob(currentJob, currentJob.pendingPrompt);
      delete currentJob.pendingPrompt;
    } catch (error) {
      finishJob(currentJob, { code: null, error });
      recordJobMetric(currentJob);
      activeHandle = null;
    }
  }

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(
      request.url,
      `http://${request.headers.host ?? DASHBOARD_HOST}`
    );
    if (["/api/playwright/run", "/api/playwright/run/stop"].includes(requestUrl.pathname)) {
      try {
        const origin = new URL(`http://${request.headers.host}`);
        if (!["127.0.0.1", "localhost"].includes(origin.hostname) ||
            (request.headers.origin && new URL(request.headers.origin).origin !== origin.origin)) {
          throw new Error("Untrusted dashboard origin.");
        }
      } catch {
        sendJson(response, 403, { error: "Playwright approval must use this loopback dashboard origin." });
        return;
      }
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/status") {
      persistDashboardState();
      sendJson(response, 200, {
        readiness: inspectRepository(resolvedRepository),
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs),
        history: dashboardHistory(),
        historyWarning: dashboardHistoryWarning
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/job") {
      persistDashboardState();
      sendJson(response, 200, {
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs),
        history: dashboardHistory(),
        historyWarning: dashboardHistoryWarning
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/metrics") {
      const period = requestUrl.searchParams.get("period") ?? "7d";
      if (!["24h", "7d", "30d", "all"].includes(period)) {
        sendJson(response, 400, {
          error: "period must be 24h, 7d, 30d, or all"
        });
        return;
      }
      sendJson(response, 200, {
        metrics: summarizeMetrics(metricsRecords, period),
        warning: metricsWarning
      });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/onboarding"
    ) {
      try {
        const profile = azureDevOpsProfile(
          resolvedRepository,
          loadRepositoryProfile(resolvedRepository)
        );
        sendJson(response, 200, {
          profileName: profile.name ?? "",
          azureDevOps: {
            organization: profile.azureDevOps?.organization ?? "",
            project: profile.azureDevOps?.project ?? ""
          }
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/onboarding/azure-devops"
    ) {
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        const body = await readJsonBody(request);
        const organization =
          typeof body.organization === "string"
            ? body.organization.trim()
            : "";
        const project =
          typeof body.project === "string" ? body.project.trim() : "";
        if (
          !organization ||
          !project ||
          organization.length > 100 ||
          project.length > 100
        ) {
          throw new Error(
            "Azure DevOps organization and project are required and must be at most 100 characters"
          );
        }
        const profilePath = join(resolvedRepository, profileRelativePath);
        const profile = loadRepositoryProfile(resolvedRepository);
        profile.azureDevOps = { organization, project };
        const temporaryPath = `${profilePath}.${process.pid}.tmp`;
        writeFileSync(
          temporaryPath,
          `${JSON.stringify(profile, null, 2)}\n`,
          { mode: 0o600 }
        );
        renameSync(temporaryPath, profilePath);
        sendJson(response, 200, {
          saved: true,
          azureDevOps: profile.azureDevOps
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/azure-devops/load"
    ) {
      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
        const readiness = inspectRepository(resolvedRepository);
        if (!readiness.profileReady) {
          throw new Error(readiness.error);
        }
        const profile = azureDevOpsProfile(
          resolvedRepository,
          loadRepositoryProfile(resolvedRepository)
        );
        const inputs = Array.isArray(body.workItems)
          ? body.workItems
          : [body.workItem];
        const uniqueInputs = [
          ...new Set(
            inputs
              .map((value) => String(value ?? "").trim())
              .filter(Boolean)
          )
        ];
        if (uniqueInputs.length < 1 || uniqueInputs.length > 20) {
          throw new Error("provide between 1 and 20 unique work item IDs or URLs");
        }
        const loaded =
          typeof workItemLoader.loadMany === "function"
            ? await workItemLoader.loadMany({
                workItems: uniqueInputs,
                profile
              })
            : await Promise.all(
                uniqueInputs.map((workItem) =>
                  workItemLoader({ workItem, profile })
                )
              );
        const screenshotState = { count: 0, totalBytes: 0 };
        const workItems = loaded.map((item) => {
          const workItem = validateWorkItemSummary(item);
          workItem.screenshots = validateLoadedScreenshots(
            item.screenshots,
            screenshotState
          );
          workItem.imagesWarning =
            typeof item.imagesWarning === "string"
              ? item.imagesWarning.trim().slice(0, 500)
              : "";
          return workItem;
        });
        sendJson(response, 200, {
          workItem: workItems.length === 1 ? workItems[0] : null,
          workItems
        });
      } catch (error) {
        sendJson(response, 400, {
          error: String(error.message).replace(
            /Bearer\s+\S+/gi,
            "Bearer [REDACTED]"
          )
        });
      }
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/job/dismiss"
    ) {
      if (!currentJob) {
        sendJson(response, 404, { error: "no FixLab job is available" });
        return;
      }
      if (activeHandle || browserHandle) {
        sendJson(response, 409, {
          error: "the current FixLab agent is still running or shutting down"
        });
        return;
      }
      if (!["blocked", "failed", "passed"].includes(currentJob.status)) {
        sendJson(response, 409, {
          error:
            "only an idle blocked, failed, or passed FixLab job can be closed"
        });
        return;
      }

      const closedJob = currentJob;
      pushLog(closedJob, {
        index: closedJob.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message:
          `Job closed by the user; its ${closedJob.status} outcome and evidence remain in dashboard history.`
      });
      if (closedJob.artifactDirectory) {
        removeArtifactDirectory(closedJob.artifactDirectory);
        artifactDirectories.delete(closedJob.artifactDirectory);
      }
      archiveJob(closedJob);
      currentJob = null;
      startNextJob();
      persistDashboardState();
      sendJson(response, 202, {
        job: publicJob(currentJob),
        closedJob: publicJob(closedJob),
        dismissedJob: publicJob(closedJob),
        queue: publicQueue(queuedJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/job/input"
    ) {
      if (browserHandle) {
        sendJson(response, 409, { error: "Stop or finish the owned Playwright run before resuming the agent." });
        return;
      }
      if (!currentJob) {
        sendJson(response, 404, { error: "no FixLab job is available" });
        return;
      }
      if (currentJob.resumeDisabled) {
        sendJson(response, 409, {
          error: "this FixLab job cannot be resumed safely"
        });
        return;
      }
      const running = currentJob.status === "running" && Boolean(activeHandle);
      if (
        !running &&
        !["blocked", "failed", "passed"].includes(currentJob.status)
      ) {
        sendJson(response, 409, {
          error:
            "user input can be added only to a running, blocked, failed, or completed job"
        });
        return;
      }
      if (!running && activeHandle) {
        sendJson(response, 409, {
          error: "the current FixLab agent is still shutting down"
        });
        return;
      }

      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const action = body.action ?? "continue";
      if (body.jobId && body.jobId !== currentJob.id) {
        sendJson(response, 409, { error: "The selected FixLab job has changed; review the current job." });
        return;
      }
      if (
        ![
          "comment",
          "continue",
          "retry",
          "skip",
          "manual-pass",
          "manual-fail"
        ].includes(action)
      ) {
        sendJson(response, 400, {
          error:
            "action must be comment, continue, retry, skip, manual-pass, or manual-fail"
        });
        return;
      }
      const manualResult = ["manual-pass", "manual-fail"].includes(action);
      if (manualResult && !currentJob.manualLocalhostPending) {
        sendJson(response, 409, {
          error: "manual localhost confirmation is not pending"
        });
        return;
      }
      if (currentJob.manualLocalhostPending && !manualResult) {
        sendJson(response, 409, {
          error:
            "manual localhost confirmation requires an explicit manual-pass or manual-fail action"
        });
        return;
      }
      const submittedDetails =
        typeof body.details === "string" ? body.details.trim() : "";
      if (!running && requiresInteractiveApproval(currentJob) &&
          ["continue", "retry", "comment"].includes(action) &&
          body.runtimeApprovalHandled !== true) {
        sendJson(response, 409, {
          code: "interactive_approval_required",
          error: "This session needs CLI permission approval in an interactive terminal. Another background retry cannot grant it.",
          command: currentJob.interactiveApprovalCommand
        });
        return;
      }
      const details = manualResult
        ? `The user completed manual React localhost validation and explicitly marked it ${
            action === "manual-pass" ? "passed" : "failed"
          }. Record the live-test stage as ${
            action === "manual-pass" ? "passed" : "failed"
          }, stop only the FixLab-owned frontend process, preserve this manual result in the job evidence, and continue the remaining gated outcome without rerunning Playwright.`
        : submittedDetails;
      if (!details || details.length > 10000) {
        sendJson(response, 400, {
          error: "details must be a non-empty string of at most 10000 characters"
        });
        return;
      }
      if (running && action !== "comment") {
        sendJson(response, 400, {
          error: "a running job accepts only comment input"
        });
        return;
      }

      const input = {
        action,
        details: body.runtimeApprovalHandled === true
          ? `${details}\nThe user reports completing interactive CLI approval and exiting the terminal. Verify actual runtime permissions; this acknowledgement does not grant permissions or mark any gate passed.`
          : details,
        createdAt: new Date().toISOString()
      };
      currentJob.inputs.push(input);
      if (manualResult) {
        currentJob.manualLocalhostPending = false;
        currentJob.manualLocalhostResult =
          action === "manual-pass" ? "passed" : "failed";
      }
      if (running) {
        currentJob.pendingInputs.push(input);
        pushLog(currentJob, {
          index: currentJob.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: `Comment ${currentJob.inputs.length} queued for the same FixLab session after the current agent turn.`
        });
        sendJson(response, 202, {
          job: publicJob(currentJob),
          queued: true,
          queue: publicQueue(queuedJobs)
        });
        return;
      }
      pushLog(currentJob, {
        index: currentJob.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `User input ${currentJob.inputs.length} accepted; resuming the same FixLab session.`
      });
      const freshRetry = requiresFreshRetry(currentJob, action);
      const prompt = freshRetry
        ? buildFreshRetryPrompt(currentJob, details)
        : buildResumePrompt(currentJob, { action, details: input.details });
      resetJobForResume(currentJob);
      recordJobMetric(currentJob);
      try {
        startJob(currentJob, prompt, !freshRetry);
      } catch (error) {
        finishJob(currentJob, { code: null, error });
        recordJobMetric(currentJob);
        activeHandle = null;
      }
      sendJson(response, 202, {
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs)
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/job/stop"
    ) {
      if (
        !currentJob ||
        currentJob.status !== "running" ||
        !activeHandle?.terminate
      ) {
        sendJson(response, 409, {
          error: "no running FixLab-owned executor is available to stop"
        });
        return;
      }
      if (
        !request.headers["content-type"]
          ?.toLowerCase()
          .startsWith("application/json")
      ) {
        sendJson(response, 400, {
          error: "Content-Type must be application/json"
        });
        return;
      }
      pushLog(currentJob, {
        index: currentJob.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message:
          "Stop requested from FixLab chat; stopping only the owned executor."
      });
      try {
        activeHandle.terminate();
      } catch (error) {
        sendJson(response, 500, {
          error: `could not stop the FixLab-owned executor: ${error.message}`
        });
        return;
      }
      sendJson(response, 202, {
        job: publicJob(currentJob),
        stopping: true
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/jobs/cancel"
    ) {
      if (
        !request.headers["content-type"]
          ?.toLowerCase()
          .startsWith("application/json")
      ) {
        sendJson(response, 400, {
          error: "Content-Type must be application/json"
        });
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const jobId =
        typeof body.jobId === "string" ? body.jobId.trim() : "";
      const position = Number(body.position);
      if (
        !jobId &&
        (!Number.isInteger(position) ||
          position < 1 ||
          position > queuedJobs.length)
      ) {
        sendJson(response, 400, {
          error: "provide a queued jobId or valid queue position"
        });
        return;
      }
      const queueIndex = jobId
        ? queuedJobs.findIndex((job) => job.id === jobId)
        : position - 1;
      if (queueIndex < 0 || queueIndex >= queuedJobs.length) {
        sendJson(response, 404, {
          error: "queued FixLab job not found"
        });
        return;
      }
      const [cancelledJob] = queuedJobs.splice(queueIndex, 1);
      cancelledJob.status = "cancelled";
      cancelledJob.finishedAt = new Date().toISOString();
      cancelledJob.lastActivityAt = cancelledJob.finishedAt;
      cancelledJob.error = null;
      if (cancelledJob.artifactDirectory) {
        removeArtifactDirectory(cancelledJob.artifactDirectory);
        artifactDirectories.delete(cancelledJob.artifactDirectory);
        cancelledJob.artifactDirectory = null;
        cancelledJob.screenshots = [];
      }
      archiveJob(cancelledJob);
      recordJobMetric(cancelledJob);
      sendJson(response, 202, {
        job: publicJob(currentJob),
        cancelledJob: publicJob(cancelledJob),
        queue: publicQueue(queuedJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/jobs") {
      let shouldQueue =
        Boolean(activeHandle) ||
        ["running", "blocked", "failed"].includes(currentJob?.status) ||
        queuedJobs.length > 0;
      if (shouldQueue && queuedJobs.length >= MAX_QUEUED_JOBS) {
        sendJson(response, 409, {
          error: `the FixLab queue already contains ${MAX_QUEUED_JOBS} jobs`
        });
        return;
      }

      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request, 12 * 1024 * 1024);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      const requestText =
        typeof body.request === "string" ? body.request.trim() : "";
      if (!requestText || requestText.length > 10000) {
        sendJson(response, 400, {
          error: "request must be a non-empty string of at most 10000 characters"
        });
        return;
      }
      if (
        !["fix-and-validate", "validate-only", "playwright-only"].includes(
          body.mode
        )
      ) {
        sendJson(response, 400, {
          error:
            "mode must be fix-and-validate, validate-only, or playwright-only"
        });
        return;
      }
      const requestType = body.requestType ?? "bug-fix";
      if (!["bug-fix", "small-enhancement"].includes(requestType)) {
        sendJson(response, 400, {
          error: "requestType must be bug-fix or small-enhancement"
        });
        return;
      }
      const pullRequestStrategy = body.pullRequestStrategy ?? "common";
      if (!["common", "per-bug"].includes(pullRequestStrategy)) {
        sendJson(response, 400, {
          error: "pullRequestStrategy must be common or per-bug"
        });
        return;
      }
      const runAllUiScenarios = body.runAllUiScenarios ?? false;
      if (typeof runAllUiScenarios !== "boolean") {
        sendJson(response, 400, {
          error: "runAllUiScenarios must be a boolean"
        });
        return;
      }
      const recordPlaywrightVideo = body.recordPlaywrightVideo ?? false;
      if (typeof recordPlaywrightVideo !== "boolean") {
        sendJson(response, 400, {
          error: "recordPlaywrightVideo must be a boolean"
        });
        return;
      }
      const repositoryProfile = loadRepositoryProfile(resolvedRepository);
      const allowedEnvironments =
        configuredValidationEnvironments(repositoryProfile);
      let targetEnvironment;
      try {
        targetEnvironment = validateTargetEnvironment(
          body.targetEnvironment,
          allowedEnvironments
        );
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const environmentSettings = configuredEnvironmentSettings(
        repositoryProfile,
        targetEnvironment
      );
      const authenticationReadiness = environmentAuthenticationReadiness(
        repositoryProfile,
        resolvedRepository,
        targetEnvironment
      );
      if (!authenticationReadiness.ok) {
        sendJson(response, 409, {
          error: authenticationReadiness.detail
        });
        return;
      }
      const manualLocalhostTest =
        body.manualLocalhostTest ??
        body.holdForManualLiveTest ??
        false;
      if (typeof manualLocalhostTest !== "boolean") {
        sendJson(response, 400, {
          error: "manualLocalhostTest must be a boolean"
        });
        return;
      }
      const manualLocalhostUrl =
        repositoryProfile.applications?.frontend?.healthUrl ?? "";
      const testEvidence = configuredTestSynthesis(repositoryProfile);
      const configuredBranchNaming =
        repositoryProfile.pullRequests?.branchNaming ??
        repositoryProfile.pullRequest?.branchNaming;
      let branchNaming = null;
      if (configuredBranchNaming) {
        const userId =
          typeof configuredBranchNaming.userId === "string"
            ? configuredBranchNaming.userId.trim()
            : "";
        const prefixTemplate =
          typeof configuredBranchNaming.prefixTemplate === "string"
            ? configuredBranchNaming.prefixTemplate.trim()
            : "";
        if (!/^[A-Za-z0-9._-]+$/.test(userId)) {
          sendJson(response, 400, {
            error:
              "pullRequests.branchNaming.userId must contain only letters, numbers, dot, underscore, or hyphen"
          });
          return;
        }
        if (!prefixTemplate.includes("{userId}")) {
          sendJson(response, 400, {
            error:
              "pullRequests.branchNaming.prefixTemplate must contain {userId}"
          });
          return;
        }
        const prefix = prefixTemplate.replaceAll("{userId}", userId);
        if (
          prefix.startsWith("/") ||
          prefix.endsWith("/") ||
          prefix.includes("..") ||
          prefix.includes("\\") ||
          !/^[A-Za-z0-9._/-]+$/.test(prefix)
        ) {
          sendJson(response, 400, {
            error: "pullRequests.branchNaming resolves to an invalid Git prefix"
          });
          return;
        }
        branchNaming = { userId, prefixTemplate, prefix };
      }
      const intakeSource = body.intakeSource ?? "manual";
      if (!["manual", "azure-devops"].includes(intakeSource)) {
        sendJson(response, 400, {
          error: "intakeSource must be manual or azure-devops"
        });
        return;
      }
      let workItem = null;
      let workItems = [];
      try {
        if (intakeSource === "azure-devops") {
          const values = Array.isArray(body.workItems)
            ? body.workItems
            : body.workItem
              ? [body.workItem]
              : [];
          workItems = values.map(validateWorkItemSummary);
          if (workItems.length < 1 || workItems.length > 20) {
            throw new Error(
              "Azure DevOps intake requires between 1 and 20 loaded work items"
            );
          }
          const ids = workItems.map((item) => item.id);
          if (new Set(ids).size !== ids.length) {
            throw new Error("loaded Azure DevOps work items must be unique");
          }
          workItem = workItems.length === 1 ? workItems[0] : null;
        }
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      const readiness = inspectRepository(resolvedRepository);
      if (!readiness.repositoryReady || !readiness.profileReady) {
        sendJson(response, 400, { error: readiness.error, readiness });
        return;
      }

      shouldQueue =
        Boolean(activeHandle) ||
        Boolean(browserHandle) ||
        ["running", "blocked", "failed"].includes(currentJob?.status) ||
        queuedJobs.length > 0;
      if (shouldQueue && queuedJobs.length >= MAX_QUEUED_JOBS) {
        sendJson(response, 409, {
          error: `the FixLab queue already contains ${MAX_QUEUED_JOBS} jobs`
        });
        return;
      }
      if (!shouldQueue && currentJob?.artifactDirectory) {
        removeArtifactDirectory(currentJob.artifactDirectory);
        artifactDirectories.delete(currentJob.artifactDirectory);
      }
      if (!shouldQueue) {
        archiveJob(currentJob);
      }
      const jobId = randomUUID();
      let storedScreenshots;
      try {
        storedScreenshots = storeScreenshots({
          repository: resolvedRepository,
          jobId,
          screenshots: body.screenshots ?? []
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (storedScreenshots.directory) {
        artifactDirectories.add(storedScreenshots.directory);
      }

      const job = {
        id: jobId,
        createdAt: new Date().toISOString(),
        request: requestText,
        requestType,
        pullRequestStrategy,
        runAllUiScenarios,
        targetEnvironment,
        environmentSettings,
        recordPlaywrightVideo,
        manualLocalhostTest,
        manualLocalhostUrl,
        manualLocalhostOpenedAt: null,
        manualLocalhostOpening: false,
        manualLocalhostPending: false,
        manualLocalhostResult: null,
        testEvidence,
        branchNaming,
        intakeSource,
        workItem,
        workItems,
        screenshots: storedScreenshots.files,
        artifactDirectory: storedScreenshots.directory,
        mode: body.mode,
        status: shouldQueue ? "queued" : "running",
        startedAt: shouldQueue ? null : new Date().toISOString(),
        finishedAt: null,
        lastActivityAt: shouldQueue ? null : new Date().toISOString(),
        error: null,
        inputs: [],
        pendingInputs: [],
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          cacheReusePercent: 0
        },
        stages: Object.fromEntries(
          FIXLAB_STAGES.map((stage) => [
            stage,
            { status: "pending", message: "" }
          ])
        ),
        bugs: extractBugResults(requestText, workItems),
        activity: [],
        logs: [],
        droppedLogs: 0,
        nextLogIndex: 0,
        cacheContext: createCacheContext(resolvedRepository),
        partial: { stdout: "", stderr: "" }
      };
      job.initialPrompt = buildJobPrompt({
        request: requestText,
        mode: body.mode,
        requestType,
        pullRequestStrategy,
        runAllUiScenarios,
        targetEnvironment,
        recordPlaywrightVideo,
        manualLocalhostTest,
        manualLocalhostUrl,
        testEvidence,
        authenticatedTest: configuredAuthenticatedTest(repositoryProfile),
        preflightRecovery: configuredPreflightRecovery(repositoryProfile),
        branchNaming,
        intakeSource,
        workItem,
        workItems,
        screenshotPaths: storedScreenshots.files.map((file) => file.path),
        cacheSummary: loadCacheSummary(job.cacheContext)
      });
      job.pendingPrompt = job.initialPrompt;
      recordJobMetric(job);

      if (shouldQueue) {
        queuedJobs.push(job);
      } else {
        currentJob = job;
        try {
          startJob(currentJob, currentJob.pendingPrompt);
          delete currentJob.pendingPrompt;
        } catch (error) {
          finishJob(currentJob, { code: null, error });
          recordJobMetric(currentJob);
          activeHandle = null;
        }
      }

      sendJson(response, 202, {
        job: publicJob(currentJob),
        queued: shouldQueue,
        queuedJob: shouldQueue ? publicQueue([job])[0] : null,
        queue: publicQueue(queuedJobs)
      });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/playwright/status"
    ) {
      sendJson(
        response,
        200,
        playwrightAuthenticationStatus(
          resolvedRepository,
          playwrightConnection
        )
      );
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/playwright/run"
    ) {
      try {
        const plan = browserRunPlan();
        sendJson(response, 200, {
          plan: {
            jobId: plan.jobId,
            command: plan.command,
            workingDirectory: plan.workingDirectory,
            environment: plan.environment,
            policy: plan.policy,
            timeoutMs: plan.timeoutMs,
            approvalId: plan.approvalId
          }
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      ["/api/playwright/run", "/api/playwright/run/stop"].includes(requestUrl.pathname)
    ) {
      let body;
      try {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (!currentJob || body.jobId !== currentJob.id) {
        sendJson(response, 404, { error: "Select the current FixLab job." });
        return;
      }
      if (requestUrl.pathname.endsWith("/stop")) {
        if (!browserHandle) {
          sendJson(response, 409, { error: "No owned Playwright run is active." });
          return;
        }
        browserHandle.terminate();
        sendJson(response, 202, { job: publicJob(currentJob) });
        return;
      }
      if (activeHandle || browserHandle || playwrightConnection.handle) {
        sendJson(response, 409, { error: "An owned agent or browser process is already active." });
        return;
      }
      let plan;
      try {
        plan = browserRunPlan();
        if (body.approved !== true || body.approvalId !== plan.approvalId) {
          throw new Error("Review and explicitly approve the current Playwright plan.");
        }
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const job = currentJob;
      let commandOutput;
      try {
        commandOutput = createStructuredOutput({
          repository: job.cacheContext ? resolvedRepository : null,
          command: plan.command,
          cwd: plan.workingDirectory,
          stage: "live-test",
          tool: "Playwright"
        });
      } catch (error) {
        sendJson(response, 500, {
          error: `Could not prepare compact command evidence: ${safeSummary(error.message)}`
        });
        return;
      }
      const startedAt = new Date().toISOString();
      job.browserRunAttempts = (job.browserRunAttempts ?? 0) + 1;
      job.browserRun = {
        id: randomUUID(),
        status: "running",
        phase: "preflight",
        command: plan.command,
        workingDirectory: plan.workingDirectory,
        environment: plan.environment,
        timeoutMs: plan.timeoutMs,
        startedAt,
        finishedAt: null,
        lastActivityAt: startedAt,
        currentStep: "",
        message: "Approved; starting browser preflight."
      };
      const partial = { stdout: "", stderr: "" };
      const oversized = { stdout: false, stderr: false };
      let captureError = null;
      const logLine = (stream, text) => {
        if (text.startsWith("FIXLAB_BROWSER_FAILURE|")) {
          try {
            const failure = JSON.parse(text.slice("FIXLAB_BROWSER_FAILURE|".length));
            const kinds = ["assertion-timeout", "browser-launch", "action-timeout", "test-failure"];
            if (!kinds.includes(failure.kind) ||
                (failure.file !== null && !/^[\w.-]{1,160}$/u.test(failure.file)) ||
                (failure.line !== null && (!Number.isSafeInteger(failure.line) || failure.line < 1)) ||
                (failure.timeoutMs !== null && (!Number.isSafeInteger(failure.timeoutMs) || failure.timeoutMs < 1))) {
              throw new Error("Invalid browser failure metadata.");
            }
            job.browserRun.failure = Object.fromEntries(
              ["kind", "file", "line", "timeoutMs"].map((key) => [key, failure[key]])
            );
            const location = failure.file ? ` at ${failure.file}:${failure.line ?? "?"}` : "";
            const duration = failure.timeoutMs ? ` (${failure.timeoutMs / 1000}s wait)` : "";
            logLine("stderr", `Browser error: ${failure.kind}${location}${duration}; inspect the local report for the exact assertion.`);
          } catch {
            pushLog(job, {
              index: job.nextLogIndex, timestamp: new Date().toISOString(),
              stream: "dashboard", message: "Ignored invalid browser failure metadata."
            });
          }
          return;
        }
        if (text.startsWith("FIXLAB_BROWSER_RESULT|")) {
          try {
            const counts = JSON.parse(text.slice("FIXLAB_BROWSER_RESULT|".length));
            if (["total", "passed", "failed", "skipped"].every((key) =>
              Number.isSafeInteger(counts[key]) && counts[key] >= 0) &&
                counts.passed + counts.failed + counts.skipped === counts.total) {
              job.browserRun.testCounts = Object.fromEntries(
                ["total", "passed", "failed", "skipped"].map((key) => [key, counts[key]])
              );
            } else {
              throw new Error("Invalid Playwright result counts.");
            }
          } catch {
            pushLog(job, {
              index: job.nextLogIndex, timestamp: new Date().toISOString(),
              stream: "dashboard", message: "Ignored an invalid Playwright result summary."
            });
          }
          return;
        }
        const redacted = sanitize(text)
          .replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "")
          .replace(/https?:\/\/\S+/giu, "[omitted URL]");
        if (!captureError) {
          try {
            commandOutput.write(stream, `${redacted}\n`);
          } catch (error) {
            captureError = error;
            pushLog(job, {
              index: job.nextLogIndex,
              timestamp: new Date().toISOString(),
              stream: "dashboard",
              message: `Compact command evidence capture failed: ${safeSummary(error.message)}`
            });
          }
        }
        const message = redacted.slice(0, 1000);
        if (!message.trim()) {
          return;
        }
        const timestamp = new Date().toISOString();
        job.browserRun.lastActivityAt = timestamp;
        job.browserRun.currentStep = message;
        pushLog(job, { index: job.nextLogIndex, timestamp, stream: `playwright-${stream}`, message });
      };
      const output = (stream, text) => {
        for (const segment of String(text).split(/(\n)/u)) {
          if (segment === "\n") {
            logLine(stream, oversized[stream] ? "[Oversized output line omitted]" : partial[stream]);
            partial[stream] = "";
            oversized[stream] = false;
          } else if (!oversized[stream]) {
            partial[stream] += segment;
            if (partial[stream].length > 16 * 1024) {
              partial[stream] = "";
              oversized[stream] = true;
            }
          }
        }
      };
      const finish = (result) => {
        for (const stream of ["stdout", "stderr"]) {
          if (partial[stream] || oversized[stream]) {
            logLine(stream, oversized[stream] ? "[Oversized output line omitted]" : partial[stream]);
          }
        }
        Object.assign(job.browserRun, result, { finishedAt: new Date().toISOString() });
        if (result.status === "passed" && job.browserRun.testCounts) {
          if (job.browserRun.testCounts.failed > 0) {
            job.browserRun.status = "failed";
            result.message = "Playwright reported failing tests; inspect the local report.";
          } else if (job.browserRun.testCounts.passed === 0) {
            job.browserRun.status = "skipped";
            result.message = "No browser tests passed; this run does not satisfy the browser gate.";
          }
        }
        job.browserRun.message = safeSummary(result.message);
        if (job.browserRun.status === "passed") {
          delete job.browserRun.failure;
        }
        try {
          if (captureError) {
            throw captureError;
          }
          const compact = commandOutput.finish({
            status: job.browserRun.status === "passed" ? 0 : (result.code || 1),
            outcome: job.browserRun.status,
            testCounts: job.browserRun.testCounts
          });
          job.browserRun.commandSummary = compact.summary;
          job.browserRun.context = compact.context;
          job.browserRun.evidenceId = compact.evidenceId;
          pushLog(job, {
            index: job.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message: compact.summary
          });
        } catch (error) {
          const message = `Could not retain compact command evidence: ${safeSummary(error.message)}`;
          job.browserRun.status = "failed";
          job.browserRun.message = message;
          pushLog(job, {
            index: job.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message
          });
        }
        persistDashboardState();
      };
      const heartbeat = setInterval(() => {
        persistDashboardState();
      }, 30_000);
      heartbeat.unref?.();
      try {
        browserHandle = playwrightExecutor({
          command: plan.command,
          workingDirectory: plan.absoluteWorkingDirectory,
          configuration: plan.configuration,
          environment: plan.executionEnvironment,
          timeoutMs: plan.timeoutMs,
          onOutput: output,
          onPhase(phase, message) {
            job.browserRun.phase = phase;
            job.browserRun.message = message;
            persistDashboardState();
          }
        });
        const ownedHandle = browserHandle;
        Promise.resolve(ownedHandle.completion)
          .then(finish)
          .catch((error) => finish({
            status: "failed", message: safeSummary(error.message), code: null
          }))
          .finally(() => {
            clearInterval(heartbeat);
            if (browserHandle === ownedHandle) {
              browserHandle = null;
            }
            startNextJob();
          });
      } catch (error) {
        clearInterval(heartbeat);
        browserHandle = null;
        finish({ status: "failed", message: safeSummary(error.message), code: null });
      }
      persistDashboardState();
      sendJson(response, 202, { job: publicJob(job) });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/playwright/artifacts"
    ) {
      const jobId = requestUrl.searchParams.get("jobId");
      const job = [
        currentJob,
        ...queuedJobs,
        ...completedJobs
      ].find((entry) => entry?.id === jobId);
      if (!jobId || !job) {
        sendJson(response, 404, {
          error: "FixLab job not found for Playwright evidence"
        });
        return;
      }
      let artifacts;
      try {
        artifacts = listPlaywrightArtifacts(resolvedRepository, {
          since: job.browserRun?.startedAt ?? job.startedAt ?? job.createdAt
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      playwrightArtifacts.clear();
      for (const artifact of artifacts) {
        playwrightArtifacts.set(artifact.id, artifact);
      }
      sendJson(response, 200, {
        artifacts: artifacts.map(
          ({ id, name, relativePath, bytes, updatedAt, kind, mimeType }) => ({
            id,
            name,
            relativePath,
            bytes,
            updatedAt,
            kind,
            mimeType,
            url: `/api/playwright/artifacts/${id}`
          })
        )
      });
      return;
    }

    const artifactMatch = requestUrl.pathname.match(
      /^\/api\/playwright\/artifacts\/([a-f0-9]{24})$/
    );
    if (request.method === "GET" && artifactMatch) {
      const artifact = playwrightArtifacts.get(artifactMatch[1]);
      if (!artifact || !existsSync(artifact.path)) {
        sendJson(response, 404, { error: "Playwright artifact not found" });
        return;
      }
      const range = artifact.kind === "video"
        ? request.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
        : null;
      if (range) {
        const requestedStart = range[1] ? Number(range[1]) : 0;
        const requestedEnd = range[2]
          ? Number(range[2])
          : artifact.bytes - 1;
        const start = Math.max(0, requestedStart);
        const end = Math.min(artifact.bytes - 1, requestedEnd);
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= artifact.bytes
        ) {
          response.writeHead(416, {
            "Content-Range": `bytes */${artifact.bytes}`,
            "Cache-Control": "no-store"
          });
          response.end();
          return;
        }
        response.writeHead(206, {
          "Content-Type": artifact.mimeType,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${artifact.bytes}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        createReadStream(artifact.path, { start, end }).pipe(response);
        return;
      }
      response.writeHead(200, {
        "Content-Type": artifact.mimeType,
        "Content-Length": artifact.bytes,
        "Accept-Ranges": artifact.kind === "video" ? "bytes" : "none",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      createReadStream(artifact.path).pipe(response);
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/playwright/connect"
    ) {
      if (playwrightConnection.handle) {
        sendJson(response, 409, {
          error: "Playwright authentication is already running"
        });
        return;
      }
      if (browserHandle) {
        sendJson(response, 409, { error: "Stop or finish the owned Playwright run before authenticating." });
        return;
      }
      let configuration;
      try {
        configuration = playwrightAuthenticationConfig(resolvedRepository);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (!configuration.command || configuration.statusPaths.length === 0) {
        sendJson(response, 400, {
          error:
            "repository profile must configure browserAutomation.authentication.command and statusPaths"
        });
        return;
      }
      if (!existsSync(configuration.workingDirectory)) {
        sendJson(response, 400, {
          error: "configured Playwright working directory does not exist"
        });
        return;
      }
      playwrightConnection.lastResult = null;
      const child = spawn(configuration.command, {
        cwd: configuration.workingDirectory,
        env: { ...process.env, ...configuration.environment },
        shell: true,
        stdio: "ignore",
        windowsHide: false
      });
      playwrightConnection.handle = child;
      child.once("error", (error) => {
        playwrightConnection.lastResult = {
          ok: false,
          message: error.message,
          finishedAt: new Date().toISOString()
        };
        playwrightConnection.handle = null;
      });
      child.once("close", (code, signal) => {
        playwrightConnection.lastResult = {
          ok: code === 0,
          message:
            code === 0
              ? "Playwright authentication completed."
              : `Playwright authentication exited with code ${code ?? "unknown"}${
                  signal ? ` (${signal})` : ""
                }.`,
          finishedAt: new Date().toISOString()
        };
        playwrightConnection.handle = null;
      });
      sendJson(response, 202, {
        ...playwrightAuthenticationStatus(
          resolvedRepository,
          playwrightConnection
        ),
        started: true
      });
      return;
    }

    if (request.method === "GET" && staticFiles.has(requestUrl.pathname)) {
      const fileName = staticFiles.get(requestUrl.pathname);
      const filePath = join(publicDirectory, fileName);
      if (!existsSync(filePath)) {
        sendJson(response, 404, { error: "dashboard asset not found" });
        return;
      }
      response.writeHead(200, {
        "Content-Type":
          contentTypes[extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
      });
      createReadStream(filePath).pipe(response);
      return;
    }

    sendJson(response, 404, { error: "not found" });
  });

  return {
    server,
    async listen({ port = DEFAULT_DASHBOARD_PORT } = {}) {
      const validatedPort = validatePort(port);
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(validatedPort, DASHBOARD_HOST, resolveListen);
      });
      const address = server.address();
      return {
        host: DASHBOARD_HOST,
        port: address.port,
        url: `http://${DASHBOARD_HOST}:${address.port}`
      };
    },
    async close() {
      if (browserHandle) {
        browserHandle.terminate();
        await browserHandle.completion;
      }
      persistDashboardState();
      if (activeHandle?.terminate) {
        activeHandle.terminate();
      }
      if (
        playwrightConnection.handle &&
        playwrightConnection.handle.exitCode === null &&
        playwrightConnection.handle.signalCode === null
      ) {
        playwrightConnection.handle.kill();
      }
      for (const directory of artifactDirectories) {
        removeArtifactDirectory(directory);
      }
      artifactDirectories.clear();
      server.closeIdleConnections?.();
      await new Promise((resolveClose, reject) => {
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    }
  };
}
