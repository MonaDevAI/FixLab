const stageNames = [
  "intake",
  "diagnosis",
  "reproduce",
  "fix",
  "review",
  "local-stack",
  "live-test",
  "pr"
];

const form = document.querySelector("#job-form");
const startButton = document.querySelector("#start-button");
const formError = document.querySelector("#form-error");
const readinessElement = document.querySelector("#readiness");
const modelControl = document.querySelector("#model-control");
const modelSelect = document.querySelector("#model");
let modelConfigured = false;
const stagesElement = document.querySelector("#stages");
const validationPanel = document.querySelector("#validation-panel");
const validationSummary = document.querySelector("#validation-summary");
const validationGatesElement = document.querySelector("#validation-gates");
const jobStatusElement = document.querySelector("#job-status");
const testEvidenceElement = document.querySelector("#test-evidence");
const testEvidenceScenario = document.querySelector(
  "#test-evidence-scenario"
);
const testDataSource = document.querySelector("#test-data-source");
const testMutationMode = document.querySelector("#test-mutation-mode");
const queuePanel = document.querySelector("#queue-panel");
const queueCount = document.querySelector("#queue-count");
const queueList = document.querySelector("#queue-list");
const jobLifecycleStatus = document.querySelector("#job-lifecycle-status");
const holdJobButton = document.querySelector("#hold-job");
const resumeHeldJobButton = document.querySelector("#resume-held-job");
const restartJobButton = document.querySelector("#restart-job");
const historyRetentionDays = document.querySelector(
  "#history-retention-days"
);
const purgeJobHistoryButton = document.querySelector("#purge-job-history");
const jobControlsMessage = document.querySelector("#job-controls-message");
const bugResultsPanel = document.querySelector("#bug-results-panel");
const bugResultsElement = document.querySelector("#bug-results");
const agentActivityPanel = document.querySelector("#agent-activity-panel");
const agentActivityElement = document.querySelector("#agent-activity");
const logsElement = document.querySelector("#logs");
const azureDevOpsIntake = document.querySelector("#azure-devops-intake");
const workItemInput = document.querySelector("#work-item");
const loadWorkItemButton = document.querySelector("#load-work-item");
const workItemSummary = document.querySelector("#work-item-summary");
const workItemCount = document.querySelector("#work-item-count");
const workItemList = document.querySelector("#work-item-list");
const requestInput = document.querySelector("#request");
const screenshotInput = document.querySelector("#screenshots");
const screenshotList = document.querySelector("#screenshot-list");
const screenshotMessage = document.querySelector("#screenshot-message");
const targetEnvironmentSelect = document.querySelector(
  "#target-environment"
);
const jobInputPanel = document.querySelector("#job-input-panel");
const jobInputTitle = document.querySelector("#job-input-title");
const jobInputCount = document.querySelector("#job-input-count");
const jobInputGuidance = document.querySelector("#job-input-guidance");
const jobInputAction = document.querySelector("#job-input-action");
const jobInputDetails = document.querySelector("#job-input-details");
const jobInputSubmit = document.querySelector("#job-input-submit");
const jobInputMessage = document.querySelector("#job-input-message");
const jobInputActionLabel = document.querySelector(
  "label[for='job-input-action']"
);
const jobInputDetailsLabel = document.querySelector(
  "label[for='job-input-details']"
);
const permissionPanel = document.querySelector("#permission-panel");
const permissionDirectory = document.querySelector("#permission-directory");
const permissionReview = document.querySelector("#permission-review");
const permissionApprove = document.querySelector("#permission-approve");
const permissionScope = document.querySelector("#permission-scope");
const permissionMessage = document.querySelector("#permission-message");
const permissionHelper = document.querySelector("#permission-helper");
let permissionSelection = null;
let runtimeHelperDirectory = "";
let permissionBusy = false;
let permissionEdited = false;

function renderPermission(job, isActive) {
  const pending = isActive ? job?.permissionRequest : null;
  permissionPanel.hidden = !pending;
  if (!pending) {
    permissionSelection = null;
    return;
  }
  const key = `${job.id}:${pending.id}`;
  if (permissionSelection?.key !== key) {
    permissionDirectory.value = pending.scope?.requested ?? "";
    permissionMessage.textContent = "";
    permissionEdited = false;
  }
  permissionSelection = { key, jobId: job.id, requestId: pending.id, scope: pending.scope };
  permissionHelper.textContent = runtimeHelperDirectory
    ? `If the denied command needs the installed FixLab helper, its folder is ${runtimeHelperDirectory}. This is a candidate, not a verified cause of the denial. Already granted for this job: ${(job.runtimeDirectoryGrants ?? []).join(", ") || "none"}.`
    : "";
  permissionScope.hidden = !pending.scope || permissionEdited;
  permissionScope.textContent = pending.scope
    ? `Review: read/write access to ${pending.scope.directory} and its descendants for this job only. This approval is not retained after a dashboard restart.`
    : "";
  permissionApprove.hidden = !pending.scope || permissionEdited;
  const stopped = job.canReviewPermissions && job.status === "blocked";
  permissionDirectory.disabled = permissionBusy || !stopped;
  permissionReview.disabled = permissionBusy || !stopped;
  permissionApprove.disabled = permissionBusy || !stopped;
}

permissionDirectory.addEventListener("input", () => {
  permissionEdited = true;
  permissionApprove.hidden = true;
  permissionScope.hidden = true;
});

async function submitPermission(action) {
  const selection = permissionSelection;
  if (!selection || permissionBusy) {
    return;
  }
  const directory = action === "review-directory"
    ? permissionDirectory.value
    : selection.scope?.directory;
  if (action === "approve-directory" && !window.confirm(
    `Grant this job read/write access to ${directory} and its descendants, and resume its background executor? This does not approve tools, URLs, or production changes.`
  )) {
    return;
  }
  permissionBusy = true;
  permissionDirectory.disabled = true;
  permissionReview.disabled = true;
  permissionApprove.disabled = true;
  try {
    const body = await fetchJson("/api/job/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        jobId: selection.jobId,
        requestId: selection.requestId,
        directory,
        confirmed: action === "approve-directory"
      })
    });
    activeJob = body.job;
    observedJobs.set(body.job.id, body.job);
    renderJob(body.job, activeJob);
    permissionMessage.textContent = action === "review-directory"
      ? "Review the resolved folder above. Nothing has been authorized yet."
      : "The scoped executor restart was requested. A successful grant is not proof that the blocked command passed.";
  } catch (error) {
    permissionMessage.textContent = error.message;
  } finally {
    permissionBusy = false;
    renderPermission(activeJob, true);
  }
}

permissionReview.addEventListener("click", () => void submitPermission("review-directory"));
permissionApprove.addEventListener("click", () => void submitPermission("approve-directory"));
const retryLiveTestButton = document.createElement("button");
retryLiveTestButton.id = "retry-live-test";
retryLiveTestButton.type = "button";
retryLiveTestButton.textContent = "Retry Playwright live test";
retryLiveTestButton.hidden = true;
const connectRetryLiveTestButton = document.createElement("button");
connectRetryLiveTestButton.id = "connect-and-retry-live-test";
connectRetryLiveTestButton.type = "button";
connectRetryLiveTestButton.textContent =
  "Connect Playwright, then retry live test";
