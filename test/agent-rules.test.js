import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { checkAgentRules } from "../scripts/ci/check-agent-rules.mjs";
import {
  checkBranchPolicy,
  checkPolicy
} from "../scripts/ci/check-policy.mjs";

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

test("cross-runtime validation guidance stays aligned", () => {
  const root = join(import.meta.dirname, "..");
  const runtimeEntryPoints = [
    "dashboard/server.js",
    "bin/fixlab.js"
  ];
  const agentEntryPoints = [
    "agents/fixlab.md",
    "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md",
    ".github/agents/fixlab-autofix.agent.md"
  ];
  const entryPoints = [...runtimeEntryPoints, ...agentEntryPoints];

  for (const entryPoint of entryPoints) {
    const content = readFileSync(join(root, entryPoint), "utf8");
    assert.match(
      content,
      /primary\s+business-data\s+source/,
      `${entryPoint} must preserve backend-first validation guidance`
    );
    assert.match(
      content,
      /read-only/,
      `${entryPoint} must preserve read-only backend access`
    );
    assert.match(
      content,
      /intercept(?:\s+every)?\s+mutat/,
      `${entryPoint} must preserve mutation interception`
    );
    assert.match(
      content,
      /(?:unreachable|access fails|access prevents the read)/,
      `${entryPoint} must preserve access-failure fallback conditions`
    );
    assert.match(
      content,
      /no safe records/,
      `${entryPoint} must preserve safe-record fallback conditions`
    );
    assert.match(
      content,
      /expected\s+empty[- ]state|expected\s+empty\s+state/,
      `${entryPoint} must preserve empty-state behavior`
    );
    assert.match(
      content,
      /synthetic pass proves\s+(?:the\s+)?UI\s+behavior\s+only/,
      `${entryPoint} must preserve the synthetic fallback limitation`
    );
    assert.match(
      content,
      /transient validation artifact/,
      `${entryPoint} must preserve transient Playwright cleanup guidance`
    );
    assert.match(
      content,
      /\*\.auth\.spec\.ts/,
      `${entryPoint} must preserve authenticated-test persistence guidance`
    );
  }

  for (const entryPoint of agentEntryPoints) {
    const content = readFileSync(join(root, entryPoint), "utf8");
    assert.match(
      content,
      /profile selects `non-production-read-only`[\s\S]{0,160}selects any profile-approved non-production environment[\s\S]{0,220}primary business-data source/,
      `${entryPoint} must condition backend-first guidance on both profile source and environment selection`
    );
    assert.match(
      content,
      /Fall back to `synthetic-intercepted` only when[\s\S]{0,180}(?:unreachable|access fails)[\s\S]{0,180}no safe records/,
      `${entryPoint} must condition synthetic fallback on access or safe-record failure`
    );
  }

  const browserRule = readFileSync(
    join(
      root,
      ".github",
      "instructions",
      "browser-event-registration.instructions.md"
    ),
    "utf8"
  );
  assert.match(browserRule, /applyTo: "dashboard\/public\/\*\*\/\*\.js"/);
  assert.match(browserRule, /event registration/);
});

test("repository policy matches enforced CI and rollback controls", () => {
  const root = join(import.meta.dirname, "..");

  assert.deepEqual(checkPolicy(root), []);
});

test("branch policy requires contributor review while allowing owner bypass", () => {
  const policy = {
    targetBranch: "main",
    maintainerModel: "owner-bypass",
    requiredStatusChecks: ["test", "analyze"],
    pullRequest: {
      requiredApprovingReviews: 1,
      dismissStaleApprovals: true,
      requireCodeOwnerReview: true,
      requireReviewThreadResolution: true
    },
    history: {
      requireLinearHistory: true,
      blockDeletion: true,
      blockForcePush: true
    },
    bypass: {
      repositoryRole: "admin"
    }
  };

  assert.deepEqual(checkBranchPolicy(policy), []);
  for (const invalidCount of [0, "1", true, 1.5, Infinity]) {
    policy.pullRequest.requiredApprovingReviews = invalidCount;
    assert.ok(
      checkBranchPolicy(policy).includes(
        "branch policy must require contributor approval"
      )
    );
  }
  policy.pullRequest.requiredApprovingReviews = 1;
  policy.pullRequest.requireCodeOwnerReview = false;
  assert.ok(
    checkBranchPolicy(policy).includes(
      "branch policy must require code-owner review"
    )
  );
  policy.pullRequest.requireCodeOwnerReview = true;
  policy.bypass.repositoryRole = "maintain";
  assert.ok(
    checkBranchPolicy(policy).includes(
      "branch policy must reserve owner bypass for repository administrators"
    )
  );
  policy.bypass.repositoryRole = "admin";
  policy.maintainerModel = "solo";
  assert.ok(
    checkBranchPolicy(policy).includes(
      "branch policy must declare the owner-bypass maintainer model"
    )
  );
});
