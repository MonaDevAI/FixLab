import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCopilotExecutor } from "../dashboard/server.js";
import { createExecutorLease } from "../dashboard/executor-lease.js";
import { quoteWindowsArgument, spawnWindowsExecutor } from "../dashboard/windows-executor.js";

const windowsOnly = { skip: process.platform !== "win32", timeout: 30000 };

async function observeTermination(pids) {
  const script = `
    $ErrorActionPreference = 'Stop';
    $targets = @(${pids.map((pid) => `[Diagnostics.Process]::GetProcessById(${pid})`).join(";")});
    foreach ($target in $targets) { $null = $target.Handle };
    [Console]::WriteLine('OWNED_HANDLES_CAPTURED');
    foreach ($target in $targets) {
      if (-not $target.WaitForExit(15000)) { throw 'Owned process did not terminate' }
      $target.Dispose()
    };
    [Console]::WriteLine('OWNED_HANDLES_EXITED')
  `;
  const observer = spawn(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let errors = "";
  let ready;
  const captured = new Promise((resolve, reject) => {
    ready = resolve;
    observer.once("error", reject);
    observer.once("exit", (code) => {
      if (!output.includes("OWNED_HANDLES_CAPTURED")) {
        reject(new Error(`Could not capture owned process handles (${code}): ${errors}`));
      }
    });
  });
  observer.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (output.includes("OWNED_HANDLES_CAPTURED")) {
      ready();
    }
  });
  observer.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const exited = new Promise((resolve) => {
    observer.once("error", (error) => resolve({ code: null, error }));
    observer.once("close", (code) => {
      resolve({ code });
    });
  });
  await captured;
  return {
    get completion() {
      return exited.then(({ code, error }) => {
        if (error || code !== 0 || !output.includes("OWNED_HANDLES_EXITED")) {
          throw error ?? new Error(`Owned process handles did not signal exit: ${errors}`);
        }
      });
    },
    stop() { observer.kill(); }
  };
}

function start(args, repository = process.cwd(), input = "", options = {}) {
  const handle = spawnWindowsExecutor({ executable: process.execPath, args, repository, ...options });
  let stdout = "";
  let stderr = "";
  handle.child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  handle.child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  handle.child.stdin.on("error", (error) => { stderr += `Could not send test input: ${error.message}\n`; });
  handle.child.stdin.end(input);
  const completion = new Promise((resolve, reject) => {
    handle.child.once("error", reject);
    handle.child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { ...handle, completion };
}

async function waitForRecord(path) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Owned Windows test processes did not become ready");
}

function treeScript(record, exitRoot) {
  const childScript = `
    process.send({ pid: process.pid });
    setInterval(() => {}, 1000);
  `;
  return `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    child.once("message", (message) => {
      writeFileSync(${JSON.stringify(record)}, JSON.stringify({ root: process.pid, descendant: message.pid }));
      ${exitRoot ? "process.exit(0);" : ""}
    });
    setInterval(() => {}, 1000);
  `;
}

test("Windows argument quoting preserves quotes and trailing backslashes", () => {
  assert.equal(quoteWindowsArgument(""), '""');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument("C:\\path with space\\"), '"C:\\path with space\\\\"');
});