connectRetryLiveTestButton.hidden = true;
const skipLiveTestButton = document.createElement("button");
skipLiveTestButton.id = "skip-live-test";
skipLiveTestButton.type = "button";
skipLiveTestButton.className = "secondary";
skipLiveTestButton.textContent = "Skip Playwright live test";
skipLiveTestButton.hidden = true;
const openManualLocalhostButton = document.createElement("button");
openManualLocalhostButton.id = "open-manual-localhost";
openManualLocalhostButton.type = "button";
openManualLocalhostButton.textContent = "Open React localhost";
openManualLocalhostButton.hidden = true;
const passManualLocalhostButton = document.createElement("button");
passManualLocalhostButton.id = "pass-manual-localhost";
passManualLocalhostButton.type = "button";
passManualLocalhostButton.textContent = "Passed";
passManualLocalhostButton.hidden = true;
const failManualLocalhostButton = document.createElement("button");
failManualLocalhostButton.id = "fail-manual-localhost";
failManualLocalhostButton.type = "button";
failManualLocalhostButton.className = "secondary";
failManualLocalhostButton.textContent = "Failed";
failManualLocalhostButton.hidden = true;
const approvePullRequestButton = document.createElement("button");
approvePullRequestButton.id = "approve-pull-request";
approvePullRequestButton.type = "button";
approvePullRequestButton.textContent = "Approve and create PR";
approvePullRequestButton.hidden = true;
const dismissFailedJobButton = document.createElement("button");
dismissFailedJobButton.id = "dismiss-failed-job";
dismissFailedJobButton.type = "button";
dismissFailedJobButton.className = "secondary";
dismissFailedJobButton.textContent = "Dismiss failed job and continue queue";
dismissFailedJobButton.hidden = true;
const cancelQueuedJobButton = document.createElement("button");
cancelQueuedJobButton.id = "cancel-queued-job";
cancelQueuedJobButton.type = "button";
cancelQueuedJobButton.className = "secondary";
cancelQueuedJobButton.textContent = "Remove from queue";
cancelQueuedJobButton.hidden = true;
jobInputSubmit.before(
  openManualLocalhostButton,
  passManualLocalhostButton,
  failManualLocalhostButton,
  retryLiveTestButton,
  connectRetryLiveTestButton,
  skipLiveTestButton,
  approvePullRequestButton,
  dismissFailedJobButton,
  cancelQueuedJobButton
);
const playwrightStatus = document.querySelector("#playwright-status");
const playwrightGuidance = document.querySelector("#playwright-guidance");
const playwrightCheck = document.querySelector("#playwright-check");
const playwrightConnect = document.querySelector("#playwright-connect");
const frontendStatusBadge = document.querySelector("#frontend-status");
const frontendGuidance = document.querySelector("#frontend-guidance");
const frontendStart = document.querySelector("#frontend-start");
const frontendStop = document.querySelector("#frontend-stop");
const sessionsList = document.querySelector("#sessions-list");
const sessionsMessage = document.querySelector("#sessions-message");
const sessionsRefresh = document.querySelector("#sessions-refresh");
const onboardingStatus = document.querySelector("#onboarding-status");
const onboardingOrganization = document.querySelector(
  "#onboarding-organization"
);
const onboardingProject = document.querySelector("#onboarding-project");
const onboardingSave = document.querySelector("#onboarding-save");
const onboardingMessage = document.querySelector("#onboarding-message");
const playwrightEvidence = document.createElement("div");
playwrightEvidence.className = "playwright-evidence";
playwrightEvidence.innerHTML = `
  <div class="section-heading">
    <h3 id="playwright-evidence-title">Selected job Playwright evidence</h3>
    <button id="playwright-evidence-refresh" type="button">Refresh evidence</button>
  </div>
  <p id="playwright-evidence-guidance" class="guidance">Select a job to view its browser evidence.</p>
  <div id="playwright-evidence-list" class="evidence-gallery"></div>
`;
stagesElement.after(playwrightEvidence);
const playwrightEvidenceRefresh = document.querySelector(
  "#playwright-evidence-refresh"
);
const playwrightEvidenceGuidance = document.querySelector(
  "#playwright-evidence-guidance"
);
const playwrightEvidenceTitle = document.querySelector(
  "#playwright-evidence-title"
);
const playwrightEvidenceList = document.querySelector(
  "#playwright-evidence-list"
);
const metricsPeriod = document.querySelector("#metrics-period");
const metricBugs = document.querySelector("#metric-bugs");
const metricCompleted = document.querySelector("#metric-completed");
const metricDuration = document.querySelector("#metric-duration");
const metricCacheReuse = document.querySelector("#metric-cache-reuse");
const metricStatuses = document.querySelector("#metric-statuses");
let loadedWorkItems = [];
let selectedScreenshots = [];
let activeJob = null;
let selectedJobId = null;
let pendingRetryAfterConnectJobId = null;
let playwrightAuthenticationRunning = false;
const observedJobs = new Map();
const expandedJobIds = new Set();
let renderedEvidenceJobId = null;

const maxScreenshots = 5;
const maxScreenshotBytes = 2 * 1024 * 1024;
const maxScreenshotTotalBytes = 8 * 1024 * 1024;
const allowedScreenshotTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp"
]);

function escapeText(value) {
  return String(value ?? "");
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return "—";
  }
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function renderReadiness(readiness) {
  const ready = readiness.repositoryReady && readiness.profileReady;
  readinessElement.className = `readiness ${ready ? "ready" : "blocked"}`;
  readinessElement.textContent = ready
    ? `Ready: ${readiness.profileName || readiness.repository}`
    : `Not ready: ${readiness.error}`;
  startButton.disabled = !ready;
  const selectedEnvironment = targetEnvironmentSelect.value;
  const environments = Array.isArray(readiness.environments)
    ? readiness.environments
    : [];
  targetEnvironmentSelect.replaceChildren(
    new Option("Profile default", ""),
    ...environments.map(
      (environment) =>
        new Option(environment.toUpperCase(), environment)
    )
  );
  if (
    environments.some(
      (environment) => environment === selectedEnvironment
    )
  ) {
    targetEnvironmentSelect.value = selectedEnvironment;
  }
}

function renderRuntime(runtime) {
  runtimeHelperDirectory = runtime?.helperDirectory ?? "";
  const supported = runtime?.supportsModelSelection === true;
  modelControl.hidden = !supported;
  modelSelect.disabled = !supported;
  if (!supported) {
    modelSelect.value = "";
    modelConfigured = false;
    return;
  }
  if (!modelConfigured) {
    const defaultModel = runtime.defaultModel ?? "";
    if (![...modelSelect.options].some((option) => option.value === defaultModel)) {
      modelSelect.add(new Option(defaultModel, defaultModel));
    }
    modelSelect.value = defaultModel;
    modelConfigured = true;
  }
}

