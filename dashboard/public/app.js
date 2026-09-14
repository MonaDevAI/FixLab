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
const logsElement = document.querySelector("#logs");
const azureDevOpsIntake = document.querySelector("#azure-devops-intake");
const workItemInput = document.querySelector("#work-item");
const loadWorkItemButton = document.querySelector("#load-work-item");
const workItemSummary = document.querySelector("#work-item-summary");
const requestInput = document.querySelector("#request");
const screenshotInput = document.querySelector("#screenshots");
const screenshotList = document.querySelector("#screenshot-list");
let loadedWorkItem = null;

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

function renderReadiness(readiness) {
  const ready = readiness.repositoryReady && readiness.profileReady;
  readinessElement.className = `readiness ${ready ? "ready" : "blocked"}`;
  readinessElement.textContent = ready
    ? `Ready: ${readiness.profileName || readiness.repository}`
    : `Not ready: ${readiness.error}`;
  startButton.disabled = !ready;
}

function renderJob(job) {
  const running = job?.status === "running";
  startButton.disabled =
    running || readinessElement.classList.contains("blocked");
  jobStatusElement.textContent = job
    ? `${job.status} · ${job.requestType}`
    : "Not started";
  jobStatusElement.className = `badge ${job?.status ?? ""}`;

  stagesElement.replaceChildren();
  for (const name of stageNames) {
    const stage = job?.stages?.[name] ?? { status: "pending", message: "" };
    const card = document.createElement("article");
    card.className = `stage ${stage.status}`;
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = name;
    const status = document.createElement("span");
    status.textContent = stage.status;
    heading.append(title, status);
    const message = document.createElement("p");
    message.textContent = escapeText(stage.message) || "Waiting";
    card.append(heading, message);
    stagesElement.append(card);
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

function renderWorkItem(workItem) {
  workItemSummary.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = `#${workItem.id} · ${workItem.workItemType || "Work item"} · ${workItem.title}`;
  const details = document.createElement("p");
  details.textContent = `State: ${workItem.state || "Unknown"}`;
  const link = document.createElement("a");
  link.href = workItem.webUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Open in Azure DevOps";
  workItemSummary.append(title, details, link);
  workItemSummary.hidden = false;
}

function workItemRequest(workItem) {
  return [
    `Azure DevOps work item ${workItem.id}: ${workItem.title}`,
    workItem.workItemType ? `Type: ${workItem.workItemType}` : "",
    workItem.state ? `State: ${workItem.state}` : "",
    workItem.description ? `Description:\n${workItem.description}` : "",
    workItem.reproduction ? `Reproduction:\n${workItem.reproduction}` : "",
    workItem.acceptanceCriteria
      ? `Acceptance criteria:\n${workItem.acceptanceCriteria}`
      : "",
    workItem.webUrl ? `Work item: ${workItem.webUrl}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function validateSelectedScreenshots() {
  const files = [...screenshotInput.files];
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

document.querySelectorAll("input[name='intakeSource']").forEach((input) => {
  input.addEventListener("change", () => {
    azureDevOpsIntake.hidden = selectedIntakeSource() !== "azure-devops";
  });
});

loadWorkItemButton.addEventListener("click", async () => {
  formError.textContent = "";
  loadWorkItemButton.disabled = true;
  try {
    const body = await fetchJson("/api/azure-devops/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItem: workItemInput.value })
    });
    loadedWorkItem = body.workItem;
    renderWorkItem(loadedWorkItem);
    requestInput.value = workItemRequest(loadedWorkItem).slice(0, 10000);
  } catch (error) {
    loadedWorkItem = null;
    workItemSummary.hidden = true;
    formError.textContent = error.message;
  } finally {
    loadWorkItemButton.disabled = false;
  }
});

screenshotInput.addEventListener("change", () => {
  formError.textContent = "";
  screenshotList.replaceChildren();
  try {
    const files = validateSelectedScreenshots();
    for (const file of files) {
      const item = document.createElement("li");
      item.textContent = `${file.name} (${Math.ceil(file.size / 1024)} KiB)`;
      screenshotList.append(item);
    }
  } catch (error) {
    screenshotInput.value = "";
    formError.textContent = error.message;
  }
});

async function refresh() {
  try {
    const body = await fetchJson("/api/status");
    renderReadiness(body.readiness);
    renderJob(body.job);
  } catch (error) {
    formError.textContent = error.message;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  startButton.disabled = true;
  try {
    const data = new FormData(form);
    const intakeSource = data.get("intakeSource");
    if (intakeSource === "azure-devops" && !loadedWorkItem) {
      throw new Error("Load an Azure DevOps work item before starting.");
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
        intakeSource,
        workItem: intakeSource === "azure-devops" ? loadedWorkItem : null,
        screenshots
      })
    });
    renderJob(body.job);
  } catch (error) {
    formError.textContent = error.message;
    startButton.disabled = false;
  }
});

refresh();
setInterval(refresh, 1000);
