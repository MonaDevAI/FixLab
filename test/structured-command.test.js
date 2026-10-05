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
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  executeStructuredCommand,
  parseStructuredCommandArguments
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
    assert.doesNotMatch(errors.text(), /super-secret-value/);
    assert.doesNotMatch(errors.text(), /bearer-secret-value|json-secret-value/);
    assert.doesNotMatch(errors.text(), /warning repeated warning.*warning repeated warning/su);

    const evidenceMatch = errors.text().match(/^Evidence: (.+)$/mu);
    assert.ok(evidenceMatch);
    const evidenceDirectory = evidenceMatch[1];
    assert.equal(existsSync(join(evidenceDirectory, "result.json")), true);
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
    assert.throws(
      () =>
        parseStructuredCommandArguments(
          [repository, "--cwd", "..", "--", process.execPath, "--version"],
          repository
        ),
      /--cwd must stay within the repository/
    );
    assert.throws(
      () => parseStructuredCommandArguments([repository, process.execPath]),
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

test("timed out commands return exit code 124", async () => {
  const repository = createRepository();
  const errors = capture();
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", null, signal);
      });
      return true;
    };
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
      { stdout: capture().stream, stderr: errors.stream, spawn }
    );
    assert.equal(status, 124);
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
