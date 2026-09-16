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
const stagesElement = document.querySelector("#stages");
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
const bugResultsPanel = document.querySelector("#bug-results-panel");
const bugResultsElement = document.querySelector("#bug-results");
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
const jobInputPanel = document.querySelector("#job-input-panel");
const jobInputTitle = document.querySelector("#job-input-title");
const jobInputCount = document.querySelector("#job-input-count");
const jobInputGuidance = document.querySelector("#job-input-guidance");
const jobInputAction = document.querySelector("#job-input-action");
const jobInputDetails = document.querySelector("#job-input-details");
const jobInputSubmit = document.querySelector("#job-input-submit");
const jobInputMessage = document.querySelector("#job-input-message");
const retryLiveTestButton = document.createElement("button");
retryLiveTestButton.id = "retry-live-test";
retryLiveTestButton.type = "button";
retryLiveTestButton.textContent = "Retry Playwright live test";
retryLiveTestButton.hidden = true;
const skipLiveTestButton = document.createElement("button");
skipLiveTestButton.id = "skip-live-test";
skipLiveTestButton.type = "button";
skipLiveTestButton.className = "secondary";
skipLiveTestButton.textContent = "Skip Playwright live test";
skipLiveTestButton.hidden = true;
const approvePullRequestButton = document.createElement("button");
approvePullRequestButton.id = "approve-pull-request";
approvePullRequestButton.type = "button";
approvePullRequestButton.textContent = "Approve and create PR";
approvePullRequestButton.hidden = true;
jobInputSubmit.before(
  retryLiveTestButton,
  skipLiveTestButton,
  approvePullRequestButton
);
const playwrightStatus = document.querySelector("#playwright-status");
const playwrightGuidance = document.querySelector("#playwright-guidance");
const playwrightCheck = document.querySelector("#playwright-check");
const playwrightConnect = document.querySelector("#playwright-connect");
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
    <h3 id="playwright-evidence-title">Selected job Playwright screenshot</h3>
    <button id="playwright-evidence-refresh" type="button">Refresh screenshots</button>
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
let screenshotPreviewUrls = [];
let activeJob = null;
let selectedJobId = null;
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
  jobStatusElement.textContent = job
    ? `${job.status} · ${job.requestType} · ${formatDuration(job.durationMs)}`
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
      `${bugIdentity} · Playwright screenshot`;
    playwrightEvidenceGuidance.textContent = job?.id
      ? "Checking this job's safe Playwright screenshots."
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

  const canResume = isActive && Boolean(job?.canResume);
  const canComment = isActive && Boolean(job?.canComment);
  const canRetryLiveTest =
    canResume &&
    job?.status === "blocked" &&
    job?.stages?.["live-test"]?.status === "blocked" &&
    !job?.holdForManualLiveTest;
  const canApprovePullRequest =
    canResume &&
    job?.pullRequestReadiness?.status === "approval-required";
  jobInputPanel.hidden = !(canResume || canComment);
  jobInputSubmit.disabled = !(canResume || canComment);
  retryLiveTestButton.hidden = !canRetryLiveTest;
  retryLiveTestButton.disabled = !canRetryLiveTest;
  skipLiveTestButton.hidden = !canRetryLiveTest;
  skipLiveTestButton.disabled = !canRetryLiveTest;
  approvePullRequestButton.hidden = !canApprovePullRequest;
  approvePullRequestButton.disabled = !canApprovePullRequest;
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
          : job?.holdForManualLiveTest &&
              job?.stages?.["live-test"]?.status === "blocked"
            ? `Automated Playwright is complete. Test the local application at ${job.manualLiveTestUrl || "the profile-defined URL"}, then select Continue and provide the manual result.`
          : job?.stages?.["live-test"]?.status === "blocked"
          ? "The browser gate could not finish. Retry reuses saved authentication and runs only Playwright; Skip records the missing browser evidence and continues under repository PR policy."
          : "Provide the missing authentication, safe data, approval, or manual result, then resume the same FixLab session.";
    } else if (job.status === "failed") {
      jobInputTitle.textContent = "Retry or correct this job";
      jobInputGuidance.textContent =
        "Add the information needed to correct the failure without repeating completed work.";
    } else {
      jobInputTitle.textContent = "Add details or update the existing PR";
      jobInputGuidance.textContent =
        "Continue this completed session with one focused addition. FixLab reuses its evidence, branch, and pull request.";
    }
  }
}

