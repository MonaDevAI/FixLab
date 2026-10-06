import { spawn } from "node:child_process";

const MAX_KEEP_AWAKE_MINUTES = 1440;

export function parseKeepAwakeMinutes(value, option = "--minutes") {
  if (!/^\d+$/u.test(String(value ?? ""))) {
    throw new Error(`${option} must be an integer between 1 and 1440`);
  }
  const minutes = Number(value);
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_KEEP_AWAKE_MINUTES
  ) {
    throw new Error(`${option} must be an integer between 1 and 1440`);
  }
  return minutes;
}

function keepAwakeInvocation(minutes, platform) {
  const seconds = minutes * 60;
  if (platform === "win32") {
    const script = [
      "$signature = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
      "Add-Type -MemberDefinition $signature -Name NativeMethods -Namespace FixLab",
      "$continuous = [uint32]2147483648",
      "$systemRequired = [uint32]1",
      "$executionState = [FixLab.NativeMethods]::SetThreadExecutionState($continuous -bor $systemRequired)",
      "if ($executionState -eq 0) { throw 'SetThreadExecutionState failed to enable the keep-awake request.' }",
      `try { Start-Sleep -Seconds ${seconds} } finally { $released = [FixLab.NativeMethods]::SetThreadExecutionState($continuous); if ($released -eq 0) { throw 'SetThreadExecutionState failed to release the keep-awake request.' } }`
    ].join("; ");
    return {
      command: "pwsh",
      args: ["-NoProfile", "-NonInteractive", "-Command", script]
    };
  }
  if (platform === "darwin") {
    return {
      command: "caffeinate",
      args: ["-dimsu", "-t", String(seconds)]
    };
  }
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=sleep",
        "--why=FixLab validation is running",
        "--mode=block",
        "sleep",
        String(seconds)
      ]
    };
  }
  throw new Error(`keep-awake is not supported on ${platform}`);
}

export function startKeepAwake(
  minutes,
  {
    platform = process.platform,
    spawnProcess = spawn,
    stdio = "inherit",
    startupDelayMs = 250
  } = {}
) {
  const duration = parseKeepAwakeMinutes(minutes);
  const invocation = keepAwakeInvocation(duration, platform);
  const child = spawnProcess(invocation.command, invocation.args, {
    shell: false,
    stdio,
    windowsHide: true
  });
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    child.once("error", fail);
    child.once("close", (code, signal) => {
      fail(
        new Error(
          signal
            ? `keep-awake process terminated by ${signal} during startup`
            : `keep-awake process exited with code ${
                Number.isInteger(code) ? code : "unknown"
              } during startup`
        )
      );
    });
    child.once("spawn", () => {
      setTimeout(() => {
        if (settled) {
          return;
        }
        if (child.exitCode !== null) {
          fail(
            new Error(
              `keep-awake process exited with code ${child.exitCode} during startup`
            )
          );
          return;
        }
        settled = true;
        resolve();
      }, startupDelayMs);
    });
  });
  return {
    child,
    ready,
    minutes: duration,
    command: invocation.command,
    args: invocation.args
  };
}

export function stopKeepAwake(handle) {
  if (handle?.child && handle.child.exitCode === null) {
    handle.child.kill("SIGTERM");
  }
}

export async function runKeepAwake(minutes, options = {}) {
  const handle = startKeepAwake(minutes, options);
  await handle.ready;
  console.log(
    `FixLab will keep this machine awake for ${handle.minutes} minute(s).`
  );
  console.log(
    "Locking is allowed, but interactive browser or authentication steps may still require an unlocked desktop."
  );
  return new Promise((resolve, reject) => {
    handle.child.once("error", reject);
    handle.child.once("close", (code, signal) => {
      if (signal) {
        resolve(0);
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}
