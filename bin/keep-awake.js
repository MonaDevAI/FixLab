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
      "[FixLab.NativeMethods]::SetThreadExecutionState($continuous -bor $systemRequired) | Out-Null",
      `try { Start-Sleep -Seconds ${seconds} } finally { [FixLab.NativeMethods]::SetThreadExecutionState($continuous) | Out-Null }`
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
    stdio = "inherit"
  } = {}
) {
  const duration = parseKeepAwakeMinutes(minutes);
  const invocation = keepAwakeInvocation(duration, platform);
  const child = spawnProcess(invocation.command, invocation.args, {
    shell: false,
    stdio,
    windowsHide: true
  });
  return {
    child,
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