function renderPlaywrightStatus(status) {
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
  const pathSummary = status.paths
    .map((entry) => `${entry.ready ? "ready" : "missing"}: ${entry.path}`)
    .join(" · ");
  playwrightGuidance.textContent =
    status.error ||
    status.lastResult?.message ||
    pathSummary ||
    "Add browserAutomation.authentication to the repository profile.";
}

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
        ? `${body.artifacts.length} screenshot(s) for this job`
        : "No safe screenshot exists for this job yet. This updates automatically while Playwright runs.";
    for (const artifact of body.artifacts) {
      const link = document.createElement("a");
      link.href = artifact.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      const image = document.createElement("img");
      image.src = artifact.url;
      image.alt = `Playwright evidence: ${artifact.name}`;
      const caption = document.createElement("span");
      caption.textContent = artifact.relativePath;
      link.append(image, caption);
      playwrightEvidenceList.append(link);
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

function renderQueue(currentJob, queue = [], history = []) {
  rememberJob(currentJob);
  for (const job of history) {
    rememberJob(job);
  }
  for (const job of queue) {
    if (!observedJobs.has(job.id)) {
      observedJobs.set(job.id, queuedJobView(job));
    }
  }
  const queuedIds = new Set(queue.map((job) => job.id));
  const recentJobs = [...observedJobs.values()]
    .filter(
      (job) =>
        job.id !== currentJob?.id &&
        !queuedIds.has(job.id)
    )
    .reverse();
  const entries = [
    ...(currentJob ? [{ job: currentJob, label: "Current" }] : []),
    ...queue.map((job) => ({
      job: observedJobs.get(job.id),
      label: `Waiting #${job.position}`
    })),
    ...recentJobs.map((job) => ({ job, label: "Recent" }))
  ];

  queuePanel.hidden = entries.length < 2;
  queuePanel.querySelector("h3").textContent = "Jobs";
  queueCount.textContent =
    `${queue.length} waiting · ${recentJobs.length} recent`;
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
      renderQueue(currentJob, queue, history);
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
      : `${metrics.totalCachedInputTokens.toLocaleString()} (${metrics.cacheReusePercent.toFixed(1)}%)`;
  metricCacheReuse.title =
    metrics.cacheReusePercent === null
      ? "No exact runtime usage has been recorded for this period."
      : `${metrics.totalCachedInputTokens.toLocaleString()} of ${metrics.totalInputTokens.toLocaleString()} input tokens were reused from cache.`;
  metricStatuses.textContent =
    warning ||
    `${metrics.passed} passed · ${metrics.failed} failed · ${metrics.blocked} blocked · exact usage available for ${metrics.usageJobs} completed job(s)`;
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
  for (const url of screenshotPreviewUrls) {
    URL.revokeObjectURL(url);
  }
  screenshotPreviewUrls = [];
  screenshotList.replaceChildren();
  for (const file of selectedScreenshots) {
    const item = document.createElement("li");
    const preview = document.createElement("img");
    const previewUrl = URL.createObjectURL(file);
    screenshotPreviewUrls.push(previewUrl);
    preview.src = previewUrl;
    preview.alt = `Preview of ${file.name}`;
    const label = document.createElement("span");
    label.textContent = `${file.name} (${Math.ceil(file.size / 1024)} KiB)`;
    item.append(preview, label);
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
    if (!selectedJobId || !observedJobs.has(selectedJobId)) {
      selectedJobId = activeJob?.id ?? null;
    }
    renderReadiness(body.readiness);
    renderJob(observedJobs.get(selectedJobId) ?? activeJob, activeJob);
    renderQueue(activeJob, body.queue, body.history);
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
        mode: data.get("mode"),
        pullRequestStrategy: data.get("separatePullRequests") === "on"
          ? "per-bug"
          : "common",
        runAllUiScenarios: data.get("runAllUiScenarios") === "on",
        holdForManualLiveTest:
          data.get("holdForManualLiveTest") === "on",
        intakeSource,
        workItems: intakeSource === "azure-devops" ? loadedWorkItems : [],
        screenshots
      })
    });
    selectedScreenshots = [];
    renderScreenshots();
    showScreenshotResult("");
    activeJob = body.job;
    selectedJobId = body.job?.id ?? null;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
    renderQueue(activeJob, body.queue, body.history);
    await refreshMetrics();
  } catch (error) {
    formError.textContent = error.message;
    startButton.disabled = false;
  }
});

jobInputSubmit.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  jobInputSubmit.disabled = true;
  try {
    const details = jobInputDetails.value.trim();
    if (!details) {
      throw new Error("Enter the additional details or manual result.");
    }
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: jobInputAction.value,
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

retryLiveTestButton.addEventListener("click", async () => {
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
          "Reuse the saved authenticated Edge profile and all completed diagnosis, fix, review, and local validation evidence. Rerun only the blocked authenticated Playwright live-test gate with one worker, save at least one non-sensitive screenshot under ms.sap.fmdm.portal/test-results, emit the terminal live-test result, and continue to pull-request creation. Do not skip the live-test or PR stage."
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
refreshPlaywrightEvidence();
refreshOnboarding();
setInterval(refresh, 1000);
setInterval(refreshMetrics, 5000);
setInterval(refreshPlaywrightStatus, 5000);
setInterval(refreshPlaywrightEvidence, 10000);
