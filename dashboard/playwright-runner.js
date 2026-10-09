import { spawn } from "node:child_process";
import { dirname, delimiter } from "node:path";

const preflightScript = `
  const { spawnSync } = require("node:child_process");
  const [packageName, browserName, channel, manager] = process.argv.slice(1);
  (async () => {
    if (manager) {
      const result = spawnSync(manager + " --version", {
        shell: true, encoding: "utf8", timeout: 15000, windowsHide: true
      });
      if (result.error || result.status !== 0) {
        throw new Error("Configured package manager is unavailable: " + manager);
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
    if (!child?.pid) {
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
      const preflight = await launch(
        process.execPath,
        [
          "-e",
          preflightScript,
          configuration.package,
          configuration.browser,
          configuration.channel ?? "",
          manager
        ],
        false
      );
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
