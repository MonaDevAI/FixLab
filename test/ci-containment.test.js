import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test, { mock } from "node:test";
import { classifyAttempts, runTests } from "../scripts/ci/run-tests-with-containment.mjs";
import { verifySelfHealing } from "../scripts/ci/verify-self-healing.mjs";

test("local and CI unit suites bound file workers without changing failure containment", async () => {
  const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const invocation = mock.method(childProcess, "spawnSync", () => ({ status: 0 }));
  syncBuiltinESMExports();
  try {
    assert.equal(runTests("test-results.xml").status, 0);
    assert.deepEqual(invocation.mock.calls[0].arguments, [
      process.execPath,
      [
        "--test",
        "--test-concurrency=2",
        "--test-reporter=junit",
        "--test-reporter-destination=test-results.xml"
      ],
      { encoding: "utf8" }
    ]);
    assert.equal(scripts.test, "node --test --test-concurrency=2");
    assert.match(workflow, /run: npm test -- test\\windows-executor\.test\.js test\\dashboard-executor-lease\.test\.js/);
  } finally {
    invocation.mock.restore();
    syncBuiltinESMExports();
  }
});

test("CI containment reports an initial pass", () => {
  assert.deepEqual(classifyAttempts(0), {
    status: "passed",
    attempts: 1,
    exitCode: 0
  });
});

test("CI containment fails a flaky retry instead of hiding it", () => {
  assert.deepEqual(classifyAttempts(1, 0), {
    status: "flaky-contained",
    attempts: 2,
    exitCode: 1
  });
});

test("CI containment preserves repeated failure", () => {
  assert.deepEqual(classifyAttempts(1, 1), {
    status: "failed",
    attempts: 2,
    exitCode: 1
  });
});

test("failure containment cannot execute pull-request source with write access", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/self-healing.yml", import.meta.url),
    "utf8"
  );
  const containmentJob = workflow.split("\n  propose-rollback:")[0];

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(workflow, /automaticSourceMutation: false/);
  assert.match(workflow, /gh pr comment/);
  assert.doesNotMatch(containmentJob, /actions\/checkout/);
});

test("self-healing proof covers flaky containment and failed-push rollback", () => {
  const proof = verifySelfHealing();

  assert.equal(proof.verified, true);
  assert.deepEqual(
    proof.proofOfBug.map((entry) => entry.failureClass),
    ["flaky-rerun", "failed-main-push"]
  );
  assert.equal(
    proof.proofOfFix[1].result.restoredLastSuccessfulTree,
    true
  );
});
