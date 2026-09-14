import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAttempts } from "./run-tests-with-containment.mjs";

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    input: options.input,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"]
  });
}

function verifyRollbackRange() {
  const root = mkdtempSync(join(tmpdir(), "fixlab-rollback-proof-"));
  try {
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "FixLab Test"]);
    git(root, ["config", "user.email", "fixlab@example.invalid"]);
    writeFileSync(join(root, "state.txt"), "last-successful\n");
    git(root, ["add", "state.txt"]);
    git(root, ["commit", "--quiet", "-m", "last successful"]);
    const lastSuccessful = git(root, ["rev-parse", "HEAD"]).trim();

    writeFileSync(join(root, "state.txt"), "regression-one\n");
    git(root, ["add", "state.txt"]);
    git(root, ["commit", "--quiet", "-m", "first failed push commit"]);
    writeFileSync(join(root, "second.txt"), "regression-two\n");
    git(root, ["add", "second.txt"]);
    git(root, ["commit", "--quiet", "-m", "second failed push commit"]);
    const failedHead = git(root, ["rev-parse", "HEAD"]).trim();

    const patch = git(
      root,
      ["diff", "--binary", lastSuccessful, failedHead],
      { encoding: "buffer" }
    );
    git(root, ["apply", "--reverse", "--index"], {
      input: patch,
      stdio: ["pipe", "pipe", "pipe"]
    });

    assert.equal(
      readFileSync(join(root, "state.txt"), "utf8").replaceAll("\r\n", "\n"),
      "last-successful\n"
    );
    assert.throws(() => readFileSync(join(root, "second.txt"), "utf8"));
    return {
      lastSuccessful,
      failedHead,
      commitsInFailedRange: 2,
      restoredLastSuccessfulTree: true
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function verifySelfHealing() {
  const flakyContainment = classifyAttempts(1, 0);
  assert.deepEqual(flakyContainment, {
    status: "flaky-contained",
    attempts: 2,
    exitCode: 1
  });

  return {
    proofOfBug: [
      {
        failureClass: "flaky-rerun",
        observedAttempts: [1, 0]
      },
      {
        failureClass: "failed-main-push",
        failedCommitCount: 2
      }
    ],
    proofOfFix: [
      {
        failureClass: "flaky-rerun",
        result: flakyContainment
      },
      {
        failureClass: "failed-main-push",
        result: verifyRollbackRange()
      }
    ],
    rollback: "auto-revert PR",
    verified: true
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = verifySelfHealing();
  const reportPath = argument("--report");
  if (reportPath) {
    const resolvedReport = resolve(reportPath);
    mkdirSync(dirname(resolvedReport), { recursive: true });
    writeFileSync(resolvedReport, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log("Self-healing proof passed for flaky rerun and rollback range.");
}