test("Windows executor gives tooling descendants one inherited hidden console", windowsOnly, async () => {
  const probe = `
    $ErrorActionPreference = 'Stop';
    $ProgressPreference = 'SilentlyContinue';
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleProbe {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList(uint[] processes, uint count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
    $window = [ConsoleProbe]::GetConsoleWindow();
    $processes = New-Object 'System.UInt32[]' 16;
    $count = [ConsoleProbe]::GetConsoleProcessList($processes, $processes.Length);
    if ($count -eq 0 -or $count -gt $processes.Length) { throw 'Could not inspect the inherited console' };
    [Console]::WriteLine((@{
      window = $window.ToInt64();
      visible = [ConsoleProbe]::IsWindowVisible($window);
      processes = @($processes[0..($count - 1)]);
      input = [Console]::In.ReadToEnd()
    } | ConvertTo-Json -Compress));
    [Console]::Error.WriteLine('TOOLING_STDERR');
  `;
  const source = `
    const { spawnSync } = require("node:child_process");
    const child = spawnSync(${JSON.stringify(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))},
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "Text", "-OutputFormat", "Text", "-EncodedCommand",
       ${JSON.stringify(Buffer.from(probe, "utf16le").toString("base64"))}], {
        encoding: "utf8", input: "TOOLING_STDIN", timeout: 15000
      });
    if (child.error) throw child.error;
    if (child.status !== 0 || !child.stdout) {
      throw new Error("Console probe failed (" + child.status + "): " + child.stderr);
    }
    const record = JSON.parse(child.stdout);
    record.rootPid = process.pid;
    process.stdout.write(JSON.stringify(record));
    process.stderr.write(child.stderr);
    process.exitCode = child.status ?? 1;
  `;
  const handle = start(["-e", source]);
  try {
    const result = await handle.completion;
    assert.equal(result.code, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.ok(record.window > 0, "Tooling must inherit a console rather than allocate its own");
    assert.equal(record.visible, false, "The inherited console must stay hidden");
    assert.ok(record.processes.includes(record.rootPid), "The executor and tooling must share their console");
    assert.equal(record.input, "TOOLING_STDIN");
    assert.match(result.stderr, /TOOLING_STDERR/);
    assert.equal(handle.hasStopped(), true);
  } finally {
    handle.terminate();
    await handle.completion;
    rmSync(handle.directory, { recursive: true, force: true });
  }
});

test("Windows suspended launch preserves argv, stdin, stdout and child exit code", windowsOnly, async () => {
  const args = ["", 'a"b', "C:\\path with space\\", "literal & | < > % !"];
  const handle = start([
    "-e",
    'let input=""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => { console.log(JSON.stringify({args:process.argv.slice(1),input})); process.exitCode=7; });',
    "--", ...args
  ], process.cwd(), "FIXLAB_STAGE|intake|running|A prompt with quotes \" and Unicode \u00e9.\n");
  try {
    const result = await handle.completion;
    assert.equal(result.code, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args,
      input: "FIXLAB_STAGE|intake|running|A prompt with quotes \" and Unicode \u00e9.\n"
    });
    assert.equal(handle.hasStopped(), true);
    assert.equal(handle.hasStopped(), true);
  } finally {
    handle.terminate();
    await handle.completion;
    rmSync(handle.directory, { recursive: true, force: true });
  }
});

