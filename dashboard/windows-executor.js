import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export function quoteWindowsArgument(value) {
  return `"${String(value)
    .replace(/(\\*)"/gu, (_match, slashes) => `${slashes}${slashes}\\"`)
    .replace(/(\\+)$/u, "$1$1")}"`;
}

export function spawnWindowsExecutor({
  executable,
  args,
  repository,
  commandLine,
  environment = {},
  retainDescendants = false
}) {
  if (!isAbsolute(executable)) {
    const lookup = spawnSync("where.exe", [executable], {
      encoding: "utf8", shell: false, windowsHide: true
    });
    const resolved = lookup.status === 0
      ? lookup.stdout.split(/\r?\n/).find((path) => isAbsolute(path) && /\.exe$/i.test(path))
      : null;
    if (!resolved) {
      throw new Error("Owned Windows execution requires an available direct executable.");
    }
    executable = resolved;
  }
  const directory = mkdtempSync(join(tmpdir(), "fixlab-windows-executor-"));
  const stopPath = join(directory, "stop");
  const proofPath = join(directory, "quiescent.json");
  const nonce = randomUUID();
  const source = fileURLToPath(new URL("./windows-executor.cs", import.meta.url));
  const config = Buffer.from(JSON.stringify({
    executable,
    commandLine: commandLine ?? [executable, ...args].map(quoteWindowsArgument).join(" "),
    repository,
    stopPath,
    proofPath,
    nonce,
    ownerPid: process.pid,
    retainDescendants
  })).toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -Path '${source.replaceAll("'", "''")}'`,
    `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json`,
    "exit [FixLab.WindowsExecutor]::Run($config.executable, $config.commandLine, $config.repository, $config.stopPath, $config.proofPath, $config.nonce, $config.retainDescendants, $config.ownerPid)"
  ].join("; ");
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
  );
  const child = spawn(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")
  ], {
    cwd: repository,
    env: { ...process.env, ...environment, BROWSER: "none" },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let confirmed = false;
  const cleanup = () => {
    for (const path of [stopPath, proofPath, `${proofPath}.tmp`]) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    rmdirSync(directory);
  };
  return {
    child,
    directory,
    hasStopped() {
      if (confirmed) {
        return true;
      }
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        return false;
      }
      if (child.pid) {
        let proof;
        try {
          const info = lstatSync(proofPath);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) {
            throw new Error("Invalid Windows executor termination proof");
          }
          proof = JSON.parse(readFileSync(proofPath, "utf8"));
        } catch (error) {
          if (error.code === "ENOENT") {
            return false;
          }
          throw error;
        }
        if (proof.nonce !== nonce || proof.pid !== child.pid || proof.quiescent !== true) {
          throw new Error("Windows executor termination proof does not match its owner");
        }
      }
      cleanup();
      confirmed = true;
      return true;
    },
    terminate() {
      if (child.exitCode === null && child.signalCode === null) {
        writeFileSync(stopPath, nonce, { mode: 0o600 });
      }
    },
    async waitForStopped() {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve, reject) => {
          child.once("exit", resolve);
          child.once("error", reject);
        });
      }
      if (!this.hasStopped()) {
        throw new Error("Windows process tree exited without verified termination proof");
      }
    }
  };
}
