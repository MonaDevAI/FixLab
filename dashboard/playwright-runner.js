import { spawn } from "node:child_process";
import { dirname, delimiter } from "node:path";
import { resolveWindowsNpmCommand } from "../bin/structured-command.js";

const preflightScript = `
  const { spawnSync } = require("node:child_process");
  const [packageName, browserName, channel, probeJson] = process.argv.slice(1);
  (async () => {
    const probe = JSON.parse(probeJson);
    if (probe) {
      const result = spawnSync(probe.command, probe.args, {
        shell: probe.shell, encoding: "utf8", timeout: 30000, windowsHide: true
      });
      if (result.error?.code === "ETIMEDOUT") {
        throw new Error("Package-manager preflight timed out after 30 seconds: " + probe.manager);
      }
      if (result.error || result.status !== 0) {
        throw new Error("Package-manager preflight failed: " + probe.manager +
          " (" + (result.error?.code ?? "exit " + result.status) + ")");
      }
    }
    const browserType = require(packageName)[browserName];
    if (!browserType || typeof browserType.launch !== "function") {
      throw new Error("Configured Playwright browser is unavailable");
    }
    const browser = await browserType.launch({
      headless: true, ...(channel ? { channel } : {})
    });
    await browser.close();
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

export function packageManagerProbe(manager) {
  if (!manager) {
    return null;
  }
  const npm = resolveWindowsNpmCommand(manager, ["--version"]);
  return npm
    ? { manager, ...npm, shell: false }
    : { manager, command: `${manager} --version`, args: [], shell: true };
}

export function withPlaywrightProgress(command, reporterPath) {
  if (/["\r\n]/u.test(reporterPath)) {
    throw new Error("The installed Playwright reporter path cannot be quoted safely.");
  }
  if (/^(?:npm(?:\.cmd)?|pnpm)\s+run\s/u.test(command)) {
    return `${command}${/\s--(?:\s|$)/u.test(command) ? "" : " --"} --reporter="${reporterPath},html"`;
  }
  if (/^(?:npx(?:\.cmd)?|pnpm\s+exec|yarn)\s+playwright\s+test\b/u.test(command)) {
    return `${command} --reporter="${reporterPath},html"`;
  }
  return command;
}

export function runPlaywrightTest({
  command,
  workingDirectory,
  configuration,
  environment,
  timeoutMs,
  onOutput,
  onPhase
}) {
  let child = null;
  let stopping = null;
  let timer;
  let resolveCompletion;
  let settled = false;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const env = {
    ...process.env,
    ...environment,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    FORCE_COLOR: "0",
    PLAYWRIGHT_HTML_OPEN: "never"
  };

  function finish(result) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolveCompletion(result);
  }

  function stop(status, message) {
    if (settled || stopping) {
      return;
    }
    stopping = { status, code: null, message };
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      finish(stopping);
      return;
    }
    if (process.platform === "win32") {
      const terminator = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, stdio: "ignore", windowsHide: true }
      );
      terminator.once("error", (error) => {
        onOutput("stderr", `Could not stop owned test process: ${error.message}\n`);
        child.kill();
      });
      terminator.once("close", (code) => {
        if (code !== 0 && child.exitCode === null) {
          onOutput("stderr", "Could not stop the owned test process tree.\n");
          child.kill();
        }
      });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          onOutput("stderr", `Could not stop owned test process: ${error.message}\n`);
          child.kill("SIGKILL");
        }
      }
    }
  }

  function launch(executable, args, shell) {
    return new Promise((resolve) => {
      child = spawn(executable, args, {
        cwd: workingDirectory,
        env,
        shell,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32"
      });
      for (const stream of ["stdout", "stderr"]) {
        child[stream].setEncoding("utf8");
        child[stream].on("data", (text) => onOutput(stream, text));
      }
      child.once("error", (error) => {
        onOutput("stderr", `${error.message}\n`);
        resolve({ code: null, error });
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  }

  timer = setTimeout(
    () => stop("timed-out", "Playwright exceeded its approved time limit."),
    timeoutMs
  );
  timer.unref?.();
  void (async () => {
    try {
      onPhase("preflight", "Checking the package manager and launching the configured browser.");
      const manager = command.match(/^(npm|npx|pnpm|yarn)(?:\.cmd)?\s/i)?.[1] ?? "";
      const maximumAttempts =
        configuration.preflightRecovery?.enabled === false
          ? 1
          : Math.min(
              3,
              Math.max(
                1,
                configuration.preflightRecovery?.maxAttempts ?? 2
              )
            );
      let preflight;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        preflight = await launch(
          process.execPath,
          [
            "-e",
            preflightScript,
            configuration.package,
            configuration.browser,
            configuration.channel ?? "",
            JSON.stringify(packageManagerProbe(manager))
          ],
          false
        );
        if (!preflight.error && preflight.code === 0) {
          break;
        }
        if (attempt < maximumAttempts) {
          onOutput(
            "stderr",
            `Playwright preflight recovery attempt ${attempt + 1} of ${maximumAttempts}; retrying only the completed FixLab-owned probe.\n`
          );
          onPhase(
            "preflight",
            `Retrying Playwright preflight (${attempt + 1}/${maximumAttempts}).`
          );
        }
      }
      if (stopping) {
        finish(stopping);
        return;
      }
      if (preflight.error || preflight.code !== 0) {
        finish({
          status: "blocked",
          code: preflight.code,
          message: "Playwright preflight failed; inspect the linked job logs."
        });
        return;
      }
      onPhase("test", "Running the approved repository Playwright command.");
      if (stopping || settled) {
        finish(stopping);
        return;
      }
      const result = await launch(command, [], true);
      finish(stopping ?? {
        status: result.code === 0 ? "passed" : "failed",
        code: result.code,
        signal: result.signal,
        message: result.code === 0
          ? "Playwright command completed successfully; workflow gates remain separate."
          : "Playwright command failed; inspect the linked job logs and evidence."
      });
    } catch (error) {
      onOutput("stderr", `${error.message}\n`);
      finish({ status: "failed", code: null, message: "Could not execute Playwright." });
    }
  })();

  return {
    completion,
    terminate() {
      stop("cancelled", "Playwright was stopped by its owner.");
    }
  };
}
