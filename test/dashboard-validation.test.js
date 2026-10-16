import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ValidationSession, validationGates } from "../dashboard/validation-gates.js";
import { repositoryState, reusableValidationCommand } from "../bin/structured-command.js";
import { createCacheContext } from "../dashboard/server.js";

function git(repository, args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function fixture() {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-gates-"));
  mkdirSync(join(repository, ".github", "fixlab"), { recursive: true });
  const profile = {
    validation: {
      gates: [{
        id: "tests",
        command: process.execPath,
        args: ["-e", "console.log('# tests 1');console.log('# pass 1')"],
        workingDirectory: ".",
        timeoutSeconds: 30
      }]
    }
  };
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  writeFileSync(join(repository, "source.txt"), "initial");
  git(repository, ["init", "--quiet"]);
  git(repository, ["add", "."]);
  git(repository, ["-c", "user.name=FixLab Test", "-c", "user.email=fixlab@example.test", "commit", "--quiet", "-m", "fixture"]);
  return { repository, profile };
}

function apiFixture() {
  const { repository, profile } = fixture();
  profile.validation.gates.push({
    id: "frontend-tests",
    command: process.execPath,
    args: ["-e", "process.exit(23)"],
    workingDirectory: ".",
    timeoutSeconds: 30
  });
  profile.validation.apiOnly = {
    baseRef: "validation-base",
    paths: ["api"],
    fullValidationPaths: ["api/Contracts"],
    gateIds: ["tests"]
  };
  mkdirSync(join(repository, "api", "Contracts"), { recursive: true });
  mkdirSync(join(repository, "web"));
  writeFileSync(join(repository, "api", "service.cs"), "initial");
  writeFileSync(join(repository, "api", "Contracts", "response.cs"), "initial");
  writeFileSync(join(repository, "web", "view.ts"), "initial");
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  git(repository, ["add", "."]);
  git(repository, ["-c", "user.name=FixLab Test", "-c", "user.email=fixlab@example.test", "commit", "--quiet", "-m", "API policy"]);
  git(repository, ["branch", "validation-base"]);
  return { repository, profile };
}

test("API-only validation excludes frontend execution without reporting it passed", async () => {
  const { repository, profile } = apiFixture();
  try {
    writeFileSync(join(repository, "api", "service.cs"), "corrected");
    const session = new ValidationSession(repository, profile, "validate-only", {
      validationIntent: "affected"
    });
    const excluded = await session.run("frontend-tests", repository, profile);
    assert.equal(excluded.outcome, "not-applicable");
    assert.match(excluded.summary, /NOT APPLICABLE/);
    assert.equal((await session.run("tests", repository, profile)).status, 0);
    const validation = session.verify();
    assert.equal(validation.status, "passed");
    assert.equal(validation.scope, "api-only");
    assert.match(validation.message, /API-scope validation passed/);
    assert.equal(validation.gates[1].status, "not-applicable");
    assert.equal(validation.gates[1].required, false);
    assert.match(validation.gates[1].reason, /API-only/);
    assert.equal(validation.gates[1].evidenceDirectory, undefined);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only validation is opt-in and explicit full validation never excludes gates", async () => {
  const { repository, profile } = apiFixture();
  try {
    writeFileSync(join(repository, "api", "service.cs"), "corrected");
    for (const validationIntent of ["full", "scoped"]) {
      const session = new ValidationSession(repository, profile, "validate-only", { validationIntent });
      assert.equal(session.summary().scope, "all");
      assert.equal((await session.run("frontend-tests", repository, profile)).status, 23);
      assert.equal(session.verify().status, "blocked");
    }
    delete profile.validation.apiOnly;
    const session = new ValidationSession(repository, profile, "validate-only", {
      validationIntent: "affected"
    });
    assert.equal(session.summary().scope, "all");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only status polling reuses checkpoint scope without repeatedly scanning Git", () => {
  const { repository, profile } = apiFixture();
  try {
    writeFileSync(join(repository, "api", "service.cs"), "corrected");
    const session = new ValidationSession(repository, profile, "validate-only", {
      validationIntent: "affected"
    });
    const classify = session.changeScope.bind(session);
    let inspections = 0;
    session.changeScope = () => {
      inspections += 1;
      return classify();
    };
    for (let read = 0; read < 20; read += 1) {
      assert.equal(session.summary().scope, "api-only");
    }
    assert.equal(inspections, 0);
    session.verify();
    assert.equal(inspections, 1);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only scope inspects committed, staged, unstaged, untracked, deleted and renamed paths", () => {
  const cases = [
    ["unstaged API", "api-only", (repository) => writeFileSync(join(repository, "api", "service.cs"), "changed")],
    ["staged API", "api-only", (repository) => {
      writeFileSync(join(repository, "api", "service.cs"), "changed");
      git(repository, ["add", "."]);
    }],
    ["committed API", "api-only", (repository) => {
      writeFileSync(join(repository, "api", "service.cs"), "changed");
      git(repository, ["add", "."]);
      git(repository, ["-c", "user.name=FixLab Test", "-c", "user.email=fixlab@example.test", "commit", "--quiet", "-m", "API change"]);
    }],
    ["untracked API", "api-only", (repository) => writeFileSync(join(repository, "api", "new.cs"), "new")],
    ["deleted API", "api-only", (repository) => rmSync(join(repository, "api", "service.cs"))],
    ["contract", "all", (repository) => writeFileSync(join(repository, "api", "Contracts", "response.cs"), "changed")],
    ["untracked frontend", "all", (repository) => writeFileSync(join(repository, "web", "new.ts"), "new")],
    ["shared configuration", "all", (repository) => writeFileSync(join(repository, "shared.json"), "{}")],
    ["renamed out of API", "all", (repository) => renameSync(join(repository, "api", "service.cs"), join(repository, "web", "service.cs"))],
    ["staged frontend hidden by worktree", "all", (repository) => {
      writeFileSync(join(repository, "web", "view.ts"), "staged");
      git(repository, ["add", "."]);
      writeFileSync(join(repository, "web", "view.ts"), "initial");
    }],
    ["committed frontend hidden by worktree", "all", (repository) => {
      writeFileSync(join(repository, "web", "view.ts"), "committed");
      git(repository, ["add", "."]);
      git(repository, ["-c", "user.name=FixLab Test", "-c", "user.email=fixlab@example.test", "commit", "--quiet", "-m", "Frontend change"]);
      writeFileSync(join(repository, "web", "view.ts"), "initial");
    }],
    ["directory prefix lookalike", "all", (repository) => {
      mkdirSync(join(repository, "api-extra"));
      writeFileSync(join(repository, "api-extra", "new.cs"), "new");
    }],
    ["empty diff", "all", () => {}]
  ];
  for (const [name, expected, change] of cases) {
    const { repository, profile } = apiFixture();
    try {
      change(repository);
      const session = new ValidationSession(repository, profile, "validate-only", {
        validationIntent: "affected"
      });
      assert.equal(session.summary().scope, expected, name);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }
});

test("API-only scope expands after edits, preserves failures and never rebases saved evidence", async () => {
  const { repository, profile } = apiFixture();
  try {
    writeFileSync(join(repository, "api", "service.cs"), "corrected");
    const session = new ValidationSession(repository, profile, "validate-only", {
      validationIntent: "affected"
    });
    assert.equal((await session.run("tests", repository, profile)).status, 0);
    assert.equal(session.verify().status, "passed");
    writeFileSync(join(repository, "web", "view.ts"), "frontend change");
    assert.equal(session.verify().scope, "all");
    assert.equal(session.verify().status, "blocked");
    assert.equal(session.summary().gates[0].status, "stale");
    assert.equal((await session.run("frontend-tests", repository, profile)).status, 23);
    writeFileSync(join(repository, "web", "view.ts"), "initial");
    assert.equal(session.verify().scope, "api-only");
    assert.equal(session.summary().gates[1].status, "failed");
    assert.equal(session.summary().gates[1].required, true);
    assert.equal(session.verify().status, "blocked");
    const baseline = session.baseCommit;
    git(repository, ["add", "."]);
    git(repository, ["-c", "user.name=FixLab Test", "-c", "user.email=fixlab@example.test", "commit", "--quiet", "-m", "Correct API"]);
    git(repository, ["branch", "-f", "validation-base", "HEAD"]);
    const restored = new ValidationSession(repository, profile, "validate-only", {
      validationIntent: "affected", baseCommit: baseline
    });
    assert.equal(restored.baseCommit, baseline);
    assert.equal(restored.summary().scope, "api-only");
    assert.equal(restored.summary().status, "pending");
    for (const baseCommit of [null, "f".repeat(40)]) {
      const unknown = new ValidationSession(repository, profile, "validate-only", {
        validationIntent: "affected", baseCommit
      });
      assert.equal(unknown.summary().scope, "all");
      assert.ok(unknown.summary().reason);
    }
    const missingRefProfile = structuredClone(profile);
    missingRefProfile.validation.apiOnly.baseRef = "missing-base";
    const unknown = new ValidationSession(repository, missingRefProfile, "validate-only", {
      validationIntent: "affected"
    });
    assert.equal(unknown.summary().scope, "all");
    assert.match(unknown.summary().reason, /Could not verify/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only policy rejects ambiguous configuration instead of silently weakening gates", () => {
  const { repository, profile } = apiFixture();
  try {
    for (const invalid of [
      null, { baseRef: "" }, { gateIds: [] }, { gateIds: ["unknown"] },
      { gateIds: ["tests", "tests"] }, { baseRef: "--all" },
      { paths: [] }, { paths: ["."] }, { paths: ["../api"] },
      { paths: ["C:\\api"] }, { paths: ["/api"] }, { paths: ["api/**"] },
      { fullValidationPaths: [] }, { fullValidationPaths: ["api/../web"] }
    ]) {
      const changed = structuredClone(profile);
      changed.validation.apiOnly = invalid === null ? null : { ...changed.validation.apiOnly, ...invalid };
      assert.throws(() => validationGates(changed, "validate-only"), /validation.apiOnly/);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only recovery keeps executed gate outcomes but never trusts saved passes", async () => {
  const { repository, profile } = apiFixture();
  try {
    writeFileSync(join(repository, "api", "service.cs"), "corrected");
    for (const status of ["passed", "failed", "cancelled", "stale", "running"]) {
      const session = new ValidationSession(repository, profile, "validate-only", {
        validationIntent: "affected",
        history: { complete: true, gates: [{ id: "frontend-tests", status, exitCode: 23 }] }
      });
      const restored = session.summary().gates[1];
      assert.equal(restored.required, true);
      assert.equal(restored.status, ["failed", "cancelled"].includes(status) ? status : "stale");
      assert.equal(restored.exitCode, 23);
      assert.equal((await session.run("tests", repository, profile)).status, 0);
      assert.equal(session.summary().status, "blocked");
      assert.equal(session.executedGates().gates.length, 2);
    }
    const unknown = new ValidationSession(repository, profile, "validate-only", {
      validationIntent: "affected", history: null
    });
    assert.equal(unknown.summary().scope, "all");
    assert.match(unknown.summary().reason, /history is unavailable/);
    assert.equal(unknown.executedGates().complete, false);
    for (const history of [
      {}, { complete: true, gates: [{ id: "unknown", status: "passed" }] },
      { complete: true, gates: [{ id: "tests", status: "invented" }] },
      { complete: true, gates: [{ id: "tests", status: "passed", exitCode: "0" }] },
      { complete: true, gates: [{ id: "tests", status: "failed" }, { id: "tests", status: "passed" }] }
    ]) {
      assert.throws(() => new ValidationSession(repository, profile, "validate-only", { history }), /Saved validation history is invalid/);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("validation gate configuration is explicit and bounded", () => {
  assert.equal(validationGates({}, "validate-only"), null);
  assert.deepEqual(validationGates({}, "playwright-only"), []);
  for (const gates of [[], new Array(21).fill({}), [{ id: "../escape" }]]) {
    assert.throws(() => validationGates({ validation: { gates } }, "validate-only"), /gate/);
  }
  for (const args of [
    ["run", "test:e2e"], ["run", "test:integration"], ["run", "format"],
    ["run", "validate"], ["ci"], ["install"]
  ]) {
    assert.equal(reusableValidationCommand("npm", args), false);
  }
  assert.equal(reusableValidationCommand("npx", ["playwright", "test"]), false);
  assert.equal(reusableValidationCommand("npm", ["run", "type-check"]), true);
});

test("gates bind actual results to one Git worktree and invalidate changed instructions", async () => {
  const { repository, profile } = fixture();
  const worktree = mkdtempSync(join(tmpdir(), "fixlab-gate-worktree-"));
  const other = fixture();
  try {
    git(repository, ["worktree", "add", "--quiet", "--detach", worktree]);
    const session = new ValidationSession(repository, profile, "validate-only");
    await assert.rejects(session.run("tests", other.repository, profile), /this repository/);
    assert.equal((await session.run("tests", worktree, profile)).status, 0);
    assert.equal(session.verify().status, "passed");
    await assert.rejects(session.run("tests", repository, profile), /same worktree/);
    writeFileSync(join(worktree, "AGENTS.md"), "New instructions");
    assert.equal(session.verify().gates[0].status, "stale");
    assert.equal((await session.run("tests", worktree, profile)).status, 0);
    writeFileSync(join(worktree, ".github", "fixlab", "repository-profile.json"), "{}");
    assert.equal(session.verify().status, "blocked");
  } finally {
    git(repository, ["worktree", "remove", "--force", worktree]);
    rmSync(repository, { recursive: true, force: true });
    rmSync(other.repository, { recursive: true, force: true });
  }
});

test("failed, timed out, cancelled, and source-mutating checks cannot pass gates", async () => {
  const { repository, profile } = fixture();
  try {
    for (const script of [
      "process.exitCode=2",
      "setTimeout(()=>{},10000)",
      "require('node:fs').writeFileSync('source.txt','changed')"
    ]) {
      profile.validation.gates[0].args = ["-e", script];
      profile.validation.gates[0].timeoutSeconds = script.includes("setTimeout") ? 1 : 30;
      const session = new ValidationSession(repository, profile, "validate-only");
      const result = await session.run("tests", repository, profile, { terminationGraceMs: 10 });
      assert.notEqual(result.status, 0);
      assert.notEqual(session.summary().gates[0].status, "passed");
    }
    const session = new ValidationSession(repository, profile, "validate-only");
    let kills = 0;
    const run = session.run("tests", repository, profile, {
      terminationGraceMs: 10,
      spawn() {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => { kills += 1; };
        setImmediate(() => session.cancel());
        return child;
      }
    });
    assert.equal((await run).status, 130);
    assert.equal(session.summary().gates[0].status, "cancelled");
    assert.ok(kills >= 1);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("a nonzero gate exit with changed inputs is stale and preserves the original failure evidence", async () => {
  const { repository, profile } = fixture();
  try {
    profile.validation.gates[0].args = [
      "-e", "require('node:fs').writeFileSync('source.txt','changed');process.exitCode=2"
    ];
    const session = new ValidationSession(repository, profile, "validate-only");
    const result = await session.run("tests", repository, profile);
    assert.equal(result.status, 2);
    assert.match(result.summary, /source inputs changed during validation/);
    assert.equal(session.summary().gates[0].status, "stale");
    assert.equal(session.summary().gates[0].exitCode, 2);
    assert.equal(session.summary().status, "blocked");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("gates fingerprint unstaged deletions and renames including instructions", async () => {
  for (const operation of ["delete", "rename"]) {
    const { repository, profile } = fixture();
    try {
      writeFileSync(join(repository, "AGENTS.md"), "Tracked instructions");
      git(repository, ["add", "AGENTS.md"]);
      git(repository, ["-c", "user.name=FixLab Test", "-c", "user.email=fixlab@example.test", "commit", "--quiet", "-m", "instructions"]);
      const initial = repositoryState(repository);
      const session = new ValidationSession(repository, profile, "validate-only");
      assert.equal((await session.run("tests", repository, profile)).status, 0);
      for (const path of ["source.txt", "AGENTS.md"]) {
        if (operation === "delete") {
          rmSync(join(repository, path));
        } else {
          renameSync(join(repository, path), join(repository, `renamed-${path}`));
        }
      }
      const changed = repositoryState(repository);
      assert.notEqual(changed.worktreeHash, initial.worktreeHash);
      assert.notEqual(changed.instructionHash, initial.instructionHash);
      assert.equal(session.verify().gates[0].status, "stale");
      assert.equal((await session.run("tests", repository, profile)).status, 0);
      assert.equal(session.verify().status, "passed");
      git(repository, ["add", "-A"]);
      assert.equal(session.verify().gates[0].status, "stale");
      assert.equal((await session.run("tests", repository, profile)).status, 0);
      assert.equal(session.verify().status, "passed");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }
});

test("repository memory invalidates on source and instruction edits without retaining contents", () => {
  const { repository } = fixture();
  try {
    const initial = createCacheContext(repository);
    writeFileSync(join(repository, "source.txt"), "modified source");
    const source = createCacheContext(repository);
    assert.notEqual(source.key, initial.key);
    writeFileSync(join(repository, "AGENTS.md"), "Private instruction content");
    const instruction = createCacheContext(repository);
    assert.notEqual(instruction.instructionHash, source.instructionHash);
    assert.doesNotMatch(JSON.stringify(instruction), /Private instruction content|modified source/);
    assert.equal(readFileSync(join(repository, "source.txt"), "utf8"), "modified source");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
