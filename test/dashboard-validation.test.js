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
