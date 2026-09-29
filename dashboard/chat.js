import { clearLine, createInterface, cursorTo } from "node:readline";

const DEFAULT_LOG_COUNT = 20;
const MAX_LOG_COUNT = 100;

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(Number(milliseconds ?? 0) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${minutes}m`;
}

export function formatChatHelp() {
  return `Commands:
  /status              Show the current job and stage state.
  /logs [count]        Show the most recent logs (default ${DEFAULT_LOG_COUNT}).
  /evidence            List Playwright screenshots and videos.
  /pr                  Show pull-request readiness and known PR links.
  /retry [guidance]    Retry a failed or blocked job.
  /continue [guidance] Continue a blocked or completed job.
  /skip [reason]       Resume while recording an explicitly skipped gate.
  /stop                Stop the owned executor and leave the job resumable.
  /help                Show these commands.
  /exit                Leave chat without stopping the job.

Any other text is sent to the same FixLab session as a comment while it is
running, or as continue guidance while it is blocked, failed, or completed.`;
}

export function parseNaturalChatCommand(line) {
  const normalized = line.trim();
  const lower = normalized.toLowerCase();
  if (/^(?:open|show|start)(?: the)? dashboard$/u.test(lower)) {
    return { command: "/dashboard", details: "" };
  }
  if (/^(?:show|check|get)(?: the)? status$/u.test(lower)) {
    return { command: "/status", details: "" };
  }
  const logs = lower.match(
    /^(?:show|view|tail)(?: the)? logs(?:\s+(\d+))?$/u
  );
  if (logs) {
    return { command: "/logs", details: logs[1] ?? "" };
  }
  if (
    /^(?:show|open|check)(?: the)? (?:pr|pull request)$/u.test(lower)
  ) {
    return { command: "/pr", details: "" };
  }
  if (
    /^(?:show|list|open)(?: the)? (?:evidence|screenshots|playwright evidence)$/u.test(
      lower
    )
  ) {
    return { command: "/evidence", details: "" };
  }
  const repository = normalized.match(
    /^(?:switch|change)(?: the)? repo(?:sitory)?(?:\s+to)?(?:\s+(.+))?$/iu
  );
  if (repository) {
    return {
      command: "/repository",
      details: repository[1]?.trim() ?? ""
    };
  }
  if (/^(?:help|show help|what can i do)\??$/u.test(lower)) {
    return { command: "/help", details: "" };
  }
  return null;
}

export function formatJobStatus(job) {
  if (!job) {
    return "No FixLab job is available.";
  }
  const lines = [
    `Job ${job.id}: ${job.status} (${formatDuration(job.durationMs)})`,
    `Request: ${job.request}`,
    `PR readiness: ${job.pullRequestReadiness?.message ?? "unknown"}`
  ];
  for (const [stage, result] of Object.entries(job.stages ?? {})) {
    lines.push(
      `  ${stage}: ${result.status}${result.message ? ` - ${result.message}` : ""}`
    );
  }
  if (job.error) {
    lines.push(`Error: ${job.error}`);
  }
  return lines.join("\n");
}

function pullRequestSummary(job) {
  if (!job) {
    return "No FixLab job is available.";
  }
  const text = [
    job.stages?.pr?.message,
    job.pullRequestReadiness?.message,
    ...(job.activity ?? []).map((entry) => entry.message),
    ...(job.logs ?? []).map((entry) => entry.message)
  ]
    .filter(Boolean)
    .join("\n");
  const urls = [
    ...new Set(
      text.match(
        /https:\/\/(?:dev\.azure\.com|github\.com)\/[^\s<>"')\]]+/gi
      ) ?? []
    )
  ];
  return [
    `PR stage: ${job.stages?.pr?.status ?? "unknown"}${
      job.stages?.pr?.message ? ` - ${job.stages.pr.message}` : ""
    }`,
    `Readiness: ${job.pullRequestReadiness?.message ?? "unknown"}`,
    ...(urls.length > 0 ? urls : ["No PR URL has been reported yet."])
  ].join("\n");
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with HTTP ${response.status}`);
  }
  return body;
}