function labelTestEvidence(value) {
  return String(value ?? "profile-defined")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function refreshOnboarding() {
  try {
    const body = await fetchJson("/api/onboarding");
    onboardingOrganization.value = body.azureDevOps.organization;
    onboardingProject.value = body.azureDevOps.project;
    const configured =
      Boolean(body.azureDevOps.organization) &&
      Boolean(body.azureDevOps.project);
    onboardingStatus.className = `badge ${configured ? "passed" : "blocked"}`;
    onboardingStatus.textContent = configured ? "Configured" : "Required";
    onboardingMessage.textContent = configured
      ? "Numeric Azure DevOps bug IDs can be loaded."
      : "Enter the organization and project to enable numeric bug loading.";
  } catch (error) {
    onboardingStatus.className = "badge blocked";
    onboardingStatus.textContent = "Unavailable";
    onboardingMessage.textContent = error.message;
  }
}

function inferActiveStageFromLogs(logs = []) {
  const stagePatterns = [
    ["live-test", /\b(live[- ]test|browser validation|run(?:ning)? playwright)\b/i],
    ["local-stack", /\b(start(?:ing)? (?:the )?(?:local )?(?:stack|app|server)|local-stack)\b/i],
    ["review", /\b(self-review|code-review|review(?:ing)? (?:the )?(?:effective )?diff)\b/i],
    ["fix", /\b(edit|apply(?:ing)? patch|implement(?:ing)?|correct(?:ing)?|fix(?:ing)?)\b/i],
    ["reproduce", /\b(reproduc(?:e|ing)|focused test|run(?:ning)? tests?)\b/i],
    ["diagnosis", /\b(diagnos(?:e|ing|is)|root cause|trac(?:e|ing)|inspect(?:ing)? the affected)\b/i]
  ];
  for (const entry of [...logs].reverse()) {
    const message = String(entry?.message ?? "");
    const match = stagePatterns.find(([, pattern]) => pattern.test(message));
    if (match) {
      return match[0];
    }
  }
  return null;
}

function renderJob(job, currentActiveJob = job) {
  const running = job?.status === "running";
  const isActive = Boolean(job?.id && job.id === currentActiveJob?.id);
  const activeNeedsQueue =
    currentActiveJob &&
    ["running", "blocked", "failed"].includes(currentActiveJob.status);
  startButton.disabled = readinessElement.classList.contains("blocked");
  startButton.textContent =
    activeNeedsQueue
      ? "Add to queue"
      : "Start job";
  const lastActivityAge =
    running && job?.lastActivityAt
      ? Date.now() - Date.parse(job.lastActivityAt)
      : null;
  jobStatusElement.textContent = job
    ? `${job.status} · ${job.requestType}${job.model ? ` · ${job.model}` : ""} · ${
        job.targetEnvironment || "profile default"
      }${job.sharedWorkspace ? ` · shared: ${job.sharedWorkspace.branch}` : ""} · ${formatDuration(job.durationMs)}${
        lastActivityAge === null
          ? ""
          : ` · last output ${formatDuration(lastActivityAge)} ago`
      }`
    : "Not started";
  jobStatusElement.className = `badge ${job?.status ?? ""}`;
  const testEvidence = job?.testEvidence;
  testEvidenceElement.hidden = !job;
  testEvidenceElement.classList.toggle(
    "reported",
    Boolean(testEvidence?.reported)
  );
  testEvidenceScenario.textContent =
    testEvidence?.scenario ||
    "FixLab will synthesize the smallest focused Playwright scenario from the expected behavior.";
  testDataSource.textContent =
    `Data: ${labelTestEvidence(testEvidence?.source)}`;
  testMutationMode.textContent =
    `Mutations: ${labelTestEvidence(testEvidence?.mutationMode)}`;
  const bugIdentity =
    job?.bugs?.length === 1
      ? `Bug #${job.bugs[0].id}`
      : job?.request
        ? escapeText(job.request).slice(0, 80)
        : "Selected job";
  if (renderedEvidenceJobId !== job?.id) {
    renderedEvidenceJobId = job?.id ?? null;
    playwrightEvidenceTitle.textContent =
      `${bugIdentity} · Playwright evidence`;
    playwrightEvidenceGuidance.textContent = job?.id
      ? "Checking this job's safe Playwright screenshots and videos."
      : "Select a job to view its browser evidence.";
    playwrightEvidenceList.replaceChildren();
    void refreshPlaywrightEvidence();
  }

  const stageValues = stageNames.map(
    (name) => job?.stages?.[name] ?? { status: "pending", message: "" }
  );
  const inferredActiveStage =
    running &&
    !stageValues.some((stage) =>
      ["running", "blocked", "failed"].includes(stage.status)
    )
      ? inferActiveStageFromLogs(job?.logs) ??
        stageNames[
          stageValues.findIndex((stage) => stage.status === "pending")
        ]
      : null;
  stagesElement.replaceChildren();
  for (const name of stageNames) {
    const reportedStage =
      job?.stages?.[name] ?? { status: "pending", message: "" };
    const inferred = name === inferredActiveStage;
    const stage = inferred
      ? {
          status: "running",
          message:
            reportedStage.message ||
            "Agent is working in this step; waiting for its next stage update."
        }
      : reportedStage;
    const card = document.createElement("article");
    card.className = `stage ${stage.status}`;
    if (inferred) {
      card.classList.add("inferred");
    }
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = name;
    const status = document.createElement("span");
    status.textContent = inferred ? "active now" : stage.status;
    heading.append(title, status);
    const message = document.createElement("p");
    message.textContent = escapeText(stage.message) || "Waiting";
    card.append(heading, message);
    stagesElement.append(card);
  }

  const validation = job?.validation;
  validationPanel.hidden = !validation;
  validationSummary.textContent = validation?.message ?? "";
  validationGatesElement.replaceChildren();
  for (const gate of validation?.gates ?? []) {
    const card = document.createElement("article");
    card.className = `stage ${gate.status === "not-applicable" ? "skipped" : gate.status}`;
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = gate.id;
    const status = document.createElement("span");
    status.textContent = gate.status === "not-applicable" ? "Not applicable" : gate.status;
    heading.append(title, status);
    const reason = document.createElement("p");
    reason.textContent = gate.reason ?? (gate.required === false ? "Not required by the reviewed policy." : "Required validation gate.");
    card.append(heading, reason);
    validationGatesElement.append(card);
  }

  bugResultsElement.replaceChildren();
  const bugs = job?.bugs ?? [];
  bugResultsPanel.hidden = bugs.length === 0;
  for (const bug of bugs) {
    const row = document.createElement("tr");
    row.className = `bug-outcome ${bug.outcome}`;
    const identity = document.createElement("td");
    const identifier = bug.url
      ? document.createElement("a")
      : document.createElement("strong");
    if (bug.url) {
      identifier.href = bug.url;
      identifier.target = "_blank";
      identifier.rel = "noreferrer";
    }
    identifier.textContent = `#${bug.id}`;
    const title = document.createElement("span");
    title.textContent = bug.title;
    identity.append(identifier, title);
    const outcome = document.createElement("td");
    outcome.textContent = bug.outcome;
    const owner = document.createElement("td");
    owner.textContent = bug.owner || "Pending";
    const summary = document.createElement("td");
    summary.textContent = bug.summary || "Waiting for diagnosis";
    const pullRequest = document.createElement("td");
    const readiness = job.pullRequestReadiness ?? {
      status: "blocked",
      message: "Waiting for workflow evidence."
    };
    pullRequest.textContent = readiness.status;
    pullRequest.title = readiness.message;
    row.append(identity, outcome, owner, summary, pullRequest);
    bugResultsElement.append(row);
  }

  const activity = job?.activity ?? [];
  agentActivityPanel.hidden = activity.length === 0;
  agentActivityElement.replaceChildren();
  for (const entry of activity) {
    const item = document.createElement("li");
    const heading = document.createElement("div");
    const stage = document.createElement("strong");
    const timestamp = document.createElement("time");
    const message = document.createElement("p");
    stage.textContent = entry.stage;
    timestamp.dateTime = entry.timestamp;
    timestamp.textContent = new Date(entry.timestamp).toLocaleTimeString();
    message.textContent = entry.message;
    heading.append(stage, timestamp);
    item.append(heading, message);
    agentActivityElement.append(item);
  }

  const logLines = job?.logs?.map(
    (entry) => `[${entry.timestamp}] ${entry.stream}: ${entry.message}`
  );
  if (job?.droppedLogs > 0) {
    logLines.unshift(
      `[dashboard] ${job.droppedLogs} older log entries omitted from the bounded local view.`
    );
  }
  logsElement.textContent =
    logLines?.length > 0 ? logLines.join("\n") : "No job output yet.";
  logsElement.scrollTop = logsElement.scrollHeight;
  formError.textContent = job?.error ?? "";

  renderPermission(job, isActive);
  const canResume = isActive && Boolean(job?.canResume) && !job?.permissionRequest;
  const canComment = isActive && Boolean(job?.canComment) && !job?.permissionRequest;
  const canRetryLiveTest =
    canResume &&
    job?.status === "blocked" &&
    job?.stages?.["live-test"]?.status === "blocked" &&
    !job?.manualLocalhostPending;
  const canConfirmManualLocalhost =
    canResume &&
    job?.status === "blocked" &&
    job?.manualLocalhostPending &&
    job?.stages?.["live-test"]?.status === "blocked";
  const canApprovePullRequest =
    canResume &&
    job?.pullRequestReadiness?.status === "approval-required";
  const canDismissFailedJob =
    isActive && Boolean(job?.canDismiss ?? canResume) &&
    ["failed", "blocked"].includes(job?.status);
  const dismissOnly = canDismissFailedJob && !canResume && !canComment;
  dismissFailedJobButton.textContent =
    job?.status === "blocked"
      ? "Dismiss blocked job and continue queue"
      : "Dismiss failed job and continue queue";
  const canCancelQueuedJob =
    !isActive && job?.status === "queued";
  const canHoldJob =
    Boolean(job?.id) && !job?.permissionRequest &&
    ((isActive && ["running", "blocked", "failed"].includes(job.status)) ||
      (!isActive && job.status === "queued"));
  const canResumeHeldJob = !isActive && job?.status === "held";
  const canRestartJob =
    Boolean(job?.id) &&
    ["passed", "failed", "blocked", "cancelled"].includes(job.status) &&
    !(isActive && running);
  holdJobButton.hidden = !canHoldJob;
  holdJobButton.disabled = !canHoldJob;
  resumeHeldJobButton.hidden = !canResumeHeldJob;
  resumeHeldJobButton.disabled = !canResumeHeldJob;
  restartJobButton.hidden = !canRestartJob;
  restartJobButton.disabled = !canRestartJob;
  jobInputPanel.hidden = !(canResume || canComment || canCancelQueuedJob || canDismissFailedJob);
  jobInputSubmit.disabled = !(canResume || canComment);
  jobInputSubmit.hidden = canCancelQueuedJob || canConfirmManualLocalhost || dismissOnly;
  jobInputAction.hidden = canCancelQueuedJob || canConfirmManualLocalhost || dismissOnly;
  jobInputActionLabel.hidden =
    canCancelQueuedJob || canConfirmManualLocalhost || dismissOnly;
  jobInputDetails.hidden = canCancelQueuedJob || canConfirmManualLocalhost || dismissOnly;
  jobInputDetailsLabel.hidden =
    canCancelQueuedJob || canConfirmManualLocalhost || dismissOnly;
  openManualLocalhostButton.hidden = !canConfirmManualLocalhost;
  openManualLocalhostButton.disabled = !canConfirmManualLocalhost;
  passManualLocalhostButton.hidden = !canConfirmManualLocalhost;
  passManualLocalhostButton.disabled = !canConfirmManualLocalhost;
  failManualLocalhostButton.hidden = !canConfirmManualLocalhost;
  failManualLocalhostButton.disabled = !canConfirmManualLocalhost;
  retryLiveTestButton.hidden = !canRetryLiveTest;
  connectRetryLiveTestButton.hidden = !canRetryLiveTest;
  updateLiveTestRetryAvailability();
  skipLiveTestButton.hidden = !canRetryLiveTest;
  skipLiveTestButton.disabled = !canRetryLiveTest;
  approvePullRequestButton.hidden = !canApprovePullRequest;
  approvePullRequestButton.disabled = !canApprovePullRequest;
  dismissFailedJobButton.hidden = !canDismissFailedJob;
  dismissFailedJobButton.disabled = !canDismissFailedJob;
  cancelQueuedJobButton.hidden = !canCancelQueuedJob;
  cancelQueuedJobButton.disabled = !canCancelQueuedJob;
  jobInputCount.textContent = job
    ? `${job.inputCount} update(s) · ${job.pendingInputCount} pending`
    : "";
  if (canComment) {
    jobInputTitle.textContent = "Add comment to current job";
    jobInputGuidance.textContent =
      "The comment will be delivered to this same session automatically after its current agent turn finishes.";
    jobInputAction.value = "comment";
    jobInputAction.disabled = true;
    jobInputSubmit.textContent = "Queue comment";
  } else if (canResume) {
    jobInputAction.disabled = false;
    if (jobInputAction.value === "comment") {
      jobInputAction.value = "continue";
    }
    jobInputSubmit.textContent = "Resume FixLab";
    if (job.status === "blocked") {
      jobInputTitle.textContent = "Action needed";
      jobInputGuidance.textContent =
        canApprovePullRequest
          ? "All required validation gates passed. Explicit approval is required before FixLab creates or updates the pull request."
          : job?.manualLocalhostPending &&
              job?.stages?.["live-test"]?.status === "blocked"
            ? `The React app is running at ${job.manualLocalhostUrl || "the profile-defined localhost URL"}. Validate it in the browser, then confirm Passed or Failed before FixLab closes the job.`
          : job?.stages?.["live-test"]?.status === "blocked"
          ? "The browser gate could not finish. If authentication is needed, choose Connect Playwright, then retry: sign in in the Edge window and FixLab retries automatically. Retry reuses saved authentication and runs only Playwright; Skip records the missing browser evidence and continues under repository PR policy."
          : "Provide the missing authentication, safe data, approval, or manual result, then resume the same FixLab session.";
    } else if (job.status === "failed") {
      jobInputTitle.textContent = "Retry or correct this job";
      jobInputGuidance.textContent =
        "Review the failure above. To preserve and resume this job, choose Retry with the available prerequisite, enter the correction, then select Resume FixLab. If the job is obsolete, dismiss it as failed to start the next queued job without resuming or changing its repository work.";
    } else {
      jobInputTitle.textContent = "Add details or update the existing PR";
      jobInputGuidance.textContent =
        "Continue this completed session with one focused addition. FixLab reuses its evidence, branch, and pull request.";
    }
  } else if (dismissOnly) {
    jobInputTitle.textContent = job.permissionRequest
      ? "Permission-blocked job"
      : "Stopped job";
    jobInputGuidance.textContent = job.permissionRequest
      ? "The executor has stopped. Review folder access above if appropriate, or dismiss this job as blocked and continue the queue without granting access or resuming it."
      : "This stopped job cannot be resumed through the current dashboard. Dismiss it to preserve its outcome and continue the queue without resuming it.";
  } else if (canCancelQueuedJob) {
    jobInputTitle.textContent = "Remove waiting job";
    jobInputGuidance.textContent =
      "Removing this waiting job prevents it from starting, records it as cancelled in history, and deletes its queued screenshot artifacts.";
  }
}

function updateLiveTestRetryAvailability() {
  retryLiveTestButton.disabled =
    retryLiveTestButton.hidden || playwrightAuthenticationRunning;
  connectRetryLiveTestButton.disabled =
    connectRetryLiveTestButton.hidden ||
    playwrightAuthenticationRunning ||
    Boolean(pendingRetryAfterConnectJobId);
  const reason = playwrightAuthenticationRunning
    ? "Finish sign-in and close its browser window before retrying the live test."
    : "";
  retryLiveTestButton.title = reason;
  connectRetryLiveTestButton.title = reason;
}

function renderPlaywrightStatus(status) {
  playwrightAuthenticationRunning = Boolean(status.running);
  updateLiveTestRetryAvailability();
  playwrightStatus.className = `badge ${
    status.running ? "running" : status.ready ? "passed" : "blocked"
  }`;
  playwrightStatus.textContent = status.running
    ? status.ready
      ? "Connected · helper running"
      : "Authentication open"
    : status.ready
      ? "Connected"
      : status.configured
        ? "Not connected"
        : "Not configured";
  playwrightConnect.disabled = status.running || !status.configured;
  void resumeAfterConnect(status);
  const pathSummary = status.paths
    .map((entry) => `${entry.ready ? "ready" : "missing"}: ${entry.path}`)
    .join(" · ");
  playwrightGuidance.textContent =
    status.running
      ? "Authentication is still running. Finish sign-in and close its browser window if it stays open; live-test retries wait until the helper exits."
      : status.error ||
        status.lastResult?.message ||
        pathSummary ||
        "Add browserAutomation.authentication to the repository profile.";
}

async function resumeAfterConnect(status) {
  if (!pendingRetryAfterConnectJobId || status.running) {
    return;
  }
  const jobId = pendingRetryAfterConnectJobId;
  const result = status.lastResult;
  if (!result) {
    return;
  }
  pendingRetryAfterConnectJobId = null;
  if (!result.ok) {
    formError.textContent = `${result.message} The live test was not retried.`;
    return;
  }
  if (activeJob?.id === jobId && activeJob.status === "blocked") {
    await retryLiveTest();
  }
}

function renderFrontendStatus(status) {
  frontendStatusBadge.textContent = !status.configured
    ? "Not configured"
    : status.healthy
      ? "Ready"
      : status.running
        ? "Starting…"
        : "Stopped";
  frontendStart.disabled =
    !status.configured || status.running || status.healthy;
  frontendStop.disabled = !status.running;
  frontendGuidance.textContent = status.error
    ? status.error
    : status.healthy
      ? `React is answering at ${status.healthUrl}. Playwright authentication and live tests reuse it.`
      : status.running
        ? "React is compiling. The first start can take several minutes; this updates automatically."
        : status.lastResult && !status.lastResult.ok
          ? status.lastResult.message
          : "Start the profile-defined React frontend ahead of time so Playwright authentication and live tests reuse it instead of waiting for a cold compile.";
}

async function refreshFrontendStatus() {
  try {
    renderFrontendStatus(await fetchJson("/api/frontend/status"));
  } catch (error) {
    frontendGuidance.textContent = error.message;
  }
}

async function startFrontend() {
  try {
    renderFrontendStatus(
      await fetchJson("/api/frontend/start", { method: "POST" })
    );
  } catch (error) {
    formError.textContent = error.message;
    await refreshFrontendStatus();
  }
}

frontendStart.addEventListener("click", () => {
  formError.textContent = "";
  frontendStart.disabled = true;
  void startFrontend();
});

async function refreshSessions() {
  try {
    const body = await fetchJson("/api/sessions");
    sessionsList.replaceChildren();
    for (const session of body.sessions) {
      const row = document.createElement("article");
      const description = document.createElement("p");
      description.className = "guidance";
      description.textContent = session.available
        ? `${session.id === body.ownerId ? "This dashboard" : "Other FixLab dashboard"} · ${session.id} · Job ${session.job?.id ?? "none"} (${session.job?.status ?? "not started"}) · React ${session.frontend.running ? `running (PID ${session.frontend.pid})` : "stopped"}`
        : `Owner ${session.id} is unavailable: ${session.error}. No process will be stopped.`;
      row.append(description);
      if (session.available) {
        const controls = document.createElement("div");
        controls.className = "button-row";
        const reconnect = document.createElement("a");
        reconnect.href = session.url;
        reconnect.textContent = "Reconnect to live dashboard";
        controls.append(reconnect);
        const actions = [
          { label: "Resume job", action: "resume", resource: "job", enabled: session.job?.canResume || session.job?.running },
          { label: "Stop agent", action: "stop", resource: "job", enabled: session.job?.running },
          { label: "Start / resume React", action: "resume", resource: "frontend", enabled: !session.frontend.running },
          { label: "Stop React", action: "stop", resource: "frontend", enabled: session.frontend.running },
          { label: "Shutdown sessions", action: "shutdown", resource: "all", enabled: session.job?.running || session.frontend.running || session.authentication.running }
        ];
        for (const control of actions) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "secondary";
          button.textContent = control.label;
          button.disabled = !control.enabled;
          button.addEventListener("click", async () => {
            const destructive = control.action !== "resume";
            if (destructive && !window.confirm(
              `${control.label} for FixLab owner ${session.id} at ${session.url}, job ${session.job?.id ?? "none"}? Only this owner's processes will be stopped; saved job context remains resumable.`
            )) {
              return;
            }
            button.disabled = true;
            try {
              await fetchJson("/api/sessions/control", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ownerId: session.id,
                  jobId: session.job?.id ?? null,
                  action: control.action,
                  resource: control.resource,
                  confirmed: destructive
                })
              });
              sessionsMessage.textContent = `${control.label} accepted for owner ${session.id}.`;
              await refreshSessions();
              await refresh();
              await refreshFrontendStatus();
            } catch (error) {
              sessionsMessage.textContent = error.message;
              button.disabled = false;
            }
          });
          controls.append(button);
        }
        row.append(controls);
      }
      sessionsList.append(row);
    }
  } catch (error) {
    sessionsMessage.textContent = error.message;
  }
}

