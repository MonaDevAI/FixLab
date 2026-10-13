import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
    { stdio: ["ignore", "pipe", "pipe"] });
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
    stdio: ["ignore", "ignore", "ignore", "ipc"]
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
  const bin = join(repository, "bin");
  mkdirSync(bin);
  const executable = join(bin, "copilot.exe");
  const pidPath = join(repository, "descendant.txt");
  const childArgs = ["-e", "setInterval(() => {}, 1000)"].map(quoteWindowsArgument).join(" ");
  const source = `
    using System;
    using System.Diagnostics;
    using System.IO;
    using System.Threading;
    public class FakeCopilot {
      public static void Main() {
        Console.In.ReadToEnd();
        var start = new ProcessStartInfo(${JSON.stringify(process.execPath)}, ${JSON.stringify(childArgs)});
        start.UseShellExecute = false;
        var child = Process.Start(start);
        File.WriteAllText(${JSON.stringify(pidPath)}, child.Id.ToString());
        Console.WriteLine("FIXLAB_STAGE|intake|blocked|Synthetic prerequisite.");
        Thread.Sleep(150);
      }
    }
  `;
  const encoded = Buffer.from(source).toString("base64");
  const script = `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Add-Type -TypeDefinition $source -OutputAssembly '${executable.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
  const compiled = spawnSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 15000 });
  const originalPath = process.env.PATH;
  let handle;
  let lease;
  try {
    assert.equal(compiled.status, 0, compiled.stderr);
    process.env.PATH = `${bin};${originalPath}`;
    const peer = createExecutorLease(repository, "peer");
    lease = createExecutorLease(repository, "owner").acquire("native-job");
    const executor = createCopilotExecutor({ packageRoot: fileURLToPath(new URL("..", import.meta.url)) });
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
    process.env.PATH = originalPath;
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