export async function runChat({
  baseUrl,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = 1000,
  recoverConnection,
  selectRepository,
  switchRepository,
  openDashboard
}) {
  let dashboardUrl = baseUrl;
  let currentJob = null;
  let currentReadiness = null;
  let lastJobId = null;
  let lastLogIndex = -1;
  let lastStatus = "";
  let closed = false;
  let polling = false;
  let interactive = false;
  let handlingLine = false;
  let readline;
  const writeMessage = (stream, message = "") => {
    if (interactive && readline && !handlingLine && !closed) {
      clearLine(output, 0);
      cursorTo(output, 0);
      stream.write(`${message}\n`);
      readline.prompt(true);
      return;
    }
    stream.write(`${message}\n`);
  };
  const write = (message = "") => writeMessage(output, message);
  const writeError = (message) => writeMessage(errorOutput, message);

  const loadStatus = async ({ announce = false } = {}) => {
    const body = await requestJson(fetchImpl, `${dashboardUrl}/api/status`);
    currentJob = body.job;
    currentReadiness = body.readiness ?? null;
    if (!currentJob) {
      if (announce) {
        write("No FixLab job is available. Start one in the dashboard first.");
      }
      return null;
    }
    if (currentJob.id !== lastJobId) {
      lastJobId = currentJob.id;
      lastLogIndex = Math.max(
        -1,
        ...(currentJob.logs ?? []).map((entry) => Number(entry.index))
      );
      lastStatus = currentJob.status;
      write(formatJobStatus(currentJob));
      return currentJob;
    }
    for (const entry of currentJob.logs ?? []) {
      if (Number(entry.index) <= lastLogIndex || !entry.message) {
        continue;
      }
      write(`[${entry.stream}] ${entry.message}`);
      lastLogIndex = Number(entry.index);
    }
    if (currentJob.status !== lastStatus) {
      write(`[status] ${lastStatus} -> ${currentJob.status}`);
      lastStatus = currentJob.status;
    }
    if (announce) {
      write(formatJobStatus(currentJob));
    }
    return currentJob;
  };

  const submitInput = async (action, details) => {
    const body = await requestJson(fetchImpl, `${dashboardUrl}/api/job/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, details })
    });
    currentJob = body.job;
    write(
      body.queued
        ? "Guidance queued for the same session after the current agent turn."
        : "Guidance accepted; the same FixLab session is resuming."
    );
  };

  try {
    await loadStatus();
  } catch (error) {
    if (recoverConnection) {
      try {
        dashboardUrl =
          (await recoverConnection({ baseUrl: dashboardUrl, error })) ??
          dashboardUrl;
        await loadStatus();
      } catch (recoveryError) {
        writeError(
          `Cannot connect to the FixLab dashboard at ${dashboardUrl}: ${recoveryError.message}`
        );
        return 1;
      }
    } else {
      writeError(
        `Cannot connect to the FixLab dashboard at ${dashboardUrl}: ${error.message}`
      );
      return 1;
    }
  }

  if (selectRepository) {
    try {
      const selectedUrl = await selectRepository({
        baseUrl: dashboardUrl,
        readiness: currentReadiness
      });
      if (selectedUrl && selectedUrl !== dashboardUrl) {
        dashboardUrl = selectedUrl;
        currentJob = null;
        currentReadiness = null;
        lastJobId = null;
        lastLogIndex = -1;
        lastStatus = "";
        await loadStatus();
      }
    } catch (error) {
      writeError(`Cannot select the FixLab repository: ${error.message}`);
      return 1;
    }
  }

  if (currentReadiness?.repository) {
    write(`FixLab repository: ${currentReadiness.repository}`);
  }
  write("FixLab chat is connected. Type /help for commands.");
  interactive = Boolean(input.isTTY && output.isTTY);
  readline = createInterface({
    input,
    output: interactive ? output : undefined,
    terminal: interactive,
    prompt: "fixlab> "
  });

  const poll = async () => {
    if (closed || polling || handlingLine) {
      return;
    }
    polling = true;
    try {
      await loadStatus();
    } catch (error) {
      writeError(`Dashboard polling failed: ${error.message}`);
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(poll, pollIntervalMs);
  timer.unref?.();

  const handleLine = async (rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    const naturalCommand = parseNaturalChatCommand(line);
    const [typedCommand, ...remainder] = line.split(/\s+/);
    const command = naturalCommand?.command ?? typedCommand;
    const details =
      naturalCommand?.details ?? remainder.join(" ").trim();
    if (command === "/help") {
      write(formatChatHelp());
      return;
    }
    if (command === "/exit" || command === "/quit") {
      readline.close();
      return;
    }
    if (command === "/status") {
      await loadStatus({ announce: true });
      return;
    }
    if (command === "/dashboard") {
      if (openDashboard) {
        await openDashboard({ baseUrl: dashboardUrl });
        write(`Opened FixLab dashboard: ${dashboardUrl}`);
      } else {
        write(`FixLab dashboard: ${dashboardUrl}`);
      }
      return;
    }
    if (command === "/repository") {
      if (!switchRepository) {
        write("Repository switching is unavailable in this FixLab chat.");
        return;
      }
      const selectedUrl = await switchRepository({
        baseUrl: dashboardUrl,
        readiness: currentReadiness,
        repository: details
      });
      if (selectedUrl && selectedUrl !== dashboardUrl) {
        dashboardUrl = selectedUrl;
        currentJob = null;
        currentReadiness = null;
        lastJobId = null;
        lastLogIndex = -1;
        lastStatus = "";
        await loadStatus();
      }
      if (currentReadiness?.repository) {
        write(`FixLab repository: ${currentReadiness.repository}`);
      }
      return;
    }
    if (command === "/logs") {
      await loadStatus();
      const requested = Number.parseInt(details, 10);
      const count = Number.isInteger(requested)
        ? Math.min(MAX_LOG_COUNT, Math.max(1, requested))
        : DEFAULT_LOG_COUNT;
      for (const entry of (currentJob?.logs ?? []).slice(-count)) {
        write(`[${entry.stream}] ${entry.message}`);
      }
      return;
    }
    if (command === "/evidence") {
      if (!currentJob) {
        write("No FixLab job is available.");
        return;
      }
      const body = await requestJson(
        fetchImpl,
        `${dashboardUrl}/api/playwright/artifacts?jobId=${encodeURIComponent(
          currentJob.id
        )}`
      );
      if (body.artifacts.length === 0) {
        write("No Playwright evidence is available yet.");
        return;
      }
      for (const artifact of body.artifacts) {
        write(`${artifact.kind}: ${artifact.relativePath} (${artifact.url})`);
      }
      return;
    }
    if (command === "/pr") {
      await loadStatus();
      write(pullRequestSummary(currentJob));
      return;
    }
    if (command === "/stop") {
      await requestJson(fetchImpl, `${dashboardUrl}/api/job/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      write("Stop requested for the FixLab-owned executor.");
      return;
    }
    if (["/retry", "/continue", "/skip"].includes(command)) {
      await submitInput(
        command.slice(1),
        details || `${command.slice(1)} requested from FixLab chat`
      );
      return;
    }
    await loadStatus();
    await submitInput(
      currentJob?.status === "running" ? "comment" : "continue",
      line
    );
  };

  let lineQueue = Promise.resolve();
  readline.on("line", (line) => {
    lineQueue = lineQueue
      .then(async () => {
        handlingLine = true;
        try {
          await handleLine(line);
        } finally {
          handlingLine = false;
        }
      })
      .catch((error) => writeError(error.message))
      .finally(() => {
        if (!closed && interactive) {
          readline.prompt();
        }
      });
  });

  if (interactive) {
    readline.prompt();
  }
  await new Promise((resolve) => readline.once("close", resolve));
  closed = true;
  clearInterval(timer);
  await lineQueue;
  write("FixLab chat disconnected. The dashboard job continues.");
  return 0;
}