sessionsRefresh.addEventListener("click", refreshSessions);

frontendStop.addEventListener("click", async () => {
  frontendStop.disabled = true;
  try {
    const owner = await fetchJson("/api/session");
    if (!window.confirm(`Stop React owned by FixLab dashboard ${owner.id}? Only its frontend process tree will be stopped.`)) {
      await refreshFrontendStatus();
      return;
    }
    renderFrontendStatus(
      await fetchJson("/api/frontend/stop", { method: "POST" })
    );
  } catch (error) {
    formError.textContent = error.message;
    await refreshFrontendStatus();
  }
});

async function refreshPlaywrightStatus() {
  try {
    renderPlaywrightStatus(await fetchJson("/api/playwright/status"));
  } catch (error) {
    playwrightGuidance.textContent = error.message;
  }
}

async function refreshPlaywrightEvidence() {
  playwrightEvidenceRefresh.disabled = true;
  try {
    const jobId = selectedJobId ?? activeJob?.id;
    if (!jobId) {
      playwrightEvidenceGuidance.textContent =
        "Select a job to view its browser evidence.";
      playwrightEvidenceList.replaceChildren();
      return;
    }
    const body = await fetchJson(
      `/api/playwright/artifacts?jobId=${encodeURIComponent(jobId)}`
    );
    playwrightEvidenceList.replaceChildren();
    playwrightEvidenceGuidance.textContent =
      body.artifacts.length > 0
        ? `${body.artifacts.length} evidence artifact(s) for this job`
        : "No safe screenshot or video exists for this job yet. This updates automatically while Playwright runs.";
    for (const artifact of body.artifacts) {
      const item = artifact.kind === "video"
        ? document.createElement("div")
        : document.createElement("a");
      if (artifact.kind === "video") {
        item.className = "evidence-item";
        const media = document.createElement("video");
        media.src = artifact.url;
        media.controls = true;
        media.preload = "metadata";
        media.setAttribute(
          "aria-label",
          `Playwright video evidence: ${artifact.name}`
        );
        item.append(media);
      } else {
        item.href = artifact.url;
        item.target = "_blank";
        item.rel = "noreferrer";
        const media = document.createElement("img");
        media.src = artifact.url;
        media.alt = `Playwright evidence: ${artifact.name}`;
        item.append(media);
      }
      const caption = document.createElement("span");
      caption.textContent = artifact.relativePath;
      item.append(caption);
      playwrightEvidenceList.append(item);
    }
  } catch (error) {
    playwrightEvidenceGuidance.textContent = error.message;
  } finally {
    playwrightEvidenceRefresh.disabled = false;
  }
}

