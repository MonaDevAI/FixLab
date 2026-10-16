import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dashboardConversation } from "./dashboard-client.js";

function notification(state) {
  const job = state.job;
  if (job.permissionRequest && !job.canReviewPermissions) {
    return null;
  }
  if (state.question || ["blocked", "failed"].includes(job.status)) {
    const reason = JSON.stringify({
      question: state.question,
      permission: job.permissionRequest,
      stages: Object.fromEntries(Object.entries(job.stages ?? {})
        .filter(([, stage]) => ["blocked", "failed"].includes(stage.status)))
    });
    return {
      kind: job.permissionRequest ? "permission-required" : "action-required",
      status: job.status,
      reason: createHash("sha256").update(reason).digest("hex")
    };
  }
  if (["passed", "scoped-complete"].includes(job.status)) {
    return { kind: "completed", status: job.status };
  }
  if (["held", "cancelled"].includes(job.status)) {
    return { kind: "stopped", status: job.status };
  }
  return null;
}

export function notificationPrompt(event) {
  return [
    "FixLab monitor event (operational metadata, NOT user authorization):",
    JSON.stringify(event),
    "Read fixlab_watch_status for fresh state before acting. Verify the repository, instance and job still match this event.",
    "For an actionable blocker, explain the exact prerequisite and ask the user through the host question UI. Never infer approval, retry automatically, pass a deferred gate, or broaden permissions.",
    "Use the existing identity-bound FixLab MCP reply/control tools only after explicit approval. If unavailable, direct the user to the dashboard; do not invent a permission route.",
    "For completion or a stopped monitor, report only verified outcomes. A scoped completion is not full validation or PR readiness. A changed job or dashboard is not proof the watched job succeeded."
  ].join("\n");
}

export function createJobMonitor({
  notify,
  onError,
  readState = dashboardConversation,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  intervalMs = 10000
}) {
  let binding = null;
  let active = false;
  let generation = 0;
  let timer = null;
  let lastState = null;
  let lastKey = null;
  let lastError = null;
  let failures = 0;

  function status() {
    return { active, binding: binding && { ...binding }, conversation: lastState, error: lastError };
  }

  function stop() {
    active = false;
    generation += 1;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    return status();
  }

  async function fail(message) {
    stop();
    lastError = message;
    try {
      await onError(message);
    } catch {
      process.stderr.write(`${message}\n`);
    }
  }

  async function deliver(event, currentGeneration) {
    if (!active || generation !== currentGeneration) {
      return;
    }
    const key = JSON.stringify(event);
    if (key === lastKey) {
      return;
    }
    try {
      await notify({ ...binding, ...event });
    } catch (error) {
      if (generation !== currentGeneration) {
        return;
      }
      await fail("FixLab notification delivery failed; monitoring stopped without retrying an ambiguously delivered prompt.");
      return;
    }
    if (generation === currentGeneration) {
      lastKey = key;
    }
  }

  function schedule(currentGeneration, delay = intervalMs) {
    if (!active || generation !== currentGeneration) {
      return;
    }
    timer = setTimer(() => {
      timer = null;
      return poll(currentGeneration).catch(async () => {
        if (generation === currentGeneration) {
          await fail("FixLab monitor failed; monitoring stopped. Read dashboard status before restarting it.");
        }
      });
    }, delay);
    timer?.unref?.();
  }

  async function poll(currentGeneration) {
    if (!active || generation !== currentGeneration) {
      return;
    }
    let state;
    try {
      state = await readState(binding);
    } catch (error) {
      if (!active || generation !== currentGeneration) {
        return;
      }
      failures += 1;
      if (failures >= 3) {
        await deliver({ kind: "connection-lost" }, currentGeneration);
        if (generation === currentGeneration) {
          await fail("FixLab monitor stopped after three consecutive failed status reads. Reconnect explicitly after checking dashboard availability.");
        }
      } else {
        schedule(currentGeneration, intervalMs * failures);
      }
      return;
    }
    if (!active || generation !== currentGeneration) {
      return;
    }
    failures = 0;
    if (state.instanceId !== binding.instanceId || state.job?.id !== binding.jobId ||
        realpathSync(state.repository) !== binding.repository) {
      await deliver({ kind: "watch-ended", reason: "Dashboard, repository or current job changed; no replacement was attached." }, currentGeneration);
      if (generation === currentGeneration) {
        stop();
      }
      return;
    }
    lastState = state;
    const event = notification(state);
    if (event) {
      await deliver(event, currentGeneration);
      if (generation === currentGeneration && ["completed", "stopped"].includes(event.kind)) {
        stop();
      }
    } else {
      lastKey = null;
    }
    schedule(currentGeneration);
  }

  async function start(args) {
    if (args.confirmed !== true) {
      throw new Error("Starting event-only Copilot notifications requires explicit user consent to event-triggered model turns.");
    }
    const requested = {
      repository: realpathSync(args.repository),
      port: args.port,
      instanceId: args.instanceId,
      jobId: args.jobId
    };
    if (active) {
      if (JSON.stringify(requested) === JSON.stringify(binding)) {
        return status();
      }
      throw new Error("A FixLab job is already watched; stop it explicitly before watching another job.");
    }
    const startingGeneration = generation;
    const state = await readState(requested);
    if (generation !== startingGeneration || active) {
      throw new Error("The monitor changed during startup; no new watch was attached.");
    }
    if (typeof requested.instanceId !== "string" || !requested.instanceId ||
        typeof requested.jobId !== "string" || !requested.jobId ||
        state.instanceId !== requested.instanceId || state.job?.id !== requested.jobId ||
        realpathSync(state.repository) !== requested.repository) {
      throw new Error("Use the current dashboard instance, repository and job IDs before starting notifications.");
    }
    binding = requested;
    lastState = state;
    lastKey = null;
    lastError = null;
    failures = 0;
    active = true;
    generation += 1;
    schedule(generation, 0);
    return status();
  }

  async function refresh() {
    if (!binding) {
      return status();
    }
    const currentGeneration = generation;
    const state = await readState(binding);
    if (generation === currentGeneration) {
      if (state.instanceId !== binding.instanceId || state.job?.id !== binding.jobId ||
          realpathSync(state.repository) !== binding.repository) {
        stop();
        lastState = null;
        throw new Error("The watched dashboard or job changed. Monitoring stopped; read current status before attaching another job.");
      }
      lastState = state;
    }
    return status();
  }

  return { start, stop, status, refresh };
}
