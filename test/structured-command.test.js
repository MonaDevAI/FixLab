import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createStructuredOutput,
  executeStructuredCommand,
  parseStructuredCommandArguments,
  showStructuredEvidence
} from "../bin/structured-command.js";

function git(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-structured-"));
  git(repository, ["init", "--quiet"]);
  writeFileSync(join(repository, "tracked.txt"), "initial\n");
  git(repository, ["add", "tracked.txt"]);
  git(repository, [
    "-c",
    "user.name=FixLab Test",
    "-c",
    "user.email=fixlab@example.test",
    "commit",
    "--quiet",
    "-m",
    "initial"
  ]);
  return repository;
}

function capture() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
      }
    },
    text() {
      return value;
    }
  };
}

test("externally owned command output retains compact results and detailed redacted evidence", () => {
  const repository = createRepository();
  try {
    const output = createStructuredOutput({
      repository,
      command: "npm run test:e2e",
      cwd: ".",
      stage: "live-test",
      tool: "Playwright"
    });
    for (let index = 0; index < 2000; index += 1) {
      output.write("stdout", `Browser step: locator.click ${index}\n`);
    }
    output.write("stderr", "error: browser assertion failed; token=");
    output.write("stderr", "sensitive-value\n");
    output.write("stderr", `error: ${"x".repeat(5000)}\n`);
    const compact = output.finish({
      status: 2,
      outcome: "failed",
      testCounts: { total: 3, passed: 1, failed: 1, skipped: 1 }
    });
    assert.match(compact.summary, /FAIL fixlab exec/u);
    assert.match(compact.summary, /Outcome: failed/u);
    assert.match(compact.summary, /Tests: 1 passed, 1 failed, 0 cancelled, 1 skipped, 3 total/u);
    assert.match(compact.summary, /browser assertion failed/u);
    assert.doesNotMatch(compact.summary, /sensitive-value|locator\.click/u);
    assert.ok(compact.context.reductionPercent > 90);
    assert.ok(compact.summary.length < 3000);
    const detail = capture();
    showStructuredEvidence(
      ["show", compact.evidenceId, "--stream", "stderr"],
      repository,
      { stdout: detail.stream }
    );
    assert.match(detail.text(), /x{5000}/u);
    assert.doesNotMatch(detail.text(), /sensitive-value/u);
    assert.throws(() => output.finish({ status: 0 }), /already been summarized/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("non-Git command summaries explicitly report unavailable durable evidence", () => {
  const output = createStructuredOutput({
    command: "npm test",
    cwd: ".",
    stage: "live-test",
    tool: "Playwright"
  });
  output.write("stdout", "Browser step: locator.click\n");
  const result = output.finish({ status: 1, outcome: "cancelled" });
  assert.equal(result.evidenceId, null);
  assert.match(result.summary, /Outcome: cancelled/u);
  assert.match(result.summary, /Evidence: unavailable/u);
  assert.doesNotMatch(result.summary, /Inspect:|PASS fixlab exec/u);
});

test("non-reused commands do not fingerprint unrelated worktree contents", async () => {
  const repository = createRepository();
  const output = capture();
  try {
    rmSync(join(repository, "tracked.txt"));
    const status = await executeStructuredCommand({
      repository,
      cwd: repository,
      stage: "discovery",
      reuse: false,
      timeoutSeconds: 0,
      command: process.execPath,
      commandArgs: ["-e", "console.log('discovery complete')"]
    }, { stdout: output.stream, stderr: output.stream });
    assert.equal(status, 0);
    assert.match(output.text(), /PASS fixlab exec/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("structured execution keeps compact diagnostics and redacted evidence", async () => {
  const repository = createRepository();
  const output = capture();
  const errors = capture();

  try {
    const status = await executeStructuredCommand(
      {
        repository,
        cwd: repository,
        stage: "validation",
        reuse: false,
        timeoutSeconds: 0,
        command: process.execPath,
        commandArgs: [
          "-e",
          [
            "for(let i=0;i<200;i++) console.log('warning repeated warning');",
            "console.log('token=super-secret-value');",
            "console.log('Authorization: Bearer bearer-secret-value');",
            "console.log(JSON.stringify({token:'json-secret-value'}));",
            "console.log('# tests 116');",
            "console.log('# pass 114');",
            "console.log('# fail 1');",
            "console.log('# cancelled 1');",
            "console.log('# skipped 0');",
            "console.error('error TS1234: expected value');",
            "process.exitCode=2;"
          ].join("")
        ]
      },
      { stdout: output.stream, stderr: errors.stream }
    );

    assert.equal(status, 2);
    assert.equal(output.text(), "");
    assert.match(errors.text(), /FAIL fixlab exec/);
    assert.match(errors.text(), /error TS1234/);
    assert.match(errors.text(), /Unique warnings retained: 1/);
    assert.match(
      errors.text(),
      /Tests: 114 passed, 1 failed, 1 cancelled, 0 skipped, 116 total/
    );
    assert.match(
      errors.text(),
      /Context: \d+ raw lines \/ \d+ bytes \(~\d+ tokens\) -> \d+ summary lines \/ \d+ bytes \(~\d+ tokens\), \d+\.\d% reduction; \d+ lines omitted/
    );
    assert.doesNotMatch(errors.text(), /super-secret-value/);
    assert.doesNotMatch(errors.text(), /bearer-secret-value|json-secret-value/);
    assert.doesNotMatch(errors.text(), /warning repeated warning.*warning repeated warning/su);

    const evidenceMatch = errors.text().match(/^Evidence: (.+)$/mu);
    assert.ok(evidenceMatch);
    const evidenceDirectory = evidenceMatch[1];
    assert.equal(existsSync(join(evidenceDirectory, "result.json")), true);
    const result = JSON.parse(
      readFileSync(join(evidenceDirectory, "result.json"), "utf8")
    );
    assert.equal(result.version, 3);
    assert.equal(result.tool, "Node.js");
    assert.deepEqual(result.stdout.tests, {
      failed: 1,
      passed: 114,
      skipped: 0,
      cancelled: 1,
      total: 116,
      suites: null,
      durationMs: null
    });
    assert.equal(result.context.rawLines > result.context.structuredLines, true);
    assert.equal(result.context.reductionPercent > 80, true);
    assert.equal(
      Buffer.byteLength(errors.text()),
      result.context.structuredBytes
    );
    assert.equal(
      result.context.estimatedRawTokens >
        result.context.estimatedStructuredTokens,
      true
    );
    const stdoutEvidence = readFileSync(
      join(evidenceDirectory, "stdout.log"),
      "utf8"
    );
    assert.doesNotMatch(
      stdoutEvidence,
      /super-secret-value|bearer-secret-value|json-secret-value/
    );
    assert.match(stdoutEvidence, /token=\[REDACTED\]/);
    assert.match(stdoutEvidence, /Authorization: \[REDACTED\]/);
    assert.match(stdoutEvidence, /"token":\[REDACTED\]/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("repeated diagnostics are omitted and available through bounded evidence", async () => {
  const repository = createRepository();
  const options = {
    repository,
    cwd: repository,
    stage: "typecheck",
    reuse: false,
    timeoutSeconds: 0,
    command: process.execPath,
    commandArgs: [
      "-e",
      "console.error('src/example.ts(4,2): error TS9999: repeated failure'); process.exitCode=2;"
    ]
  };

  try {
    const firstErrors = capture();
    assert.equal(
      await executeStructuredCommand(options, {
        stdout: capture().stream,
        stderr: firstErrors.stream
      }),
      2
    );
    assert.match(firstErrors.text(), /error TS9999: repeated failure/);

    const secondErrors = capture();
    assert.equal(
      await executeStructuredCommand(options, {
        stdout: capture().stream,
        stderr: secondErrors.stream
      }),
      2
    );
    assert.match(
      secondErrors.text(),
      /Diagnostics: 1 unchanged from the previous matching command/
    );
    assert.doesNotMatch(secondErrors.text(), /^- .*TS9999/mu);

    const evidencePath = secondErrors.text().match(/^Evidence: (.+)$/mu)?.[1];
    const evidenceId = evidencePath ? basename(evidencePath.trim()) : "";
    assert.ok(evidenceId);
    const evidenceOutput = capture();
    assert.equal(
      showStructuredEvidence(
        [
          repository,
          "show",
          evidenceId,
          "--stream",
          "stderr",
          "--lines",
          "1"
        ],
        repository,
        { stdout: evidenceOutput.stream }
      ),
      0
    );
    assert.match(evidenceOutput.text(), /error TS9999: repeated failure/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("successful deterministic validation is reused only for identical repository state", async () => {
  const repository = createRepository();
  let executions = 0;
  const spawn = () => {
    executions += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end("tests 1\npass 1\nfail 0\n");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };

  const options = {
    repository,
    cwd: repository,
    stage: "validation",
    reuse: true,
    timeoutSeconds: 30,
    command: process.execPath,
    commandArgs: ["--test", "tracked.test.js"]
  };

  try {
    const firstOutput = capture();
    const firstErrors = capture();
    assert.equal(
      await executeStructuredCommand(options, {
        stdout: firstOutput.stream,
        stderr: firstErrors.stream,
        spawn
      }),
      0,
      firstErrors.text()
    );
    assert.match(firstOutput.text(), /^PASS fixlab exec/mu);
    assert.match(firstOutput.text(), /Tool: Node\.js test/mu);
    assert.match(
      firstOutput.text(),
      /Tests: 1 passed, 0 failed, 0 cancelled, 0 skipped, 1 total/mu
    );
    assert.equal(executions, 1);

    const secondOutput = capture();
    assert.equal(
      await executeStructuredCommand(options, {
        stdout: secondOutput.stream,
        stderr: capture().stream,
        spawn
      }),
      0
    );
    assert.match(secondOutput.text(), /^REUSED fixlab exec/mu);
    assert.equal(executions, 1);

    writeFileSync(join(repository, "tracked.txt"), "changed\n");
    const changedOutput = capture();
    assert.equal(
      await executeStructuredCommand(options, {
        stdout: changedOutput.stream,
        stderr: capture().stream,
        spawn
      }),
      0
    );
    assert.match(changedOutput.text(), /^PASS fixlab exec/mu);
    assert.equal(executions, 2);

    writeFileSync(join(repository, "tracked.txt"), "changed again\n");
    const changedAgainOutput = capture();
    assert.equal(
      await executeStructuredCommand(options, {
        stdout: changedAgainOutput.stream,
        stderr: capture().stream,
        spawn
      }),
      0
    );
    assert.match(changedAgainOutput.text(), /^PASS fixlab exec/mu);
    assert.equal(executions, 3);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("structured command arguments enforce repository containment", () => {
  const repository = createRepository();
  try {
    const parsed = parseStructuredCommandArguments(
      [repository, "--stage", "test", "--", process.execPath, "--version"],
      repository
    );
    assert.equal(parsed.command, process.execPath);
    assert.deepEqual(parsed.commandArgs, ["--version"]);
    assert.equal(parsed.stage, "test");
    const powerShellCompatible = parseStructuredCommandArguments(
      [repository, "--stage", "test", process.execPath, "--version"],
      repository
    );
    assert.equal(powerShellCompatible.command, process.execPath);
    assert.deepEqual(powerShellCompatible.commandArgs, ["--version"]);
    assert.equal(powerShellCompatible.stage, "test");
    assert.throws(
      () =>
        parseStructuredCommandArguments(
          [repository, "--cwd", "..", "--", process.execPath, "--version"],
          repository
        ),
      /--cwd must stay within the repository/
    );
    assert.throws(
      () => parseStructuredCommandArguments([repository]),
      /usage: fixlab exec/
    );
    assert.throws(
      () =>
        parseStructuredCommandArguments(
          [
            repository,
            "--timeout-seconds",
            "2147484",
            "--",
            process.execPath
          ],
          repository
        ),
      /integer from 1 to 2147483/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("unsupported commands are never reused", async () => {
  const repository = createRepository();
  let executions = 0;
  const spawn = () => {
    executions += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end("done\n");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  const options = {
    repository,
    cwd: repository,
    stage: "validation",
    reuse: true,
    timeoutSeconds: 0,
    command: process.execPath,
    commandArgs: ["-e", "console.log('done')"]
  };

  try {
    const first = capture();
    const firstErrors = capture();
    const second = capture();
    await executeStructuredCommand(options, {
      stdout: first.stream,
      stderr: firstErrors.stream,
      spawn
    });
    await executeStructuredCommand(options, {
      stdout: second.stream,
      stderr: capture().stream,
      spawn
    });
    assert.equal(executions, 2);
    assert.match(firstErrors.text(), /Reuse ignored/);
    assert.doesNotMatch(second.text(), /^REUSED/mu);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("tool labels redact secret-shaped executable names", async () => {
  const repository = createRepository();
  const output = capture();
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end("done\n");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };

  try {
    assert.equal(
      await executeStructuredCommand(
        {
          repository,
          cwd: repository,
          stage: "validation",
          reuse: false,
          timeoutSeconds: 0,
          command: "token=tool-secret",
          commandArgs: []
        },
        { stdout: output.stream, stderr: capture().stream, spawn }
      ),
      0
    );
    assert.match(output.text(), /Tool: token=\[REDACTED\]/u);
    assert.doesNotMatch(output.text(), /tool-secret/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("timed out commands return exit code 124", async () => {
  const repository = createRepository();
  const errors = capture();
  let spawnedAt;
  const spawn = () => {
    spawnedAt = Date.now();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
  };

  try {
    const status = await executeStructuredCommand(
      {
        repository,
        cwd: repository,
        stage: "test",
        reuse: false,
        timeoutSeconds: 1,
        command: process.execPath,
        commandArgs: ["-e", "setTimeout(() => {}, 10000)"]
      },
      {
        stdout: capture().stream,
        stderr: errors.stream,
        spawn,
        terminationGraceMs: 10
      }
    );
    assert.equal(status, 124);
    assert.equal(Date.now() - spawnedAt < 2000, true);
    assert.match(errors.text(), /exceeded.*terminated/is);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test(
  "Windows command wrappers preserve safe arguments and reject metacharacters",
  { skip: process.platform !== "win32" },
  async () => {
    const repository = createRepository();
    const wrapperDirectory = join(repository, "wrapper folder");
    const wrapper = join(wrapperDirectory, "echo-argument.cmd");
    const output = capture();
    const errors = capture();
    try {
      mkdirSync(wrapperDirectory);
      writeFileSync(wrapper, "@echo off\r\necho %~1\r\n");
      const status = await executeStructuredCommand(
        {
          repository,
          cwd: repository,
          stage: "test",
          reuse: false,
          timeoutSeconds: 10,
          command: wrapper,
          commandArgs: ["value-with-marks"]
        },
        { stdout: output.stream, stderr: errors.stream }
      );
      assert.equal(status, 0, errors.text());
      const evidenceDirectory = output
        .text()
        .match(/^Evidence: (.+)$/mu)?.[1];
      assert.match(
        readFileSync(join(evidenceDirectory, "stdout.log"), "utf8"),
        /value-with-marks/
      );
      await assert.rejects(
        executeStructuredCommand(
          {
            repository,
            cwd: repository,
            stage: "test",
            reuse: false,
            timeoutSeconds: 10,
            command: wrapper,
            commandArgs: ["value&unsafe"]
          },
          { stdout: capture().stream, stderr: capture().stream }
        ),
        /cannot contain shell metacharacters/
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }
);