function queuedJobView(job) {
  return {
    ...job,
    status: job.status ?? "queued",
    startedAt: null,
    finishedAt: null,
    error: null,
    canResume: false,
    canComment: false,
    inputCount: 0,
    pendingInputCount: 0,
    durationMs: 0,
    usage: {},
    stages:
      job.stages ??
      Object.fromEntries(
        stageNames.map((stage) => [
          stage,
          { status: "pending", message: "" }
        ])
      ),
    bugs: job.bugs ?? [],
    logs: [],
    activity: [],
    droppedLogs: 0
  };
}

function rememberJob(job) {
  if (job?.id) {
    observedJobs.set(job.id, job);
  }
}

function selectJob(jobId) {
  selectedJobId = jobId;
  const selectedJob = observedJobs.get(jobId);
  if (selectedJob) {
    renderJob(selectedJob, activeJob);
  }
}

function renderQueue(currentJob, queue = [], held = [], history = []) {
  const visibleIds = new Set([
    currentJob?.id,
    ...queue.map((job) => job.id),
    ...held.map((job) => job.id),
    ...history.map((job) => job.id)
  ]);
  for (const jobId of observedJobs.keys()) {
    if (!visibleIds.has(jobId)) {
      observedJobs.delete(jobId);
      expandedJobIds.delete(jobId);
    }
  }
  if (selectedJobId && !visibleIds.has(selectedJobId)) {
    selectedJobId = currentJob?.id ?? null;
  }
  rememberJob(currentJob);
  for (const job of history) {
    rememberJob(job);
  }
  for (const job of held) {
    rememberJob(job);
  }
  for (const job of queue) {
    if (!observedJobs.has(job.id)) {
      observedJobs.set(job.id, queuedJobView(job));
    }
  }
  const queuedIds = new Set(queue.map((job) => job.id));
  const heldIds = new Set(held.map((job) => job.id));
  const recentJobs = [...observedJobs.values()]
    .filter(
      (job) =>
        job.id !== currentJob?.id &&
        !queuedIds.has(job.id) &&
        !heldIds.has(job.id)
    )
    .reverse();
  const entries = [
    ...(currentJob ? [{ job: currentJob, label: "Current" }] : []),
    ...queue.map((job) => ({
      job: observedJobs.get(job.id),
      label: `Waiting #${job.position}`
    })),
    ...held.map((job) => ({ job, label: "Held" })),
    ...recentJobs.map((job) => ({ job, label: "Recent" }))
  ];

  queuePanel.hidden = entries.length < 2;
  queuePanel.querySelector("h3").textContent = "Jobs";
  queueCount.textContent =
    `${queue.length} waiting · ${held.length} held · ${recentJobs.length} recent`;
  jobLifecycleStatus.textContent =
    `${queue.length} waiting · ${held.length} held · ${recentJobs.length} recent`;
  queueList.replaceChildren();
  for (const { job, label } of entries) {
    const item = document.createElement("li");
    item.className = "job-row";
    if (expandedJobIds.has(job.id)) {
      item.classList.add("expanded");
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "job-selector";
    if ((selectedJobId ?? currentJob?.id) === job.id) {
      button.classList.add("selected");
    }
    const summary = document.createElement("strong");
    summary.textContent = `${label} · ${job.status} · ${job.requestType}`;
    const details = document.createElement("span");
    details.className = "job-request";
    details.textContent =
      ` · ${job.bugCount ?? job.bugs?.length ?? 0} bug(s) · ${job.request}`;
    button.append(summary, details);
    button.addEventListener("click", () => {
      selectJob(job.id);
      renderQueue(currentJob, queue, held, history);
    });

    item.append(button);
    if (job.request.length > 160) {
      const expandButton = document.createElement("button");
      const expanded = expandedJobIds.has(job.id);
      expandButton.type = "button";
      expandButton.className = "job-expand";
      expandButton.textContent = expanded ? "⌃" : "⌄";
      expandButton.setAttribute(
        "aria-label",
        `${expanded ? "Collapse" : "Expand"} bug text for ${label}`
      );
      expandButton.setAttribute("aria-expanded", String(expanded));
      expandButton.addEventListener("click", () => {
        const nextExpanded = !expandedJobIds.has(job.id);
        if (nextExpanded) {
          expandedJobIds.add(job.id);
        } else {
          expandedJobIds.delete(job.id);
        }
        item.classList.toggle("expanded", nextExpanded);
        expandButton.textContent = nextExpanded ? "⌃" : "⌄";
        expandButton.setAttribute("aria-expanded", String(nextExpanded));
        expandButton.setAttribute(
          "aria-label",
          `${nextExpanded ? "Collapse" : "Expand"} bug text for ${label}`
        );
      });
      item.append(expandButton);
    }
    queueList.append(item);
  }
}

function renderMetrics(metrics, warning) {
  metricBugs.textContent = metrics.bugs.toLocaleString();
  metricCompleted.textContent =
    `${metrics.completed.toLocaleString()} / ${metrics.queued.toLocaleString()} jobs`;
  metricDuration.textContent = formatDuration(metrics.averageDurationMs);
  metricCacheReuse.textContent =
    metrics.cacheReusePercent === null
      ? "—"
      : `${metrics.cacheReusePercent.toFixed(1)}%`;
  metricStatuses.textContent =
    warning ||
    `${metrics.passed} passed · ${metrics.failed} failed · ${metrics.blocked} blocked · ${metrics.cancelled} cancelled · exact usage available for ${metrics.usageJobs} completed job(s)`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

function selectedIntakeSource() {
  return form.elements.intakeSource.value;
}

function renderWorkItems(workItems) {
  workItemList.replaceChildren();
  workItemCount.textContent = `${workItems.length} bug${workItems.length === 1 ? "" : "s"} loaded`;
  for (const workItem of workItems) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = workItem.webUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `#${workItem.id}`;
    item.append(
      link,
      ` · ${workItem.state || "Unknown"} · ${workItem.title} · ${workItem.commentCount || 0} comment(s) · ${workItem.imageCount || 0} image(s)${workItem.commentsWarning ? " · comments unavailable" : ""}${workItem.imagesWarning ? " · some images unavailable" : ""}`
    );
    workItemList.append(item);
  }
  workItemSummary.hidden = false;
}

function workItemsRequest(workItems) {
  const separator = "\n\n==============================\n\n";
  const blockBudget = Math.floor(
    (9800 - separator.length * (workItems.length - 1)) / workItems.length
  );
  return workItems
    .map((workItem) => {
      const header = [
        `Azure DevOps Bug ${workItem.id}: ${workItem.title}`,
        `URL: ${workItem.webUrl}`,
        workItem.state ? `State: ${workItem.state}` : ""
      ]
        .filter(Boolean)
        .join("\n");
      const evidence = [
        workItem.description,
        workItem.reproduction,
        workItem.acceptanceCriteria,
        workItem.commentsWarning,
        workItem.imagesWarning,
        ...(workItem.comments ?? []).map(
          (comment) =>
            `Comment by ${comment.author || "Unknown"}${comment.createdAt ? ` at ${comment.createdAt}` : ""}:\n${comment.text}`
        )
      ]
        .filter(Boolean)
        .join("\n\n");
      const evidenceBudget = Math.max(
        0,
        blockBudget - header.length - "\nEvidence:\n".length
      );
      return evidenceBudget > 0 && evidence
        ? `${header}\nEvidence:\n${evidence.slice(0, evidenceBudget)}`
        : header.slice(0, blockBudget);
    })
    .join(separator);
}

function workItemInputs(value) {
  return [
    ...new Set(
      String(value)
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function validateSelectedScreenshots() {
  const files = selectedScreenshots;
  if (files.length > maxScreenshots) {
    throw new Error(`Select at most ${maxScreenshots} screenshots.`);
  }
  let total = 0;
  for (const file of files) {
    if (!allowedScreenshotTypes.has(file.type)) {
      throw new Error(`${file.name} is not a PNG, JPEG, or WebP image.`);
    }
    if (file.size > maxScreenshotBytes) {
      throw new Error(`${file.name} exceeds the 2 MiB per-file limit.`);
    }
    total += file.size;
  }
  if (total > maxScreenshotTotalBytes) {
    throw new Error("Selected screenshots exceed the 8 MiB total limit.");
  }
  return files;
}

function renderScreenshots() {
  screenshotList.replaceChildren();
  for (const file of selectedScreenshots) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${file.name} (${Math.ceil(file.size / 1024)} KiB)`;
    item.append(label);
    screenshotList.append(item);
  }
}

function addScreenshots(files) {
  const next = [...selectedScreenshots, ...files];
  selectedScreenshots = next;
  try {
    validateSelectedScreenshots();
  } catch (error) {
    selectedScreenshots = next.slice(0, -files.length);
    throw error;
  }
  renderScreenshots();
}

function showScreenshotResult(message, error = false) {
  screenshotMessage.textContent = message;
  screenshotMessage.className = error ? "error" : "guidance";
}

function normalizeClipboardScreenshot(file, index) {
  if (file.name) {
    return file;
  }
  const extension = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp"
  }[file.type];
  return new File(
    [file],
    `pasted-${Date.now()}-${index + 1}${extension}`,
    {
      type: file.type,
      lastModified: file.lastModified
    }
  );
}

async function convertClipboardScreenshot(file, index) {
  if (allowedScreenshotTypes.has(file.type)) {
    return normalizeClipboardScreenshot(file, index);
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!blob) {
      throw new Error("The clipboard image could not be converted to PNG.");
    }
    return new File([blob], `pasted-${Date.now()}-${index + 1}.png`, {
      type: "image/png",
      lastModified: Date.now()
    });
  } finally {
    bitmap.close();
  }
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () =>
      reject(new Error(`Could not read ${file.name}.`))
    );
    reader.addEventListener("load", () => {
      const result = String(reader.result);
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error(`Could not encode ${file.name}.`));
        return;
      }
      resolve({
        name: file.name,
        mimeType: file.type,
        base64: result.slice(separator + 1)
      });
    });
    reader.readAsDataURL(file);
  });
}

function loadedScreenshotFile(screenshot) {
  const binary = atob(screenshot.base64);
  const bytes = Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0)
  );
  return new File([bytes], screenshot.name, {
    type: screenshot.mimeType,
    lastModified: Date.now()
  });
}

document.querySelectorAll("input[name='intakeSource']").forEach((input) => {
  input.addEventListener("change", () => {
    azureDevOpsIntake.hidden = selectedIntakeSource() !== "azure-devops";
  });
});

loadWorkItemButton.addEventListener("click", async () => {
  formError.textContent = "";
  loadWorkItemButton.disabled = true;
  try {
    const inputs = workItemInputs(workItemInput.value);
    if (inputs.length < 1 || inputs.length > 20) {
      throw new Error("Enter between 1 and 20 unique Azure DevOps IDs or URLs.");
    }
    const body = await fetchJson("/api/azure-devops/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItems: inputs })
    });
    const loadedScreenshots = body.workItems.flatMap(
      (workItem) => workItem.screenshots ?? []
    );
    loadedWorkItems = body.workItems.map(
      ({ screenshots = [], ...workItem }) => ({
        ...workItem,
        imageCount: screenshots.length
      })
    );
    addScreenshots(loadedScreenshots.map(loadedScreenshotFile));
    renderWorkItems(loadedWorkItems);
    requestInput.value = workItemsRequest(loadedWorkItems);
  } catch (error) {
    loadedWorkItems = [];
    workItemSummary.hidden = true;
    formError.textContent = error.message;
  } finally {
    loadWorkItemButton.disabled = false;
  }
});

screenshotInput.addEventListener("change", () => {
  formError.textContent = "";
  try {
    const files = [...screenshotInput.files];
    addScreenshots(files);
    showScreenshotResult(
      `${files.length} screenshot(s) attached. ${selectedScreenshots.length} of ${maxScreenshots} selected.`
    );
  } catch (error) {
    formError.textContent = error.message;
    showScreenshotResult(error.message, true);
  } finally {
    screenshotInput.value = "";
  }
});

document.addEventListener("paste", async (event) => {
  const fileItems = [...(event.clipboardData?.items ?? [])].filter(
    (item) => item.kind === "file"
  );
  const items = fileItems.filter(
    (item) => item.kind === "file" && item.type.startsWith("image/")
  );
  if (items.length === 0) {
    if (fileItems.length > 0) {
      showScreenshotResult(
        "The pasted file is not recognized as an image. Paste a PNG, JPEG, or WebP screenshot.",
        true
      );
    }
    return;
  }
  event.preventDefault();
  formError.textContent = "";
  try {
    const files = items
    .map((item) => item.getAsFile())
      .filter(Boolean);
    addScreenshots(
      await Promise.all(files.map(convertClipboardScreenshot))
    );
    showScreenshotResult(
      `${files.length} pasted screenshot(s) attached. ${selectedScreenshots.length} of ${maxScreenshots} selected.`
    );
  } catch (error) {
    const message =
      error.message || "The clipboard image could not be added.";
    formError.textContent = message;
    showScreenshotResult(message, true);
  }
});

async function refresh() {
  try {
    const body = await fetchJson("/api/status");
    activeJob = body.job;
    rememberJob(activeJob);
    for (const queuedJob of body.queue) {
      const existing = observedJobs.get(queuedJob.id);
      observedJobs.set(
        queuedJob.id,
        queuedJobView(existing ? { ...existing, ...queuedJob } : queuedJob)
      );
    }
    for (const historicalJob of body.history ?? []) {
      rememberJob(historicalJob);
    }
    for (const heldJob of body.held ?? []) {
      rememberJob(heldJob);
    }
    if (!selectedJobId || !observedJobs.has(selectedJobId)) {
      selectedJobId = activeJob?.id ?? null;
    }
    renderRuntime(body.runtime);
    renderReadiness(body.readiness);
    renderJob(observedJobs.get(selectedJobId) ?? activeJob, activeJob);
    renderQueue(activeJob, body.queue, body.held, body.history);
  } catch (error) {
    formError.textContent = error.message;
  }
}

async function refreshMetrics() {
  try {
    const body = await fetchJson(
      `/api/metrics?period=${encodeURIComponent(metricsPeriod.value)}`
    );
    renderMetrics(body.metrics, body.warning);
  } catch (error) {
    formError.textContent = error.message;
  }
}

metricsPeriod.addEventListener("change", refreshMetrics);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  startButton.disabled = true;
  try {
    const data = new FormData(form);
    const intakeSource = data.get("intakeSource");
    if (intakeSource === "azure-devops" && loadedWorkItems.length === 0) {
      throw new Error("Load one or more Azure DevOps bugs before starting.");
    }
    const screenshots = await Promise.all(
      validateSelectedScreenshots().map(fileBase64)
    );
    const body = await fetchJson("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: data.get("request"),
        requestType: data.get("requestType"),
        model: data.get("model") ?? "",
        mode: data.get("mode"),
        validationIntent: data.get("validationIntent") || undefined,
        pullRequestStrategy: data.get("separatePullRequests") === "on"
          ? "per-bug"
          : "common",
        runAllUiScenarios: data.get("runAllUiScenarios") === "on",
        targetEnvironment: data.get("targetEnvironment"),
        prestartFrontend: data.get("prestartFrontend") === "on",
        recordPlaywrightVideo:
          data.get("recordPlaywrightVideo") === "on",
        manualLocalhostTest:
          data.get("manualLocalhostTest") === "on",
        intakeSource,
        workItems: intakeSource === "azure-devops" ? loadedWorkItems : [],
        screenshots
      })
    });
    requestInput.value = "";
    requestInput.focus();
    selectedScreenshots = [];
    renderScreenshots();
    showScreenshotResult("");
    activeJob = body.job;
    selectedJobId = body.job?.id ?? null;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
    renderQueue(activeJob, body.queue, body.held, body.history);
    await refreshMetrics();
  } catch (error) {
    formError.textContent = error.message;
    startButton.disabled = false;
  }
});

cancelQueuedJobButton.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  const selectedJob = observedJobs.get(selectedJobId);
  if (!selectedJob || selectedJob.status !== "queued") {
    formError.textContent = "Select a waiting job to remove.";
    return;
  }
  if (
    !window.confirm(
      "Remove this waiting job from the queue? It will not run, its screenshot artifacts will be deleted, and it will remain visible as cancelled in history."
    )
  ) {
    return;
  }
  cancelQueuedJobButton.disabled = true;
  try {
    const body = await fetchJson("/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: selectedJob.id })
    });
    if (body.cancelledJob) {
      rememberJob(body.cancelledJob);
    }
    activeJob = body.job;
    selectedJobId = body.cancelledJob?.id ?? body.job?.id ?? null;
    const history = body.cancelledJob &&
        !(body.history ?? []).some((job) => job.id === body.cancelledJob.id)
      ? [body.cancelledJob, ...(body.history ?? [])]
      : body.history;
    renderJob(
      observedJobs.get(selectedJobId) ?? body.cancelledJob ?? body.job,
      activeJob
    );
    renderQueue(activeJob, body.queue, body.held, history);
    jobInputMessage.textContent = "Waiting job removed from the queue.";
    await refreshMetrics();
  } catch (error) {
    formError.textContent = error.message;
    cancelQueuedJobButton.disabled = false;
  }
});

holdJobButton.addEventListener("click", async () => {
  const selectedJob = observedJobs.get(selectedJobId);
  if (!selectedJob?.id) {
    jobControlsMessage.textContent = "Select a running or waiting job to hold.";
    return;
  }
  if (
    !window.confirm(
      "Hold this job? FixLab will stop only its owned executor, preserve its workflow state, and continue the waiting queue."
    )
  ) {
    return;
  }
  holdJobButton.disabled = true;
  jobControlsMessage.textContent = "";
  try {
    await fetchJson("/api/jobs/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: selectedJob.id })
    });
    selectedJobId = selectedJob.id;
    jobControlsMessage.textContent =
      "Hold accepted. The job remains available under Held jobs.";
    await refresh();
    await refreshMetrics();
  } catch (error) {
    jobControlsMessage.textContent = error.message;
    holdJobButton.disabled = false;
  }
});

resumeHeldJobButton.addEventListener("click", async () => {
  const selectedJob = observedJobs.get(selectedJobId);
  if (!selectedJob?.id || selectedJob.status !== "held") {
    jobControlsMessage.textContent = "Select a held job to resume.";
    return;
  }
  resumeHeldJobButton.disabled = true;
  jobControlsMessage.textContent = "";
  try {
    const body = await fetchJson("/api/jobs/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: selectedJob.id })
    });
    selectedJobId = body.resumedJob?.id ?? selectedJob.id;
    jobControlsMessage.textContent = body.queued
      ? "Held job returned to the waiting queue."
      : "Held job resumed in the same session.";
    await refresh();
    await refreshMetrics();
  } catch (error) {
    jobControlsMessage.textContent = error.message;
    resumeHeldJobButton.disabled = false;
  }
});

restartJobButton.addEventListener("click", async () => {
  const selectedJob = observedJobs.get(selectedJobId);
  if (!selectedJob?.id) {
    jobControlsMessage.textContent = "Select a terminal job to restart.";
    return;
  }
  if (
    !window.confirm(
      "Restart this retained job from intake? FixLab will create a new job and session while preserving the original outcome in history."
    )
  ) {
    return;
  }
  restartJobButton.disabled = true;
  jobControlsMessage.textContent = "";
  try {
    const body = await fetchJson("/api/jobs/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: selectedJob.id })
    });
    selectedJobId = body.restartedJob?.id ?? body.job?.id ?? null;
    jobControlsMessage.textContent = body.queued
      ? "Restarted job added to the waiting queue."
      : "Restarted job is running from intake.";
    await refresh();
    await refreshMetrics();
  } catch (error) {
    jobControlsMessage.textContent = error.message;
    restartJobButton.disabled = false;
  }
});

purgeJobHistoryButton.addEventListener("click", async () => {
  const olderThanDays = Number(historyRetentionDays.value);
  if (
    !Number.isInteger(olderThanDays) ||
    olderThanDays < 1 ||
    olderThanDays > 3650
  ) {
    jobControlsMessage.textContent =
      "Enter a whole number of days between 1 and 3650.";
    return;
  }
  if (
    !window.confirm(
      `Delete completed job history older than ${olderThanDays} day(s)? Active, waiting, and held jobs are never deleted.`
    )
  ) {
    return;
  }
  purgeJobHistoryButton.disabled = true;
  jobControlsMessage.textContent = "";
  try {
    const body = await fetchJson("/api/history/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ olderThanDays })
    });
    jobControlsMessage.textContent =
      `${body.deleted} completed job(s) deleted from retained history.`;
    await refresh();
  } catch (error) {
    jobControlsMessage.textContent = error.message;
  } finally {
    purgeJobHistoryButton.disabled = false;
  }
});

jobInputSubmit.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  jobInputSubmit.disabled = true;
  try {
    const action = jobInputAction.value;
    const details =
      jobInputDetails.value.trim() ||
      (action === "continue"
        ? "Resume the same FixLab session from its retained workflow state and continue the remaining required stages."
        : "");
    if (!details) {
      throw new Error("Enter the additional details or manual result.");
    }
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        details
      })
    });
    jobInputDetails.value = "";
    jobInputMessage.textContent =
      body.queued
        ? "Comment queued for the current session."
        : "Input accepted. FixLab resumed the same session.";
    renderJob(body.job);
  } catch (error) {
    formError.textContent = error.message;
    jobInputSubmit.disabled = false;
  }
});

dismissFailedJobButton.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  if (
    !window.confirm(
      `Dismiss this ${activeJob?.status === "blocked" ? "blocked" : "failed"} job? It will remain ${activeJob?.status === "blocked" ? "blocked" : "failed"} in dashboard history, its session will not resume, and the next queued job will start.`
    )
  ) {
    return;
  }
  dismissFailedJobButton.disabled = true;
  try {
    const body = await fetchJson("/api/job/dismiss", {
      method: "POST"
    });
    jobInputMessage.textContent = body.job
      ? "Job dismissed. The next queued job has started."
      : "Job dismissed. The queue is empty.";
    if (body.dismissedJob) {
      rememberJob(body.dismissedJob);
    }
    activeJob = body.job;
    selectedJobId = body.job?.id ?? body.dismissedJob?.id ?? null;
    if (body.job) {
      rememberJob(body.job);
    }
    renderJob(body.job, activeJob);
    renderQueue(activeJob, body.queue, body.held, body.history);
    await refreshMetrics();
  } catch (error) {
    formError.textContent = error.message;
    dismissFailedJobButton.disabled = false;
  }
});

openManualLocalhostButton.addEventListener("click", () => {
  formError.textContent = "";
  const url = activeJob?.manualLocalhostUrl;
  if (!url) {
    formError.textContent =
      "The repository profile does not provide a React localhost URL.";
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    formError.textContent =
      "The browser blocked the localhost tab. Allow pop-ups and try again.";
  }
});

async function submitManualLocalhostResult(passed) {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  passManualLocalhostButton.disabled = true;
  failManualLocalhostButton.disabled = true;
  try {
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: passed ? "manual-pass" : "manual-fail"
      })
    });
    jobInputMessage.textContent = passed
      ? "Manual localhost validation passed. FixLab is closing the gate."
      : "Manual localhost validation failed. FixLab is recording the failure and stopping its frontend.";
    activeJob = body.job;
    selectedJobId = body.job?.id ?? selectedJobId;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
  } catch (error) {
    formError.textContent = error.message;
    passManualLocalhostButton.disabled = false;
    failManualLocalhostButton.disabled = false;
  }
}

passManualLocalhostButton.addEventListener("click", () =>
  submitManualLocalhostResult(true)
);
failManualLocalhostButton.addEventListener("click", () =>
  submitManualLocalhostResult(false)
);

async function retryLiveTest() {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  retryLiveTestButton.disabled = true;
  try {
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "retry",
        details:
          "Reuse the repository-profile-defined browser authentication and all completed diagnosis, fix, review, and local validation evidence. Rerun only the blocked Playwright live-test gate using the profile-defined browser and test command, save at least one non-sensitive screenshot under the profile-defined working directory's test-results folder, emit the terminal live-test result, and continue to pull-request creation. Do not skip the live-test or PR stage."
      })
    });
    jobInputMessage.textContent =
      "Playwright retry started in the same FixLab session.";
    activeJob = body.job;
    selectedJobId = body.job?.id ?? selectedJobId;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
  } catch (error) {
    formError.textContent = error.message;
    retryLiveTestButton.disabled = false;
  }
}

retryLiveTestButton.addEventListener("click", retryLiveTest);

connectRetryLiveTestButton.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  connectRetryLiveTestButton.disabled = true;
  try {
    pendingRetryAfterConnectJobId = activeJob?.id ?? null;
    await startFrontend();
    renderPlaywrightStatus(
      await fetchJson("/api/playwright/connect", { method: "POST" })
    );
    jobInputMessage.textContent =
      "Sign in in the Edge window that opened. FixLab retries the live test automatically when authentication completes.";
  } catch (error) {
    pendingRetryAfterConnectJobId = null;
    formError.textContent = error.message;
    connectRetryLiveTestButton.disabled = false;
    await refreshPlaywrightStatus();
  }
});

skipLiveTestButton.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  skipLiveTestButton.disabled = true;
  try {
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "skip",
        details:
          "The user explicitly chose to skip only the blocked authenticated Playwright live-test gate. Mark live-test skipped, preserve the exact unverified browser risk and missing screenshot evidence, do not report it as passed, and continue the safe pull-request outcome according to repository policy without repeating completed work."
      })
    });

    jobInputMessage.textContent =
      "Playwright live test skipped with risk preserved.";
    activeJob = body.job;
    selectedJobId = body.job?.id ?? selectedJobId;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
  } catch (error) {
    formError.textContent = error.message;
    skipLiveTestButton.disabled = false;
  }
});

approvePullRequestButton.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  approvePullRequestButton.disabled = true;
  try {
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "continue",
        details:
          "I explicitly approve creating or updating the pull request for the validated fixes in this FixLab job. Reuse the existing configured user-owned branch and all completed evidence. Do not repeat diagnosis, builds, or Playwright unless a new change requires validation. Create no deployment."
      })
    });
    jobInputMessage.textContent =
      "Pull-request approval accepted. FixLab is creating or updating the PR.";
    activeJob = body.job;
    selectedJobId = body.job?.id ?? selectedJobId;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
  } catch (error) {
    formError.textContent = error.message;
    approvePullRequestButton.disabled = false;
  }
});

playwrightCheck.addEventListener("click", refreshPlaywrightStatus);
playwrightEvidenceRefresh.addEventListener(
  "click",
  refreshPlaywrightEvidence
);

playwrightConnect.addEventListener("click", async () => {
  formError.textContent = "";
  playwrightConnect.disabled = true;
  try {
    await startFrontend();
    renderPlaywrightStatus(
      await fetchJson("/api/playwright/connect", { method: "POST" })
    );
  } catch (error) {
    formError.textContent = error.message;
    await refreshPlaywrightStatus();
  }
});

onboardingSave.addEventListener("click", async () => {
  onboardingSave.disabled = true;
  onboardingMessage.textContent = "";
  try {
    const body = await fetchJson("/api/onboarding/azure-devops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organization: onboardingOrganization.value,
        project: onboardingProject.value
      })
    });
    onboardingOrganization.value = body.azureDevOps.organization;
    onboardingProject.value = body.azureDevOps.project;
    onboardingStatus.className = "badge passed";
    onboardingStatus.textContent = "Configured";
    onboardingMessage.textContent =
      "Onboarding settings saved. Numeric bug loading is ready.";
  } catch (error) {
    onboardingStatus.className = "badge blocked";
    onboardingStatus.textContent = "Save failed";
    onboardingMessage.textContent = error.message;
  } finally {
    onboardingSave.disabled = false;
  }
});

refresh();
refreshMetrics();
refreshPlaywrightStatus();
refreshFrontendStatus();
refreshPlaywrightEvidence();
refreshOnboarding();
setInterval(refresh, 1000);
setInterval(refreshMetrics, 5000);
setInterval(refreshPlaywrightStatus, 5000);
setInterval(refreshFrontendStatus, 5000);
void refreshSessions();
setInterval(refreshSessions, 5000);
setInterval(refreshPlaywrightEvidence, 10000);
