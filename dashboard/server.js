import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
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
  parse,
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
import { formatPreflightFailure } from "./preflight.js";
import { createSessionRegistry } from "./sessions.js";
import { createExecutorLease } from "./executor-lease.js";
import { spawnWindowsExecutor } from "./windows-executor.js";
import { browserConfigurationErrors } from "./repository-setup.js";
import { prepareSharedWorktree, sharedWorktreeConfig, sharedWorktreeGuidance, verifySharedWorktreeBranch } from "./shared-worktree.js";
const windowsOwnedTrees = new WeakMap();
import { ValidationSession, validationGates } from "./validation-gates.js";
import { repositoryState } from "../bin/structured-command.js";

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
export const HYDRAFUSION_MODEL = "hydrafusion";

export function validateCopilotModel(value, runtime = "copilot") {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new Error("model must be a string");
  }
  const model = String(value ?? "").trim();
  if (!model) {
    return "";
  }
  if (runtime !== "copilot") {
    throw new Error("model selection requires the copilot runtime");
  }
  if (model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(model)) {
    throw new Error("model must be 1-128 letters, numbers, dots, underscores, slashes, or hyphens");
  }
  return model.toLowerCase() === HYDRAFUSION_MODEL ? HYDRAFUSION_MODEL : model;
}

export function copilotModelArguments(model) {
  const selectedModel = validateCopilotModel(model);
  return selectedModel
    ? [...(selectedModel === HYDRAFUSION_MODEL ? ["--experimental"] : []), "--model", selectedModel]
    : [];
}
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
  if (repository) {
    missing.push(...browserConfigurationErrors(profile, repository));
  }
  try {
    validationGates(profile ?? {}, "validate-only");
  } catch (error) {
    missing.push(error.message);
  }
  const frontend = profile?.applications?.frontend;
  const browserAutomation = profile?.browserAutomation;
  const authentication = browserAutomation?.authentication;
  const dataSafety = browserAutomation?.dataSafety;
  const testSynthesis = browserAutomation?.testSynthesis;
  const agentIdleTimeoutMinutes =
    profile?.validation?.agentIdleTimeoutMinutes;
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
    model: job.model,
    runtime: job.runtime,
    pullRequestStrategy: job.pullRequestStrategy,
    runAllUiScenarios: job.runAllUiScenarios,
    targetEnvironment: job.targetEnvironment,
    sharedWorkspace: job.sharedWorkspace ?? null,
    prestartFrontend: job.prestartFrontend ?? false,
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
    validation: job.validationSession?.summary() ?? null,
    pullRequestReadiness: getPullRequestReadiness(job),
    createdAt: job.createdAt
  }));
}

