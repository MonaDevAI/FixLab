import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyAttempts } from "../scripts/ci/run-tests-with-containment.mjs";
import { verifySelfHealing } from "../scripts/ci/verify-self-healing.mjs";

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
