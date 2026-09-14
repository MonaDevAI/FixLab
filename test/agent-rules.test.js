import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { checkAgentRules } from "../scripts/ci/check-agent-rules.mjs";
import { checkPolicy } from "../scripts/ci/check-policy.mjs";

test("agent rule governance accepts a bounded lifecycle corpus", () => {
  const root = mkdtempSync(join(tmpdir(), "fixlab-agent-rules-"));
  const instructions = join(root, ".github", "instructions");
  mkdirSync(instructions, { recursive: true });
  writeFileSync(
    join(root, ".github", "copilot-code-review.yml"),
    JSON.stringify({
      corpus: ".github/instructions/learned-rules.instructions.md",
      promotion: { minimumDistinctRuns: 2, maximumActiveRules: 3 }
    })
  );
  writeFileSync(
    join(instructions, "learned-rules.instructions.md"),
    [
      "# Active learned rules",
      "## Keep validation deterministic",
      "# Candidate rules",
      "# Retired rules"
    ].join("\n")
  );

  try {
    assert.deepEqual(checkAgentRules(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository policy matches enforced CI and rollback controls", () => {
  const root = join(import.meta.dirname, "..");

  assert.deepEqual(checkPolicy(root), []);
});