function publicHeld(jobs) {
  return jobs.map((job) => ({
    ...publicJob(job),
    activity: [],
    logs: []
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
    model: job.model,
    runtime: job.runtime,
    pullRequestStrategy: job.pullRequestStrategy,
    runAllUiScenarios: job.runAllUiScenarios,
    targetEnvironment: job.targetEnvironment,
    prestartFrontend: job.prestartFrontend ?? false,
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
    branchNaming: job.branchNaming ?? null,
    sharedWorkspace: job.sharedWorkspace ?? null,
    intakeSource: job.intakeSource,
    workItem: persistedWorkItem(job.workItem),
    workItems: job.workItems.map(persistedWorkItem),
    mode: job.mode,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    heldAt: job.heldAt ?? null,
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
    model: snapshot.model ?? "",
    runtime: snapshot.runtime ?? (snapshot.model ? "copilot" : ""),
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
  restored.heldAt = snapshot.heldAt ?? null;
  restored.holdRequested = false;
  restored.resumeSession = false;
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
    recordPlaywrightVideo: restored.recordPlaywrightVideo,
    manualLocalhostTest: restored.manualLocalhostTest,
    manualLocalhostUrl: restored.manualLocalhostUrl,
    testEvidence: restored.testEvidence,
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
  if (snapshot?.status === "holding") {
    return {
      ...snapshot,
      status: "held",
      heldAt: snapshot.heldAt ?? recoveredAt,
      finishedAt: null,
      error: null
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
  const validation = job.validationSession?.summary() ?? {
    status: "unconfigured",
    message: "Executor-backed validation is not available; resume with configured validation.gates."
  };
  if (validation && validation.status !== "passed") {
    return {
      status: "blocked",
      ready: false,
      message: validation.status === "unconfigured"
        ? validation.message
        : "Required executor-backed validation is pending, failed, or stale."
    };
  }
  if (job.status === "running") {
    return {
      status: "blocked",
      ready: false,
      message: "Waiting for job completion and final source verification."
    };
  }
  if (prStage.status === "passed") {
    return {
      status: "created",
      ready: false,
      message: prStage.message || "Pull request created or updated."
    };
  }
  const fixedBugs = (job.bugs ?? []).filter((bug) => bug.outcome === "fixed");
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
    sharedWorktreeConfig(profile, resolvedRepository);
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
  recordPlaywrightVideo = false,
  manualLocalhostTest = false,
  manualLocalhostUrl = "",
  testEvidence = {
    enabled: true,
    source: "profile-defined",
    mutationMode: "profile-defined",
    requireScenarioEvidence: true
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
- After one bug's scoped fix and smallest focused regression pass, remove transient validation artifacts, self-review its diff, and create or update its authorized draft PR before running remaining independent validation. Keep that PR draft until every required local gate for that bug reaches an accepted outcome, then publish it without waiting for remote CI. Never combine unrelated bug changes in one PR.`
      : `- Treat all selected bugs as one common-PR batch. Diagnose and implement every required fix, then run the smallest focused regression checks that protect the combined change.
- After those focused checks pass, remove transient validation artifacts, self-review the combined diff, and create or update one authorized draft PR. Continue shared tests, builds, application startup, and browser scenarios while that draft is open.`;
  const uiScenarioGuidance = runAllUiScenarios
    ? `- After implementation and non-browser validation are complete, run every repository-defined Playwright/UI scenario at the end, not only the focused defect journey.
- Start the required applications once when safe, preserve each scenario result, and attach non-sensitive screenshot evidence for the complete UI run.`
    : "- Run the smallest repository-defined Playwright journey that proves the selected behavior.";
  const environmentGuidance = targetEnvironment
    ? `- The user selected ${targetEnvironment} as the validation environment. Use exactly that repository-approved environment for profile-defined application startup and Playwright live testing.
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
  const manualLocalhostGuidance = manualLocalhostTest
    ? `- Manual React localhost validation is enabled independently of Playwright. After required automated validation finishes, start or reuse only the profile-defined frontend and wait for its health check at ${manualLocalhostUrl || "the profile-defined local health URL"}.
${process.platform === "win32" ? "- Windows executor children are job-contained and terminated when the agent exits. For a manual gate, use a dashboard-managed frontend outside the executor; the user can start it with Start React. Verify that it serves the validated checkout. If no independently managed server serves that checkout, block with that exact prerequisite instead of retaining an executor child or validating a baseline checkout.\n" : ""}- Dashboard-managed frontends remain under dashboard session controls; do not terminate them from the agent.
- Emit local-stack passed only after the React frontend is healthy. The dashboard will then open the localhost URL in the user's default browser.
- After every required automated browser gate is terminal, emit FIXLAB_MANUAL|localhost|pending immediately before live-test blocked. Keep the FixLab-owned frontend running and request that the user confirm Passed or Failed. Do not emit this marker for a Playwright, authentication, test-data, or other automated blocker.
- Do not run or rerun Playwright solely because this manual option is enabled.
- If an authorized draft PR already exists, keep it draft with the manual gate pending; otherwise emit pr skipped because manual confirmation is pending.
- When the dashboard resumes this session with the user's manual result, mark live-test passed or failed accordingly, stop only frontend processes owned by the current job (not a dashboard-managed server), and continue to the gated PR outcome.`
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
  return `FixLab output protocol (follow before any tool call):
- Your first assistant output must be this literal plain-text line:
  FIXLAB_STAGE|intake|running|Accepted the request and starting intake.
- Emit that line before reading files, searching, planning with tools, delegating, or running commands.
- Before beginning each later stage, emit FIXLAB_STAGE|stage|running|concise next action as a literal assistant response line.
- Emit a terminal passed, skipped, blocked, or failed marker for the current stage before starting the next stage.
- Never defer or batch stage markers until the end of the job.

Run a FixLab ${mode} job.
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
- Before validation in a new isolated worktree, plan \`fixlab onboard WORKTREE --from SOURCE --runtime RUNTIME\`. After scoped setup approval, add \`--yes\`. The source profile declares non-sensitive configuration in \`worktreeSetup.files\`. Never copy credentials or browser state. Missing configuration, authentication or denied runtime access is a blocker; do not retry unchanged approvals or grant blanket path access. Sign-in and MFA remain human-controlled. In read-only modes, do not provision or alter configuration; report missing prerequisites as blocked.
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
- Run verbose repository-owned tests, builds, linters, type checks, and package validation through \`fixlab exec --stage <stage> -- <command> [args...]\`. In Windows PowerShell quote the separator (\`'--'\`) because an unquoted \`--\` is dropped, and never wrap \`fixlab exec\` in \`cmd /c\`; that wrapper is denied in non-interactive sessions. Keep its compact result in context and inspect the private evidence path only when an exact diagnostic is needed.
- Add \`--reuse\` only for deterministic local validation when command, arguments, Git state, working directory, profile, and stage are unchanged. Never reuse startup, health, authentication, Playwright or live-environment validation, external-data checks, dependency installation, deployments, or mutating commands.
- Do not skip Playwright merely because an unrelated non-browser test, build, or backend startup is failed or blocked. If frontend startup, authentication, safe data, and the selected browser journey are independently ready, run the live-test gate and preserve the other blocker separately.
- Use local-stack only for profile-defined application startup and health. Do not mark local-stack failed because a separate test, type-check, lint, or production build reports unrelated baseline diagnostics; preserve that exact validation limitation separately and continue browser execution when startup is healthy.
- Before browser execution, synthesize the smallest focused Playwright scenario and measurable assertions from the reported behavior and expected outcome when an equivalent repository-owned scenario does not already exist.
- Treat a synthesized Playwright scenario as a transient validation artifact by default. Remove its source file and any validation-only configuration edits before diff review, commit, push, or pull-request creation.
- Do not add a newly generated authenticated test such as \`*.auth.spec.ts\` to the product change unless the user explicitly requests permanent browser-test coverage or repository instructions require that exact persisted test.
- Existing repository-owned Playwright tests may be changed only when the reported product behavior directly requires that regression update; do not broaden the pull request to repair unrelated or stale browser journeys.
${testDataGuidance}
- Once the scoped production change and its smallest focused regression checks pass, remove transient validation artifacts and self-review the effective diff. When pull-request publication is already authorized, commit and push that reviewed checkpoint and create or update a draft pull request before remaining independent validation completes.
- Start long-running independent validation commands in parallel when the runtime supports it. While those commands run, prepare or refresh the authorized draft PR description with the confirmed symptom, scoped change, checks already passed, checks still running, and known risks.
- Push later reviewed checkpoints to the same branch only after their affected focused checks pass. Reuse the same draft PR and update its evidence instead of waiting to publish one large final update or creating duplicates.
- Keep the pull request draft and clearly marked validation-in-progress while any required local validation or approval gate is pending, running, blocked, skipped with unaccepted risk, or failed. Never mark it ready for review or report the pr stage passed until all required local gates pass or repository policy records an explicitly accepted outcome.
- ${readOnly ? "Do not publish a pull request or change its draft status in read-only mode." : "After required local validation and approval gates pass or have an explicitly accepted outcome, publish the authorized PR by marking it ready for review. Do not wait for remote PR CI or build completion before publication; publication can trigger those checks. Verify the PR is no longer draft before reporting the PR stage passed. Report remote checks as pending, not passed, and leave merge policies intact. Use `gh pr ready <number>` for GitHub or `az repos pr update --id <id> --draft false` for Azure DevOps, then read back `isDraft` from the provider to confirm it is false. If publication or state verification fails, report the PR stage blocked or failed, not passed."}
- Prefix FixLab-created pull-request titles with FLAB: followed by a concise description of the coding change. Format the body with the repository's PR template, clear Markdown sections for the problem, changes, validation and risks, and accurate validation checkboxes.
- Emit one browser evidence line after the scenario is selected and again if the actual source or mutation behavior changes:
  FIXLAB_TEST|source|mutation-mode|scenario
- source must be one of: ${[...testDataSources].join(", ")}.
- mutation-mode must be one of: ${[...mutationModes].join(", ")}.
- Start only the applications defined by the repository profile, then execute the repository-defined live test against the allowed required system or environment from that profile. Do not invent or hardcode environment choices.
- For every Playwright live test, save at least one non-sensitive screenshot under the test's repository-owned test-results directory so the dashboard can display the browser evidence.
- ${playwrightOnly ? "Collect evidence for required setup, authentication readiness, application startup, the focused Playwright result, skipped gates, blockers, and remaining risks." : "Collect evidence for diagnosis or surface inspection, the effective diff, review, local validation, application startup, live testing, skipped gates, and remaining risks."}
- ${readOnly ? "Report the pull-request outcome without creating or updating a pull request." : "Create or update an authorized draft pull request after the reviewed focused checkpoint; finalize its evidence and publish it after required local validation and approval gates pass, without waiting for remote CI."}
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
  return {
    period,
    queued: selected.length,
    completed: completed.length,
    passed: completed.filter((record) => record.status === "passed").length,
    failed: completed.filter((record) => record.status === "failed").length,
    blocked: completed.filter((record) => record.status === "blocked").length,
    cancelled: completed.filter((record) => record.status === "cancelled").length,
    bugs: selected.reduce((total, record) => total + record.bugCount, 0),
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
    const state = repositoryState(repository);
    const stateHash = hash(JSON.stringify(state));
    const instructionHash = state.instructionHash;
    return {
      key: hash(`${repositoryIdentity}\0${head}\0${profileHash}\0${stateHash}\0${instructionHash}`),
      repository,
      repositoryIdentityHash: hash(repositoryIdentity),
      head,
      profileHash,
      instructionHash,
      stateHash,
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
  if (!entry || Date.now() - Date.parse(entry.updatedAt) > 7 * 24 * 60 * 60 * 1000 ||
      !Number.isFinite(Date.parse(entry.updatedAt))) {
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
    context = createCacheContext(job.validationSession?.target ?? context.repository);
    if (!context) {
      throw new Error("Current repository inputs could not be fingerprinted.");
    }
    const cache = readCache(context.cachePath);
    const entry = {
      key: context.key,
      repositoryIdentityHash: context.repositoryIdentityHash,
      head: context.head,
      profileHash: context.profileHash,
      instructionHash: context.instructionHash,
      stateHash: context.stateHash,
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
              summary: `${stage}: ${job.stages[stage].status}`
            }
          ])
        ),
        validation: job.validationSession?.summary().gates.map(
          ({ id, status }) => ({ id, status })
        ) ?? []
      }
    };
    cache.entries = [
      entry,
      ...cache.entries.filter((candidate) =>
        candidate.key !== context.key &&
        Date.parse(candidate.updatedAt) >= Date.now() - 7 * 24 * 60 * 60 * 1000
      )
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
    job.memoryWarning = "Repository memory could not be updated; current execution evidence remains authoritative.";
    pushActivity(job, {
      timestamp: new Date().toISOString(),
      stage: "review",
      message: job.memoryWarning
    });
  }
}

// Linked dependency folders (for example a node_modules junction) resolve outside
// the repository, and non-interactive agents cannot answer the path prompt they raise.
// Discovery is only for a reviewed setup plan; runtime callers use the default,
// which grants only targets inside profile-declared trustedDependencyRoots.
export function linkedDependencyDirectories(repository, { discover = false } = {}) {
  let root;
  let profile;
  try {
    root = realpathSync(repository);
    profile = loadRepositoryProfile(root);
  } catch {
    return [];
  }

  const trustedRoots = (
    Array.isArray(profile?.trustedDependencyRoots)
      ? profile.trustedDependencyRoots
      : []
  )
    .filter((value) => typeof value === "string" && isAbsolute(value))
    .flatMap((value) => {
      try {
        const resolved = realpathSync(value);
        return resolved === parse(resolved).root ? [] : [resolved];
      } catch {
        return [];
      }
    });
  if (trustedRoots.length === 0 && !discover) {
    return [];
  }

  const isInside = (parent, child) => {
    const relation = relative(parent, child);
    return (
      relation === "" ||
      (!relation.startsWith("..") && !isAbsolute(relation))
    );
  };
  const workingDirectories = new Set([root]);
  for (const configured of [
    profile.browserAutomation?.workingDirectory,
    ...Object.values(profile.applications ?? {}).map(
      (application) => application?.workingDirectory
    )
  ]) {
    if (typeof configured !== "string") {
      continue;
    }
    try {
      const directory = realpathSync(resolve(root, configured));
      if (isInside(root, directory)) {
        workingDirectories.add(directory);
      }
    } catch {
      // A missing working directory has no dependency link to grant.
    }
  }

  const found = new Set();
  for (const directory of workingDirectories) {
    const candidate = join(directory, "node_modules");
    try {
      if (!lstatSync(candidate).isSymbolicLink()) {
        continue;
      }
      const target = realpathSync(candidate);
      if (
        !isInside(root, target) &&
        target !== parse(target).root &&
        (discover || trustedRoots.some((trusted) => isInside(trusted, target)))
      ) {
        found.add(target);
      }
    } catch {
      // Missing or unreadable dependency folders need no extra access.
    }
  }
  return [...found];
}

const additionalDirectoryArguments = (additionalDirs) =>
  additionalDirs.flatMap((directory) => ["--add-dir", directory]);

export function buildAgencyInvocation({
  packageRoot,
  prompt,
  sessionId,
  resume = false,
  additionalDirs = []
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
      ...additionalDirectoryArguments(additionalDirs),
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
  resume = false,
  additionalDirs = [],
  model = ""
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
      ...copilotModelArguments(model),
      "--allow-all-tools",
      ...additionalDirectoryArguments(additionalDirs),
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
    { encoding: "utf8", shell: false, windowsHide: true }
  );
  const candidates = lookup.stdout
    ?.split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  return process.platform === "win32"
    ? candidates?.find((value) => /\.exe$/i.test(value))
    : candidates?.[0];
}

function createExecutor({ command, packageRoot, buildInvocation, defaultModel = "" }) {
  return ({
    repository,
    artifactDirectories = [],
    prompt,
    sessionId,
    resume,
    model,
    onOutput
  }) => {
    const executable = findDirectExecutable(command);
    if (!executable) {
      const error = new Error(
        `${command} executable is unavailable or is not a directly executable binary`
      );
      error.executorNotStarted = true;
      throw error;
    }
    let invocation;
    try {
      invocation = buildInvocation({
        packageRoot,
        prompt,
        sessionId,
        resume,
        model: model ?? defaultModel,
        additionalDirs: [
          ...linkedDependencyDirectories(repository),
          ...artifactDirectories
        ]
      });
    } catch (error) {
      error.executorNotStarted = true;
      throw error;
    }
    const containment = process.platform === "win32"
      ? spawnWindowsExecutor({ executable, args: invocation.args, repository })
      : null;
    const child = containment?.child ?? spawn(executable, invocation.args, {
      cwd: repository,
      env: { ...process.env, BROWSER: "none" },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => onOutput("stdout", chunk.toString()));
    child.stderr.on("data", (chunk) => onOutput("stderr", chunk.toString()));
    child.stdin.on("error", (error) =>
      onOutput("stderr", `Could not send the FixLab prompt: ${error.message}\n`)
    );
    child.stdin.end(invocation.input);

    const completion = createProcessCompletion(child, onOutput).then(async (result) => {
      if (!containment && child.pid) {
        stopProcessTree(child);
        const started = Date.now();
        while (ownedTreeRunning(child)) {
          if (Date.now() - started >= 5000) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") {
                throw error;
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return result;
    });

    return {
      pid: child.pid,
      completion,
      hasStopped() {
        if (containment) {
          return containment.hasStopped();
        }
        if (!child.pid) {
          return true;
        }
        if (child.exitCode === null && child.signalCode === null) {
          return false;
        }
        if (process.platform !== "win32") {
          try {
            process.kill(-child.pid, 0);
            return false;
          } catch (error) {
            if (error.code !== "ESRCH") {
              throw error;
            }
          }
        }
        return true;
      },
      terminate() {
        if (containment) {
          containment.terminate();
          return;
        }
        stopProcessTree(child);
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

export function createCopilotExecutor({ packageRoot, model = "" }) {
  const selectedModel = validateCopilotModel(model);
  return createExecutor({
    command: "copilot",
    packageRoot,
    buildInvocation: buildCopilotInvocation,
    defaultModel: selectedModel
  });
}

export function createRuntimeExecutor({ packageRoot, runtime = "agency", model = "" }) {
  if (!FIXLAB_RUNTIMES.includes(runtime)) {
    throw new Error(
      `FixLab runtime must be one of: ${FIXLAB_RUNTIMES.join(", ")}`
    );
  }
  const selectedModel = validateCopilotModel(model, runtime);
  return runtime === "copilot"
    ? createCopilotExecutor({ packageRoot, model: selectedModel })
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
    model: job.model,
    runtime: job.runtime,
    pullRequestStrategy: job.pullRequestStrategy,
    runAllUiScenarios: job.runAllUiScenarios,
    targetEnvironment: job.targetEnvironment,
    sharedWorkspace: job.sharedWorkspace ?? null,
    recordPlaywrightVideo: job.recordPlaywrightVideo,
    manualLocalhostTest: job.manualLocalhostTest,
    manualLocalhostUrl: job.manualLocalhostUrl,
    manualLocalhostOpenedAt: job.manualLocalhostOpenedAt,
    manualLocalhostPending: job.manualLocalhostPending,
    manualLocalhostResult: job.manualLocalhostResult,
    testEvidence: job.testEvidence,
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
      !job.resumeDisabled &&
      !job.executorStopping &&
      ["blocked", "failed", "passed", "held"].includes(job.status),
    canComment: job.status === "running",
    inputCount: job.inputs.length,
    pendingInputCount: job.pendingInputs.length,
    durationMs: Math.max(
      0,
      job.startedAt
        ? Date.parse(
            job.finishedAt ?? job.heldAt ?? new Date().toISOString()
          ) -
            Date.parse(job.startedAt)
        : 0
    ),
    usage: job.usage,
    stages: job.stages,
    validation: job.validationSession?.summary() ?? null,
    memoryWarning: job.memoryWarning ?? null,
    pullRequestReadiness: getPullRequestReadiness(job),
    bugs: job.bugs,
    activity: job.activity,
    logs: job.logs,
    droppedLogs: job.droppedLogs
  };
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
    for (const segment of splitRenderedMarkers(line)) {
      appendLine(job, stream, segment);
    }
  }
}

function splitRenderedMarkers(line) {
  if (!/^FIXLAB_(?:STAGE|ACTIVITY|BUG|TEST)(?:\||\s)/u.test(line)) {
    return [line];
  }
  return line
    .split(/(?=FIXLAB_(?:STAGE|ACTIVITY|BUG|TEST)(?:\||\s))/u)
    .filter(Boolean);
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
  flushPartialOutput(job);

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
  if (job.validationSession) {
    try {
      const validation = job.validationSession.verify();
      if (validation.status !== "passed" && validation.status !== "unconfigured") {
        job.stages.review = {
          status: "blocked",
          message: "Required executor-backed validation is missing, failed, or stale."
        };
      }
    } catch (error) {
      job.stages.review = { status: "blocked", message: error.message };
      job.validationSession.error = "Could not verify current validation inputs.";
    }
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

function flushPartialOutput(job) {
  for (const stream of ["stdout", "stderr"]) {
    if (job.partial[stream]) {
      for (const segment of splitRenderedMarkers(job.partial[stream])) {
        appendLine(job, stream, segment);
      }
      job.partial[stream] = "";
    }
  }
}

function holdJob(job) {
  flushPartialOutput(job);
  const activeStage =
    FIXLAB_STAGES.find((stage) => job.stages[stage].status === "running") ??
    FIXLAB_STAGES.find((stage) => !terminalStatuses.has(job.stages[stage].status));
  if (activeStage) {
    job.stages[activeStage] = {
      status: "blocked",
      message: "Held by the user; resume continues from this stage."
    };
  }
  job.status = "held";
  job.heldAt = new Date().toISOString();
  job.lastActivityAt = job.heldAt;
  job.finishedAt = null;
  job.error = null;
  job.holdRequested = false;
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
    statusPaths,
    workingDirectory
  };
}

function frontendStartConfig(repository) {
  const profile = loadRepositoryProfile(repository);
  const frontend = profile.applications?.frontend ?? {};
  const command =
    typeof frontend.command === "string" ? frontend.command.trim() : "";
  if (!command) {
    throw new Error("repository profile must configure applications.frontend.command");
  }
  return {
    command,
    healthUrl: validatedManualLocalhostUrl(frontend.healthUrl),
    workingDirectory: resolveContainedPath(
      repository,
      frontend.workingDirectory ?? ".",
      "applications.frontend.workingDirectory",
      { mustExist: true }
    )
  };
}

async function frontendIsHealthy(healthUrl) {
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(2000)
    });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}

function ownedTreeRunning(child) {
  if (!child?.pid) {
    return false;
  }
  const containment = windowsOwnedTrees.get(child);
  if (containment) {
    return !containment.hasStopped();
  }
  if (child.exitCode === null && child.signalCode === null) {
    return true;
  }
  if (process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
    return false;
  }
}

function spawnOwnedShell(configuration, retainDescendants = false) {
  if (process.platform === "win32") {
    const executable = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    const containment = spawnWindowsExecutor({
      executable,
      args: [],
      commandLine: `"${executable}" /d /s /c "${configuration.command}"`,
      repository: configuration.workingDirectory,
      environment: configuration.environment,
      retainDescendants
    });
    windowsOwnedTrees.set(containment.child, containment);
    // Dev servers can interpret EOF as shutdown; keep their input alive.
    if (!retainDescendants) {
      containment.child.stdin.end();
    }
    containment.child.stdin.on("error", (error) => {
      containment.child.emit("fixlab-input-error", error);
    });
    containment.child.stdout.resume();
    containment.child.stderr.resume();
    return containment.child;
  }
  const child = spawn(configuration.command, {
    cwd: configuration.workingDirectory,
    env: { ...process.env, ...configuration.environment, BROWSER: "none" },
    shell: true,
    detached: true,
    stdio: retainDescendants ? ["pipe", "ignore", "ignore"] : "ignore"
  });
  child.stdin?.on("error", (error) => {
    child.emit("fixlab-input-error", error);
  });
  return child;
}

function stopProcessTree(child) {
  if (!child?.pid) {
    return;
  }
  const containment = windowsOwnedTrees.get(child);
  if (containment) {
    containment.terminate();
    return containment.waitForStopped();
  }
  if (process.platform === "win32" && child.pid) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(`could not stop the owned process tree (exit ${result.status})`);
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function frontendStatus(repository, connection) {
  let healthUrl = "";
  try {
    ({ healthUrl } = frontendStartConfig(repository));
  } catch (error) {
    return {
      configured: false,
      running: Boolean(connection.handle) || connection.starting === true,
      healthy: false,
      owned: Boolean(connection.handle) || connection.starting === true,
      error: error.message,
      lastResult: connection.lastResult
    };
  }
  return {
    configured: true,
    running: Boolean(connection.handle) || connection.starting === true,
    healthy: await frontendIsHealthy(healthUrl),
    owned: Boolean(connection.handle) || connection.starting === true,
    healthUrl,
    error: "",
    lastResult: connection.lastResult
  };
}

function playwrightAuthenticationStatus(repository, connection) {
  let configuration;
  try {
    configuration = playwrightAuthenticationConfig(repository);
  } catch (error) {
    return {
      configured: false,
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
    ready:
      Boolean(configuration.command) &&
      paths.length > 0 &&
      paths.every((entry) => entry.ready),
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
      : job.status === "held"
        ? Math.max(
            0,
            FIXLAB_STAGES.findIndex((stage) =>
              ["blocked", "failed", "running", "pending"].includes(
                job.stages[stage].status
              )
            )
          )
      : Math.max(
          0,
          FIXLAB_STAGES.findIndex((stage) =>
            ["blocked", "failed", "running"].includes(
              job.stages[stage].status
            )
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
  job.heldAt = null;
  job.finishedAt = null;
  job.error = null;
  job.partial = { stdout: "", stderr: "" };
}

export function createDashboardServer({
  repository,
  packageRoot,
  runtime = "agency",
  model = "",
  publicDirectory = join(packageRoot, "dashboard", "public"),
  executor = createRuntimeExecutor({ packageRoot, runtime, model }),
  workItemLoader = createAzureDevOpsLoader(),
  browserOpener = openLocalUrl,
  preflight = null,
  executionIdleTimeoutMs,
  executionHeartbeatMs = DEFAULT_EXECUTION_HEARTBEAT_MS
}) {
  const resolvedRepository = resolve(repository);
  const defaultModel = validateCopilotModel(model, runtime);
  let currentJob = null;
  let activeHandle = null;
  let activeTermination = null;
  const queuedJobs = [];
  const heldJobs = [];
  const completedJobs = [];
  const artifactDirectories = new Set();
  const playwrightConnection = { handle: null, lastResult: null };
  const frontendConnection = { handle: null, lastResult: null, starting: false };
  let frontendStartGeneration = 0;
  const playwrightArtifacts = new Map();
  const cacheContext = createCacheContext(resolvedRepository);
  const sessions = createSessionRegistry(
    cacheContext?.repositoryIdentityHash ?? resolvedRepository
  );
  const executorLease = createExecutorLease(resolvedRepository, sessions.id);
  let dashboardUrl = "";
  let closing = false;

  async function launchFrontend() {
    const generation = frontendStartGeneration;
    const configuration = frontendStartConfig(resolvedRepository);
    if (frontendConnection.handle || frontendConnection.starting) {
      throw new Error("FixLab already started the frontend");
    }
    frontendConnection.starting = true;
    try {
      const owners = await sessions.list();
      const conflict = owners.find((owner) =>
        owner.id !== sessions.id && owner.available && owner.frontend?.running
      );
      if (conflict) {
        throw new Error(`Frontend is owned by FixLab dashboard ${conflict.id}; reconnect or confirm stopping that owner.`);
      }
      if (closing || generation !== frontendStartGeneration) {
        throw new Error("frontend startup was cancelled");
      }
      if (await frontendIsHealthy(configuration.healthUrl)) {
        return { started: false };
      }
      if (closing || generation !== frontendStartGeneration) {
        throw new Error("frontend startup was cancelled");
      }
      frontendConnection.lastResult = null;
      const child = spawnOwnedShell(configuration, true);
      frontendConnection.handle = child;
      child.once("fixlab-input-error", (error) => {
        frontendConnection.lastResult = {
          ok: false,
          message: `Frontend input failed: ${error.message}`,
          finishedAt: new Date().toISOString()
        };
      });
      child.once("error", (error) => {
        frontendConnection.lastResult = {
          ok: false,
          message: error.message,
          finishedAt: new Date().toISOString()
        };
        if (frontendConnection.handle === child) {
          frontendConnection.handle = null;
        }
      });
      child.once("close", (code) => {
        if (frontendConnection.handle === child) {
          try {
            if (ownedTreeRunning(child)) {
              if (process.platform === "win32") {
                frontendConnection.lastResult = {
                  ok: false,
                  message: "Frontend termination is unverified; ownership is retained.",
                  finishedAt: new Date().toISOString()
                };
              }
              return;
            }
          } catch (error) {
            frontendConnection.lastResult = {
              ok: false,
              message: `Frontend termination is unverified: ${error.message}`,
              finishedAt: new Date().toISOString()
            };
            return;
          }
          frontendConnection.handle = null;
          frontendConnection.lastResult = {
            ok: code === 0,
            message: `Frontend process exited with code ${code ?? "unknown"}.`,
            finishedAt: new Date().toISOString()
          };
        }
      });
      return { started: true };
    } finally {
      frontendConnection.starting = false;
    }
  }

  async function prewarmFrontend(job) {
    try {
      const result = frontendConnection.handle || frontendConnection.starting
        ? { started: false }
        : await launchFrontend();
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: result.started
          ? "React warm-up started in parallel with the agent. Live testing must wait for health and verify the server serves the validated checkout."
          : "React warm-up reuses the existing frontend; live testing must verify its health and checkout."
      });
    } catch (error) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `React warm-up did not start: ${error.message}. The agent must report any live-test prerequisite that remains blocked.`
      });
    }
  }
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
  for (const snapshot of persistedJobs.filter((job) => job.status === "held")) {
    heldJobs.push(restoreDashboardJob(snapshot, resolvedRepository));
  }
  persistedJobs = persistedJobs.filter((job) => job.status !== "held");
  const resumableSnapshot = persistedJobs.find((job) =>
    ["blocked", "failed", "passed"].includes(job.status) &&
    (job.runtime ?? (job.model ? "copilot" : "")) === runtime
  );
  if (resumableSnapshot) {
    currentJob = restoreDashboardJob(
      resumableSnapshot,
      resolvedRepository
    );
    if (currentJob.runtime !== runtime) {
      currentJob.resumeDisabled = true;
    }
    persistedJobs = persistedJobs.filter(
      (job) => job.id !== resumableSnapshot.id
    );
  }

  function dashboardHistory() {
    const liveIds = new Set([
      currentJob?.id,
      ...queuedJobs.map((job) => job.id),
      ...heldJobs.map((job) => job.id),
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
      ...heldJobs.map(dashboardSnapshot),
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

  function retireCurrentJob() {
    if (!currentJob) {
      return;
    }
    if (currentJob.artifactDirectory) {
      removeArtifactDirectory(currentJob.artifactDirectory);
      artifactDirectories.delete(currentJob.artifactDirectory);
    }
    archiveJob(currentJob);
    currentJob = null;
  }

  function retainedJob(jobId) {
    return [
      currentJob,
      ...queuedJobs,
      ...heldJobs,
      ...completedJobs,
      ...persistedJobs
    ].find((job) => job?.id === jobId);
  }

  function createRestartedJob(source, status) {
    const sourceJob = source.screenshots
      ? source
      : restoreDashboardJob(source, resolvedRepository);
    const createdAt = new Date().toISOString();
    const snapshot = {
      ...dashboardSnapshot(sourceJob),
      id: randomUUID(),
      status,
      createdAt,
      startedAt: status === "running" ? createdAt : null,
      heldAt: null,
      sharedWorkspace: null,
      finishedAt: null,
      lastActivityAt: status === "running" ? createdAt : null,
      error: null,
      manualLocalhostOpenedAt: null,
      manualLocalhostPending: false,
      manualLocalhostResult: null,
      testEvidence: configuredTestSynthesis(
        loadRepositoryProfile(resolvedRepository)
      ),
      stages: Object.fromEntries(
        FIXLAB_STAGES.map((stage) => [
          stage,
          { status: "pending", message: "" }
        ])
      ),
      bugs: (sourceJob.bugs ?? []).map((bug) => ({
        id: bug.id,
        outcome: "pending",
        owner: "",
        summary: ""
      }))
    };
    const restarted = restoreDashboardJob(snapshot, resolvedRepository);
    restarted.pendingPrompt = restarted.initialPrompt;
    return restarted;
  }

  function moveHeldJob(job) {
    holdJob(job);
    if (!heldJobs.some((candidate) => candidate.id === job.id)) {
      heldJobs.unshift(job);
    }
    recordJobMetric(job);
  }

  function purgeableJob(job, cutoff) {
    if (!["passed", "failed", "blocked", "cancelled"].includes(job.status)) {
      return false;
    }
    const timestamp = Date.parse(
      job.finishedAt ?? job.lastActivityAt ?? job.createdAt
    );
    return Number.isFinite(timestamp) && timestamp < cutoff;
  }

  function startJob(job, prompt, resume = false) {
    if (job.runtime !== runtime) {
      throw new Error("Saved job runtime does not match this dashboard; reconnect using its originating runtime.");
    }
    validateCopilotModel(job.model, runtime);
    if (closing) {
      throw new Error("the dashboard is shutting down");
    }
    job.validationSession ??= new ValidationSession(
      resolvedRepository,
      loadRepositoryProfile(resolvedRepository),
      job.mode
    );
    const validation = job.validationSession.summary();
    job.acceptsValidation = true;
    const address = server.address();
    if (validation.status !== "unconfigured" && validation.gates.length > 0) {
      prompt += `\nDashboard-owned required validation:
- Run each gate against your final isolated worktree using:
  node "${join(packageRoot, "bin", "fixlab.js")}" gate --port ${address.port} --job ${job.id} --gate <id> --repository <worktree-path>
- Required gate IDs: ${validation.gates.map((gate) => gate.id).join(", ")}.
- These operations return compact structured evidence. Do not run the same required commands separately.
- Run required gates before reporting readiness. Stage markers cannot pass these gates.
- Rerun affected gates after source edits. Matching job-local evidence is reused only when the profile opts in for deterministic local validation and inputs are unchanged.
- Unconfigured or stale validation cannot establish pull-request readiness. Never mark a pull request ready outside these checks.`;
    }
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
    let leaseMetadataError = null;
    let handle;
    const lease = executorLease.acquire(job.id);
    try {
      if (job.mode === "fix-and-validate") {
        job.sharedWorkspace = prepareSharedWorktree({
          repository: resolvedRepository,
          profile: loadRepositoryProfile(resolvedRepository),
          jobId: job.id,
          saved: job.sharedWorkspace,
          resume,
          resourcesRunning: Boolean(frontendConnection.handle) ||
            frontendConnection.starting || Boolean(playwrightConnection.handle)
        });
        if (job.sharedWorkspace) {
          persistDashboardState();
          const readiness = inspectRepository(resolvedRepository);
          if (!readiness.profileReady) {
            throw new Error(`Shared checkout configuration is not ready after branch acquisition: ${readiness.error}`);
          }
          pushLog(job, {
            index: job.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message: `Acquired shared checkout on ${job.sharedWorkspace.branch}; base ${job.sharedWorkspace.remote}/${job.sharedWorkspace.baseBranch} at ${job.sharedWorkspace.baseCommit}.`
          });
        }
      }
    } catch (error) {
      lease.release();
      throw error;
    }
    const idleCompletion = new Promise((resolveCompletion) => {
      resolveIdleCompletion = resolveCompletion;
    });
    const armIdleWatchdog = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const error = new Error(
          `FixLab agent produced no output for ${Math.round(
            idleTimeoutMs / 60000
          )} minute(s); termination was requested and resume remains blocked until the owned executor exits.`
        );
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: error.message
        });
        resolveIdleCompletion({ code: null, error });
        job.executorStopping = true;
        try {
          lease.update("stopping");
        } catch (metadataError) {
          pushLog(job, {
            index: job.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message: `Could not update the idle executor lease: ${metadataError.message}. Still requesting owned termination.`
          });
        }
        try {
          job.validationSession?.cancel();
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
    try {
      handle = executor({
        repository: resolvedRepository,
        artifactDirectories: job.artifactDirectory ? [job.artifactDirectory] : [],
        prompt: (job.prestartFrontend && job.targetEnvironment.toLowerCase() === "local"
          ? `${prompt}\nReact warm-up is requested in parallel in the dashboard repository. Before live testing, reuse that server only after its profile health check passes and you verify it serves the checkout containing the changes being validated. If using another isolated worktree, start the correct checkout instead; a healthy baseline server does not prove the fix. Never mark local-stack passed merely because warm-up was requested.`
          : prompt) + sharedWorktreeGuidance(job.sharedWorkspace),
        sessionId: job.id,
        resume,
        model: job.model,
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
    } catch (error) {
      clearTimeout(idleTimer);
      if (error.executorNotStarted === true) {
        lease.release();
      }
      throw error;
    }
    activeHandle = handle;
    job.executorStopping = false;
    if (!handle?.completion || typeof handle.completion.then !== "function") {
      throw new Error("Executor did not provide a termination promise; the repository lease remains reserved.");
    }
    const actualCompletion = Promise.resolve(handle.completion).then(async (result) => {
      job.acceptsValidation = false;
      await job.validationCompletion;
      if (handle.hasStopped && !handle.hasStopped()) {
        throw new Error("Executor exit was observed but owned descendants may still be running; the repository lease remains reserved.");
      }
      let branchError = null;
      try {
        verifySharedWorktreeBranch(resolvedRepository, job.sharedWorkspace);
      } catch (error) {
        branchError = error;
      }
      lease.release();
      return leaseMetadataError || branchError
        ? { code: null, error: leaseMetadataError ?? branchError }
        : result;
    });
    activeTermination = actualCompletion;
    try {
      lease.update("running", handle.pid);
    } catch (error) {
      leaseMetadataError = error;
      job.executorStopping = true;
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `Executor lease metadata could not be updated: ${error.message}. The reservation is retained while the owned executor stops.`
      });
      resolveIdleCompletion({ code: null, error });
      try {
        handle.terminate?.();
      } catch (terminationError) {
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: `Could not stop the executor after its lease metadata failed: ${terminationError.message}. The reservation remains until termination is verified.`
        });
      }
    }
    if (job.prestartFrontend && job.targetEnvironment.toLowerCase() === "local") {
      void prewarmFrontend(job);
    }
    armIdleWatchdog();
    heartbeatTimer = setInterval(emitHeartbeat, executionHeartbeatMs);
    heartbeatTimer.unref?.();
    Promise.race([actualCompletion, idleCompletion])
      .then(async (result) => {
        await job.validationCompletion;
        if (job.holdRequested) {
          holdJob(job);
        } else if (closing && job.status === "running" && !job.stopRequested) {
          const recovered = recoverInterruptedDashboardJob(dashboardSnapshot(job));
          job.status = recovered.status;
          job.stages = recovered.stages;
          job.error = recovered.error;
          job.finishedAt = recovered.finishedAt;
        } else {
          finishJob(job, result);
        }
        if (job.stopRequested) {
          job.status = "blocked";
          job.error = "Session stopped by the user; resume when ready.";
          delete job.stopRequested;
        }
        recordJobMetric(job);
      })
      .catch((error) => {
        if (job.holdRequested) {
          holdJob(job);
        } else {
          finishJob(job, { code: null, error });
        }
        if (job.stopRequested) {
          job.status = "blocked";
          job.error = "Session stopped by the user; resume when ready.";
          delete job.stopRequested;
        }
        recordJobMetric(job);
      })
      .finally(async () => {
        clearTimeout(idleTimer);
        clearInterval(heartbeatTimer);
        try {
          await actualCompletion;
        } catch (error) {
          job.executorStopping = true;
          pushLog(job, {
            index: job.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message: `Executor termination or lease release is unverified; retaining the repository lease: ${error.message}`
          });
          recordJobMetric(job);
          return;
        }
        job.executorStopping = false;
        if (activeHandle === handle) {
          activeHandle = null;
          activeTermination = null;
        }
        recordJobMetric(job);
        if (closing) {
          return;
        }
        if (job.status === "held") {
          if (currentJob?.id === job.id) {
            currentJob = null;
          }
          if (!heldJobs.some((candidate) => candidate.id === job.id)) {
            heldJobs.unshift(job);
          }
          persistDashboardState();
          startNextJob();
          return;
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
        return startNextJob();
      });
  }

  async function startNextJob() {
    if (
      activeHandle ||
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
    currentJob.startedAt ??= new Date().toISOString();
    currentJob.lastActivityAt = new Date().toISOString();
    recordJobMetric(currentJob);
    try {
      const owners = await sessions.list();
      const conflict = owners.find((owner) =>
        owner.id !== sessions.id && owner.available && (
          owner.job?.running ||
          (loadRepositoryProfile(resolvedRepository).worktreeSetup?.mode === "shared" &&
            (owner.frontend?.running || owner.authentication?.running))
        )
      );
      if (conflict) {
        throw new Error(`Queued job cannot start while FixLab dashboard ${conflict.id} owns the repository's agent session. Reconnect or confirm stopping that owner.`);
      }
      startJob(
        currentJob,
        currentJob.pendingPrompt,
        Boolean(currentJob.resumeSession)
      );
      delete currentJob.pendingPrompt;
      delete currentJob.resumeSession;
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

    if (closing && request.method === "POST") {
      sendJson(response, 503, { error: "the dashboard is shutting down" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/session") {
      sendJson(response, 200, {
        id: sessions.id,
        scopeId: sessions.scopeId,
        repository: resolvedRepository,
        job: currentJob ? {
          id: currentJob.id,
          status: currentJob.status,
          running: Boolean(activeHandle),
          canResume: publicJob(currentJob).canResume
        } : null,
        frontend: {
          running: Boolean(frontendConnection.handle) || frontendConnection.starting,
          pid: frontendConnection.handle?.pid ?? null
        },
        authentication: { running: Boolean(playwrightConnection.handle) }
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/sessions") {
      try {
        sendJson(response, 200, {
          ownerId: sessions.id,
          sessions: await sessions.list()
        });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      ["/api/sessions/control", "/api/session/control"].includes(requestUrl.pathname)
    ) {
      try {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          throw new Error("Content-Type must be application/json");
        }
        const body = await readJsonBody(request);
        if (
          !["stop", "resume", "shutdown"].includes(body.action) ||
          !["job", "frontend", "all"].includes(body.resource) ||
          typeof body.ownerId !== "string"
        ) {
          throw new Error("a session owner, action and resource are required");
        }
        if (body.action !== "resume" && body.confirmed !== true) {
          sendJson(response, 409, { error: "explicit confirmation is required" });
          return;
        }
        if (requestUrl.pathname === "/api/sessions/control") {
          const result = await sessions.control(body.ownerId, body);
          sendJson(response, result.status, result.body);
          return;
        }
        if (body.ownerId !== sessions.id) {
          sendJson(response, 409, { error: "the session owner has changed" });
          return;
        }
        if (
          ["job", "all"].includes(body.resource) &&
          body.jobId !== (currentJob?.id ?? null)
        ) {
          sendJson(response, 409, { error: "the owned job has changed; refresh before continuing" });
          return;
        }
        if (body.action === "resume" && body.resource === "all") {
          throw new Error("resume a job or frontend individually");
        }
        const cleanupFailures = [];
        if (body.action === "shutdown") {
          if (body.resource !== "all") {
            throw new Error("shutdown requires resource all");
          }
          try {
            await stopProcessTree(playwrightConnection.handle);
            playwrightConnection.handle = null;
          } catch (error) {
            cleanupFailures.push(error.message);
          }
        }
        const paths = body.resource === "all"
          ? ["/api/frontend/stop", ...(activeHandle ? ["/api/job/stop"] : [])]
          : body.resource === "frontend"
            ? [body.action === "resume" ? "/api/frontend/start" : "/api/frontend/stop"]
            : body.action === "resume" && activeHandle
              ? []
              : [body.action === "resume" ? "/api/job/input" : "/api/job/stop"];
        for (const path of paths) {
          try {
            const result = await fetch(`${dashboardUrl}${path}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "continue",
                details: "Resume the stopped FixLab session using its saved context and existing evidence."
              }),
              signal: AbortSignal.timeout(10000),
              redirect: "error"
            });
            const resultBody = await result.json();
            if (!result.ok) {
              if (body.resource !== "all") {
                sendJson(response, result.status, resultBody);
                return;
              }
              cleanupFailures.push(resultBody.error ?? `Owned cleanup failed with HTTP ${result.status}`);
            }
          } catch (error) {
            if (body.resource !== "all") {
              throw error;
            }
            cleanupFailures.push(`Owned cleanup ${path} failed: ${error.message}`);
          }
        }
        if (cleanupFailures.length) {
          sendJson(response, 500, { error: cleanupFailures.join("; ") });
          return;
        }
        sendJson(response, 202, { accepted: true, ownerId: sessions.id });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      ["/api/jobs", "/api/job/input", "/api/jobs/resume", "/api/jobs/restart", "/api/frontend/start"].includes(requestUrl.pathname)
    ) {
      try {
        const resource = requestUrl.pathname === "/api/frontend/start" ? "frontend" : "job";
        const owners = await sessions.list();
        const shared = loadRepositoryProfile(resolvedRepository).worktreeSetup?.mode === "shared";
        const conflict = owners.find((owner) =>
          owner.id !== sessions.id && owner.available && (
            owner[resource]?.running ||
            (shared && resource === "job" && (owner.frontend?.running || owner.authentication?.running))
          )
        );
        if (conflict) {
          sendJson(response, 409, {
            error: `Another FixLab dashboard owns the ${resource} session. Reconnect to its dashboard or confirm stopping it in Session controls.`,
            owner: conflict
          });
          return;
        }
      } catch (error) {
        sendJson(response, 503, { error: `Could not verify session ownership: ${error.message}` });
        return;
      }
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/status") {
      persistDashboardState();
      sendJson(response, 200, {
        readiness: inspectRepository(resolvedRepository),
        runtime: {
          name: runtime,
          defaultModel,
          supportsModelSelection: runtime === "copilot"
        },
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
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
        held: publicHeld(heldJobs),
        history: dashboardHistory(),
        historyWarning: dashboardHistoryWarning
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/validation/run") {
      try {
        const expectedHost = `${DASHBOARD_HOST}:${server.address().port}`;
        if (
          request.headers.host !== expectedHost ||
          request.headers.origin ||
          !request.headers["content-type"]?.startsWith("application/json")
        ) {
          throw new Error("Validation requires a local JSON client without a browser Origin.");
        }
        const body = await readJsonBody(request);
        const job = currentJob;
        if (!job || job.status !== "running" || !job.acceptsValidation || body.jobId !== job.id) {
          throw new Error("Validation requires the current running job ID.");
        }
        if (typeof body.gateId !== "string" || typeof body.repository !== "string") {
          throw new Error("gateId and repository are required.");
        }
        if (job.validationSession.active) {
          throw new Error("A validation gate is already running.");
        }
        const cancel = () => {
          if (!response.writableFinished) {
            job.validationSession.cancel();
          }
        };
        response.once("close", cancel);
        const completion = job.validationSession.run(
          body.gateId,
          body.repository,
          loadRepositoryProfile(resolvedRepository)
        );
        job.validationCompletion = completion.catch(() => {});
        const result = await completion;
        response.removeListener("close", cancel);
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: result.summary
        });
        persistDashboardState();
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
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
      if (activeHandle) {
        sendJson(response, 409, {
          error: "the current FixLab agent is still running or shutting down"
        });
        return;
      }
      if (!["failed", "blocked"].includes(currentJob.status)) {
        sendJson(response, 409, {
          error: "only a failed or blocked FixLab job can be dismissed"
        });
        return;
      }

      const dismissedJob = currentJob;
      pushLog(dismissedJob, {
        index: dismissedJob.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `${dismissedJob.status === "blocked" ? "Blocked" : "Failed"} job dismissed by the user; its ${dismissedJob.status} outcome remains in dashboard history.`
      });
      if (dismissedJob.artifactDirectory) {
        removeArtifactDirectory(dismissedJob.artifactDirectory);
        artifactDirectories.delete(dismissedJob.artifactDirectory);
      }
      archiveJob(dismissedJob);
      currentJob = null;
      await startNextJob();
      persistDashboardState();
      sendJson(response, 202, {
        job: publicJob(currentJob),
        dismissedJob: publicJob(dismissedJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/job/input"
    ) {
      if (!currentJob) {
        sendJson(response, 404, { error: "no FixLab job is available" });
        return;
      }
      if (currentJob.resumeDisabled) {
        sendJson(response, 409, {
          error: currentJob.runtime !== runtime
            ? "Saved job runtime is incompatible or unknown; reconnect using its originating runtime or start a new job."
            : "this FixLab job cannot be resumed safely"
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
      if (
        !running &&
        !manualResult &&
        action !== "skip" &&
        currentJob.stages["live-test"].status === "blocked" &&
        playwrightConnection.handle
      ) {
        sendJson(response, 409, {
          error: "Authentication is still running and owns the repository browser profile. Finish sign-in and close its browser window before resuming the blocked live test."
        });
        return;
      }
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
      const defaultDetails =
        action === "continue"
          ? "Resume the same FixLab session from its retained workflow state and continue the remaining required stages."
          : "";
      const details = manualResult
        ? `The user completed manual React localhost validation and explicitly marked it ${
            action === "manual-pass" ? "passed" : "failed"
          }. Record the live-test stage as ${
            action === "manual-pass" ? "passed" : "failed"
          }, stop only frontend processes owned by the current job (not a dashboard-managed server), preserve this manual result in the job evidence, and continue the remaining gated outcome without rerunning Playwright.`
        : submittedDetails || defaultDetails;
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
        details,
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
          queue: publicQueue(queuedJobs),
          held: publicHeld(heldJobs)
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
        : buildResumePrompt(currentJob, { action, details });
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
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs)
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/job/stop"
    ) {
      if (
        !currentJob ||
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
          "Stop requested by the user; stopping only the owned executor process tree."
      });
      try {
        currentJob.executorStopping = true;
        currentJob.validationSession?.cancel();
        activeHandle.terminate();
        currentJob.pendingInputs = [];
        currentJob.stopRequested = true;
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
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/jobs/hold"
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
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const jobId =
        typeof body.jobId === "string" ? body.jobId.trim() : "";
      if (!jobId) {
        sendJson(response, 400, { error: "jobId must be a non-empty string" });
        return;
      }
      if (heldJobs.some((job) => job.id === jobId)) {
        sendJson(response, 409, { error: "FixLab job is already held" });
        return;
      }
      if (currentJob?.id === jobId) {
        if (currentJob.status === "running" && activeHandle?.terminate) {
          currentJob.holdRequested = true;
          currentJob.status = "holding";
          pushLog(currentJob, {
            index: currentJob.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message:
              "Hold requested; stopping only this job's FixLab-owned executor."
          });
          try {
            currentJob.validationSession?.cancel();
            activeHandle.terminate();
          } catch (error) {
            currentJob.holdRequested = false;
            currentJob.status = "running";
            sendJson(response, 500, {
              error: `could not hold the FixLab-owned executor: ${error.message}`
            });
            return;
          }
          persistDashboardState();
          sendJson(response, 202, {
            job: publicJob(currentJob),
            holding: true,
            queue: publicQueue(queuedJobs),
            held: publicHeld(heldJobs)
          });
          return;
        }
        if (!["blocked", "failed"].includes(currentJob.status)) {
          sendJson(response, 409, {
            error: "only running, blocked, failed, or queued jobs can be held"
          });
          return;
        }
        const heldJob = currentJob;
        currentJob = null;
        moveHeldJob(heldJob);
        startNextJob();
        sendJson(response, 202, {
          job: publicJob(currentJob),
          heldJob: publicJob(heldJob),
          queue: publicQueue(queuedJobs),
          held: publicHeld(heldJobs),
          history: dashboardHistory()
        });
        return;
      }
      const queueIndex = queuedJobs.findIndex((job) => job.id === jobId);
      if (queueIndex < 0) {
        sendJson(response, 404, { error: "active or queued FixLab job not found" });
        return;
      }
      const [heldJob] = queuedJobs.splice(queueIndex, 1);
      moveHeldJob(heldJob);
      sendJson(response, 202, {
        job: publicJob(currentJob),
        heldJob: publicJob(heldJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/jobs/resume"
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
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const jobId =
        typeof body.jobId === "string" ? body.jobId.trim() : "";
      const heldIndex = heldJobs.findIndex((job) => job.id === jobId);
      if (heldIndex < 0) {
        sendJson(response, 404, { error: "held FixLab job not found" });
        return;
      }
      if (queuedJobs.length >= MAX_QUEUED_JOBS) {
        sendJson(response, 409, {
          error: `the FixLab queue already contains ${MAX_QUEUED_JOBS} jobs`
        });
        return;
      }
      const [job] = heldJobs.splice(heldIndex, 1);
      const resumeSession = Boolean(job.startedAt);
      const pendingDetails = job.pendingInputs
        .splice(0)
        .map((input) => input.details)
        .join("\n\n");
      const prompt = resumeSession
        ? buildResumePrompt(job, {
            action: "continue",
            details:
              pendingDetails ||
              "Resume this held job from its retained workflow stage."
          })
        : job.pendingPrompt ?? job.initialPrompt;
      resetJobForResume(job);
      const shouldQueue =
        Boolean(activeHandle) ||
        Boolean(currentJob && currentJob.status !== "passed") ||
        queuedJobs.length > 0;
      if (!shouldQueue) {
        retireCurrentJob();
        currentJob = job;
        currentJob.startedAt ??= new Date().toISOString();
        currentJob.lastActivityAt = new Date().toISOString();
        recordJobMetric(currentJob);
        try {
          startJob(currentJob, prompt, resumeSession);
        } catch (error) {
          finishJob(currentJob, { code: null, error });
          recordJobMetric(currentJob);
          activeHandle = null;
        }
      } else {
        job.status = "queued";
        job.pendingPrompt = prompt;
        job.resumeSession = resumeSession;
        queuedJobs.push(job);
        recordJobMetric(job);
      }
      sendJson(response, 202, {
        job: publicJob(currentJob),
        resumedJob: shouldQueue ? publicQueue([job])[0] : publicJob(job),
        queued: shouldQueue,
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/jobs/restart"
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
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const jobId =
        typeof body.jobId === "string" ? body.jobId.trim() : "";
      const source = retainedJob(jobId);
      if (!source) {
        sendJson(response, 404, { error: "retained FixLab job not found" });
        return;
      }
      if (!["passed", "failed", "blocked", "cancelled"].includes(source.status)) {
        sendJson(response, 409, {
          error: "only terminal FixLab jobs can be restarted"
        });
        return;
      }
      if (queuedJobs.length >= MAX_QUEUED_JOBS) {
        sendJson(response, 409, {
          error: `the FixLab queue already contains ${MAX_QUEUED_JOBS} jobs`
        });
        return;
      }
      if (currentJob?.id === source.id) {
        retireCurrentJob();
      }
      const shouldQueue =
        Boolean(activeHandle) ||
        Boolean(currentJob && currentJob.status !== "passed") ||
        queuedJobs.length > 0;
      if (!shouldQueue) {
        retireCurrentJob();
      }
      const restartedJob = createRestartedJob(
        source,
        shouldQueue ? "queued" : "running"
      );
      recordJobMetric(restartedJob);
      if (shouldQueue) {
        queuedJobs.push(restartedJob);
      } else {
        currentJob = restartedJob;
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
        restartedJob: shouldQueue
          ? publicQueue([restartedJob])[0]
          : publicJob(restartedJob),
        queued: shouldQueue,
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/history/purge"
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
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const olderThanDays = Number(body.olderThanDays);
      if (
        !Number.isInteger(olderThanDays) ||
        olderThanDays < 1 ||
        olderThanDays > 3650
      ) {
        sendJson(response, 400, {
          error: "olderThanDays must be an integer between 1 and 3650"
        });
        return;
      }
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      let deleted = 0;
      const deletedIds = new Set();
      if (!activeHandle && currentJob && purgeableJob(currentJob, cutoff)) {
        if (currentJob.artifactDirectory) {
          removeArtifactDirectory(currentJob.artifactDirectory);
          artifactDirectories.delete(currentJob.artifactDirectory);
        }
        deletedIds.add(currentJob.id);
        deleted += 1;
        currentJob = null;
        startNextJob();
      }
      for (let index = completedJobs.length - 1; index >= 0; index -= 1) {
        const job = completedJobs[index];
        if (!purgeableJob(job, cutoff)) {
          continue;
        }
        completedJobs.splice(index, 1);
        if (job.artifactDirectory) {
          removeArtifactDirectory(job.artifactDirectory);
          artifactDirectories.delete(job.artifactDirectory);
        }
        deletedIds.add(job.id);
        deleted += 1;
      }
      persistedJobs = persistedJobs.filter((job) => {
        if (deletedIds.has(job.id)) {
          return false;
        }
        if (!purgeableJob(job, cutoff)) {
          return true;
        }
        deletedIds.add(job.id);
        deleted += 1;
        return false;
      });
      persistDashboardState();
      sendJson(response, 200, {
        deleted,
        olderThanDays,
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
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
      let selectedModel;
      try {
        selectedModel = validateCopilotModel(body.model ?? defaultModel, runtime);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
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
      const prestartFrontend = body.prestartFrontend ?? false;
      if (typeof prestartFrontend !== "boolean") {
        sendJson(response, 400, { error: "prestartFrontend must be a boolean" });
        return;
      }
      const repositoryProfile = loadRepositoryProfile(resolvedRepository);
      const preflightIssues = preflight
        ? preflight({ repository: resolvedRepository, profile: repositoryProfile })
        : [];
      if (preflightIssues.length > 0) {
        sendJson(response, 400, {
          error: formatPreflightFailure(preflightIssues),
          preflight: preflightIssues
        });
        return;
      }
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
        model: selectedModel,
        runtime,
        pullRequestStrategy,
        runAllUiScenarios,
        targetEnvironment,
        prestartFrontend,
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
        heldAt: null,
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
      job.holdRequested = false;
      job.resumeSession = false;
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
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
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
          since: job.startedAt ?? job.createdAt
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
      const child = spawnOwnedShell(configuration);
      playwrightConnection.handle = child;
      child.once("fixlab-input-error", (error) => {
        playwrightConnection.lastResult = {
          ok: false,
          message: `Authentication input failed: ${error.message}`,
          finishedAt: new Date().toISOString()
        };
      });
      child.once("error", (error) => {
        playwrightConnection.lastResult = {
          ok: false,
          message: error.message,
          finishedAt: new Date().toISOString()
        };
        playwrightConnection.handle = null;
      });
      child.once("close", (code, signal) => {
        try {
          if (ownedTreeRunning(child)) {
            playwrightConnection.lastResult = {
              ok: false,
              message: "Authentication descendants remain owned; retry must wait for confirmed termination.",
              finishedAt: new Date().toISOString()
            };
            return;
          }
        } catch (error) {
          playwrightConnection.lastResult = {
            ok: false,
            message: `Authentication termination is unverified: ${error.message}`,
            finishedAt: new Date().toISOString()
          };
          return;
        }
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

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/frontend/status"
    ) {
      sendJson(
        response,
        200,
        await frontendStatus(resolvedRepository, frontendConnection)
      );
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/frontend/start"
    ) {
      if (frontendConnection.handle || frontendConnection.starting) {
        sendJson(response, 409, { error: "FixLab already started the frontend" });
        return;
      }
      try {
        const result = await launchFrontend();
        sendJson(response, result.started ? 202 : 200, {
          ...(await frontendStatus(resolvedRepository, frontendConnection)),
          ...result
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/frontend/stop"
    ) {
      const child = frontendConnection.handle;
      const wasStarting = frontendConnection.starting;
      frontendStartGeneration += 1;
      try {
        await stopProcessTree(child);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
        return;
      }
      frontendConnection.handle = null;
      sendJson(response, 200, {
        ...(await frontendStatus(resolvedRepository, frontendConnection)),
        stopped: Boolean(child) || wasStarting
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
      dashboardUrl = `http://${DASHBOARD_HOST}:${address.port}`;
      try {
        sessions.register(dashboardUrl);
      } catch (error) {
        await new Promise((resolveClose) => server.close(resolveClose));
        throw error;
      }
      return {
        host: DASHBOARD_HOST,
        port: address.port,
        url: `http://${DASHBOARD_HOST}:${address.port}`
      };
    },
    async close() {
      closing = true;
      currentJob?.validationSession?.cancel();
      frontendStartGeneration += 1;
      const failures = [];
      const attempt = async (action) => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };
      await attempt(() => persistDashboardState());
      await attempt(async () => {
        const handle = activeHandle;
        const termination = activeTermination;
        if (!handle) {
          return;
        }
        handle.terminate?.();
        if (!termination) {
          throw new Error("Executor termination cannot be verified; its reservation is retained.");
        }
        await termination;
      });
      await attempt(async () => {
        await stopProcessTree(playwrightConnection.handle);
        playwrightConnection.handle = null;
      });
      await attempt(async () => {
        await stopProcessTree(frontendConnection.handle);
        frontendConnection.handle = null;
      });
      for (const directory of artifactDirectories) {
        await attempt(() => removeArtifactDirectory(directory));
      }
      artifactDirectories.clear();
      await attempt(async () => {
        server.closeIdleConnections?.();
        await new Promise((resolveClose, reject) => {
          if (!server.listening) {
            resolveClose();
            return;
          }
          server.close((error) => (error ? reject(error) : resolveClose()));
        });
      });
      await attempt(() => sessions.unregister());
      if (failures.length) {
        throw new AggregateError(failures, "FixLab shutdown could not complete every owned cleanup step");
      }
    }
  };
}
