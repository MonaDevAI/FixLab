import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function contained(root, path) {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function browserProcesses() {
  const windows = process.platform === "win32";
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rows = @()
foreach ($p in Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe' OR Name='chromium.exe'") {
  if ($p.CommandLine -notmatch '--user-data-dir' -or $p.CommandLine -match '--type=') { continue }
  $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0) { throw 'Cannot verify browser ownership' }
  if ($owner.Sid -eq $sid) { $rows += @{ pid = $p.ProcessId; commandLine = $p.CommandLine } }
}
ConvertTo-Json -Compress -InputObject @($rows)`;
  const result = spawnSync(windows ? "powershell.exe" : "ps",
    windows ? ["-NoProfile", "-NonInteractive", "-Command", script]
      : ["-u", String(process.getuid()), "-o", "pid=,args="],
    { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 512 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error("Cannot verify browser-profile ownership; no browser or agent was started.");
  }
  if (windows) {
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      throw new Error("Cannot parse browser-profile ownership metadata; no browser or agent was started.");
    }
  }
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && /^(?:"[^"]*(?:chrome|chromium|msedge)[^"]*"|\S*(?:chrome|chromium|msedge)\S*)(?:\s|$)/i.test(match[2])
      ? [{ pid: Number(match[1]), commandLine: match[2] }] : [];
  });
}

export function inspectBrowserProfileOwnership(configuration, { query = browserProcesses } = {}) {
  const root = realpathSync(configuration.workingDirectory);
  const directories = [];
  for (const value of configuration.statusPaths) {
    const path = resolve(root, value);
    if (!contained(root, path)) {
      throw new Error("Browser authentication status paths must stay within their configured working directory.");
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      continue;
    }
    const actual = realpathSync(path);
    if (!contained(root, actual)) {
      throw new Error("Browser authentication profile resolves outside its configured working directory.");
    }
    directories.push(actual);
  }
  if (!directories.length) {
    return null;
  }
  const records = query();
  if (!Array.isArray(records) || records.length > 256 ||
      records.some((record) => !record || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
        typeof record.commandLine !== "string")) {
    throw new Error("Browser-profile ownership inspection returned invalid process metadata.");
  }
  const owners = new Set();
  for (const record of records) {
    const match = record.commandLine.match(/--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    if (!match || /--type=/.test(record.commandLine)) {
      continue;
    }
    const path = match[1] ?? match[2] ?? match[3];
    if (!isAbsolute(path) || !existsSync(path)) {
      continue;
    }
    const actual = realpathSync(path);
    if (directories.includes(actual)) {
      owners.add(record.pid);
    }
  }
  return owners.size ? {
    kind: "browser-profile-busy",
    pids: [...owners],
    message: `The configured authentication browser profile is already in use by browser PID(s) ${[...owners].join(", ")}. Close the previous test browser after preserving any unsaved form data, then retry. No process was stopped. Repeating approval or confirming readiness cannot release a live profile lock.`
  } : null;
}
