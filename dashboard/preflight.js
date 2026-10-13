import { spawnSync } from "node:child_process";

const TOOLS = new Set(["npm", "pnpm", "yarn", "dotnet"]);
const DEFAULT_PROBE_TIMEOUT_MS = 30000;
const MIN_PROBE_TIMEOUT_MS = 1000;
const MAX_PROBE_TIMEOUT_MS = 600000;

export function probeTimeoutMs(env = process.env) {
  const parsed = Number(env.FIXLAB_DOCTOR_TIMEOUT_MS);
  return Number.isInteger(parsed) &&
    parsed >= MIN_PROBE_TIMEOUT_MS &&
    parsed <= MAX_PROBE_TIMEOUT_MS
    ? parsed
    : DEFAULT_PROBE_TIMEOUT_MS;
}

export function resolveOnPath(
  command,
  { platform = process.platform, spawn = spawnSync } = {}
) {
  const lookup = spawn(
    platform === "win32" ? "where.exe" : "which",
    [command],
    { encoding: "utf8", shell: false, timeout: 5000, windowsHide: true }
  );
  return lookup.status === 0 && Boolean(lookup.stdout?.trim());
}

function leadingTool(command) {
  if (typeof command !== "string") {
    return null;
  }
  const match = command.match(/^\s*([A-Za-z][\w-]*)(?:\.(?:cmd|exe))?\b/);
  const tool = match?.[1].toLowerCase();
  return tool && TOOLS.has(tool) ? tool : null;
}

// Offline checks only: nothing here contacts the application, DEV, or the network.
export function runJobPreflight({ profile, resolve = resolveOnPath } = {}) {
  const commands = [
    profile?.validation?.commands?.frontendRestore,
    profile?.validation?.commands?.backendRestore,
    profile?.applications?.frontend?.command,
    profile?.applications?.backend?.command
  ];
  const tools = [...new Set(commands.map(leadingTool).filter(Boolean))];
  return tools
    .filter((tool) => !resolve(tool))
    .map((tool) => ({
      check: `${tool} on PATH`,
      detail: `${tool} is required by the repository profile but was not found on PATH. Install it, open a new shell, and restart the dashboard from that shell.`
    }));
}

export function formatPreflightFailure(issues) {
  return `Preflight failed: ${issues
    .map((issue) => `${issue.check} (${issue.detail})`)
    .join("; ")}`;
}