for (const exitRoot of [false, true]) {
  test(`Windows job containment stops detached descendants after ${exitRoot ? "root exit" : "explicit stop"}`, windowsOnly, async () => {
    const repository = mkdtempSync(join(tmpdir(), "fixlab-windows-tree-test-"));
    const record = join(repository, "owned-processes.json");
    const handle = start(["-e", treeScript(record, exitRoot)], repository);
    let observer;
    try {
      const processes = await waitForRecord(record);
      if (!exitRoot) {
        observer = await observeTermination([processes.root, processes.descendant, handle.child.pid]);
        assert.equal(handle.hasStopped(), false);
        handle.terminate();
      }
      const result = await handle.completion;
      assert.equal(result.code, exitRoot ? 0 : 130, result.stderr);
      assert.equal(handle.hasStopped(), true);
      if (observer) {
        await observer.completion;
      }
    } finally {
      handle.terminate();
      await handle.completion;
      observer?.stop();
      rmSync(handle.directory, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("Windows wrapper crash kills owned descendants but cannot supply release proof", windowsOnly, async () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-windows-crash-test-"));
  const handle = start(["-e", treeScript(join(repository, "owned-processes.json"), false)], repository);
  let observer;
  try {
    const processes = await waitForRecord(join(repository, "owned-processes.json"));
    observer = await observeTermination([processes.root, processes.descendant, handle.child.pid]);
    handle.child.kill();
    await handle.completion;
    assert.equal(handle.hasStopped(), false);
    await observer.completion;
  } finally {
    handle.terminate();
    await handle.completion;
    observer?.stop();
    rmSync(handle.directory, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("Windows dashboard-owned frontend survives launcher exit until confirmed stop", windowsOnly, async () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-windows-retained-test-"));
  const record = join(repository, "owned-processes.json");
  const handle = start(["-e", treeScript(record, true)], repository, "", { retainDescendants: true });
  let observer;
  try {
    const processes = await waitForRecord(record);
    observer = await observeTermination([processes.descendant, handle.child.pid]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(handle.hasStopped(), false);
    handle.terminate();
    await handle.waitForStopped();
    assert.equal((await handle.completion).code, 130);
    await observer.completion;
  } finally {
    handle.terminate();
    await handle.completion;
    observer?.stop();
    rmSync(handle.directory, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("Windows owner crash terminates its contained processes without reclaiming ownership", windowsOnly, async () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-windows-owner-test-"));
  const record = join(repository, "owned-processes.json");
  const source = `
    import { spawnWindowsExecutor } from ${JSON.stringify(new URL("../dashboard/windows-executor.js", import.meta.url).href)};
    import { createExecutorLease } from ${JSON.stringify(new URL("../dashboard/executor-lease.js", import.meta.url).href)};
    const lease = createExecutorLease(${JSON.stringify(repository)}, "crashed-owner").acquire("owned-job");
    const handle = spawnWindowsExecutor({
      executable: process.execPath,
      args: ["-e", ${JSON.stringify(treeScript(record, false))}],
      repository: ${JSON.stringify(repository)}
    });
    handle.child.stdin.end();
    lease.update("running", handle.child.pid);
    handle.child.stdout.resume();
    handle.child.stderr.resume();
    process.send({ pid: handle.child.pid, directory: handle.directory });
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true
  });
  const ownerExit = new Promise((resolve) => owner.once("exit", resolve));
  let supervisor;
  let observer;
  try {
    supervisor = await new Promise((resolve, reject) => {
      owner.once("message", resolve);
      owner.once("error", reject);
    });
    const processes = await waitForRecord(record);
    observer = await observeTermination([processes.root, processes.descendant, supervisor.pid, owner.pid]);
    owner.kill();
    await ownerExit;
    await observer.completion;
    assert.throws(() => createExecutorLease(repository, "peer").acquire("unsafe-reclaim"), /reserved/);
  } finally {
    owner.kill();
    await ownerExit;
    observer?.stop();
    if (supervisor) {
      rmSync(supervisor.directory, { recursive: true, force: true });
    }
    rmSync(createExecutorLease(repository, "cleanup").scope.directory, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("Windows containment supports the repository-owned Microsoft Edge browser", { ...windowsOnly, timeout: 60000 }, async () => {
  const profile = mkdtempSync(join(tmpdir(), "fixlab-contained-edge-test-"));
  const handle = start(["-e", `
    const { chromium } = require("@playwright/test");
    const deadline = setTimeout(() => {
      console.error("Contained Edge lifecycle exceeded its 30-second browser budget.");
      process.exit(1);
    }, 30000);
    (async () => {
      console.log("EDGE_LAUNCH_START");
      const context = await chromium.launchPersistentContext(${JSON.stringify(profile)}, {
        channel: "msedge", headless: true, timeout: 20000
      });
      console.log("EDGE_LAUNCH_READY");
      const page = context.pages()[0] || await context.newPage();
      await page.setContent("<h1>Owned browser evidence</h1>");
      console.log(await page.locator("h1").textContent());
      console.log("EDGE_CLOSE_START");
      await context.close();
      console.log("EDGE_CLOSE_DONE");
      clearTimeout(deadline);
    })().catch(error => { console.error(error); process.exit(1); });
  `], process.cwd(), "", { environment: { DEBUG: "pw:browser" } });
  try {
    const result = await handle.completion;
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Owned browser evidence/);
    assert.equal(handle.hasStopped(), true);
  } finally {
    handle.terminate();
    await handle.completion;
    rmSync(handle.directory, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
});

test("real Windows Copilot executor retains its lease until the contained tree exits", windowsOnly, async () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-windows-lease-test-"));
  const hostDirectory = join(repository, "dashboard");
  mkdirSync(hostDirectory);
  const pidPath = join(repository, "descendant.txt");
  writeFileSync(join(repository, "package.json"), '{"type":"module"}');
  writeFileSync(join(hostDirectory, "copilot-session.js"), `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    input.once("line", (line) => {
      if (JSON.parse(line).type !== "start") throw new Error("Missing start frame");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true, stdio: "ignore"
      });
      child.unref();
      writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      process.stdout.write(JSON.stringify({
        type: "output", stream: "stdout",
        text: "FIXLAB_STAGE|intake|blocked|Synthetic prerequisite.\\n"
      }) + "\\n");
      setTimeout(() => { input.close(); process.stdin.destroy(); }, 150);
    });
  `);
  let handle;
  let lease;
  try {
    const peer = createExecutorLease(repository, "peer");
    lease = createExecutorLease(repository, "owner").acquire("native-job");
    const executor = createCopilotExecutor({ packageRoot: repository });
    let output = "";
    handle = executor({
      repository,
      prompt: "Run the synthetic lease fixture.",
      sessionId: "11111111-1111-4111-8111-111111111111",
      model: "hydrafusion",
      onOutput(_stream, text) { output += text; }
    });
    lease.update("running", handle.pid);
    assert.throws(() => peer.acquire("overlap"), /reserved/);
    const result = await handle.completion;
    assert.equal(result.code, 0, output);
    assert.ok(Number(readFileSync(pidPath, "utf8")) > 0);
    assert.equal(handle.hasStopped(), true);
    lease.release();
    lease = null;
    peer.acquire("successor").release();
    assert.match(output, /FIXLAB_STAGE\|intake\|blocked/);
  } finally {
    handle?.terminate();
    if (handle) {
      await handle.completion;
      if (handle.hasStopped()) {
        lease?.release();
      }
    } else {
      lease?.release();
    }
    rmSync(repository, { recursive: true, force: true });
  }
});
