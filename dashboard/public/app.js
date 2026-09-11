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
    const body = await fetchJson("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: data.get("request"),
        requestType: data.get("requestType"),
        mode: data.get("mode")
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
