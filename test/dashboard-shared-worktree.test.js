import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareSharedWorktree, reviewSharedWorktree, sharedWorktreeConfig, sharedWorktreeGuidance, stashReviewedSharedWorktree, verifySharedWorktreeBranch } from "../dashboard/shared-worktree.js";

function git(repository, ...args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fixlab-shared-worktree-"));
  const source = join(root, "source");
  const repository = join(root, "runner");
  mkdirSync(source);
  git(source, "init", "--quiet", "-b", "develop");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "tracked.txt"), "base");
  writeFileSync(join(source, ".gitignore"), ".edge-profile/\nignored.txt\n");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "base");
  git(root, "clone", "--quiet", source, repository);
  git(repository, "config", "user.name", "Fixture");
  git(repository, "config", "user.email", "fixture@example.test");
  const profile = {
    worktreeSetup: { mode: "shared", baseBranch: "develop" },
    pullRequests: {
      defaultTargetBranch: "develop",
      branchNaming: { userId: "developer", prefixTemplate: "users/{userId}" }
    }
  };
  return { root, source, repository, profile };
}

function prepare(f, options = {}) {
  return prepareSharedWorktree({ ...f, jobId: randomUUID(), ...options });
}

test("shared jobs reuse one folder but refresh the base and retain separate resumable branches", () => {
  const f = fixture();
  try {
    const firstId = randomUUID();
    const first = prepare(f, { jobId: firstId });
    assert.equal(first.baseCommit, git(f.source, "rev-parse", "HEAD"));
    writeFileSync(join(f.repository, "fix.txt"), "first job");
    git(f.repository, "add", "fix.txt");
    git(f.repository, "commit", "--quiet", "-m", "first fix");
    const firstCommit = git(f.repository, "rev-parse", "HEAD");
    mkdirSync(join(f.repository, ".edge-profile"));
    writeFileSync(join(f.repository, ".edge-profile", "fixture-marker"), "local fixture");
    writeFileSync(join(f.source, "upstream.txt"), "updated base");
    git(f.source, "add", "upstream.txt");
    git(f.source, "commit", "--quiet", "-m", "advance base");
    const second = prepare(f);
    assert.notEqual(second.branch, first.branch);
    assert.equal(second.baseCommit, git(f.source, "rev-parse", "HEAD"));
    assert.equal(existsSync(join(f.repository, "fix.txt")), false);
    assert.equal(readFileSync(join(f.repository, "upstream.txt"), "utf8"), "updated base");
    assert.equal(readFileSync(join(f.repository, ".edge-profile", "fixture-marker"), "utf8"), "local fixture");
    git(f.repository, "remote", "set-url", "origin", join(f.root, "unavailable"));
    assert.deepEqual(prepare(f, { jobId: firstId, saved: first, resume: true }), first);
    assert.equal(git(f.repository, "rev-parse", "HEAD"), firstCommit);
    assert.equal(readFileSync(join(f.repository, "fix.txt"), "utf8"), "first job");
    assert.equal(existsSync(join(f.repository, "upstream.txt")), false);
    assert.match(sharedWorktreeGuidance(first), /Do not create another worktree/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("shared jobs preserve dirty files, blocked branch acquisition and in-progress Git operations", () => {
  const f = fixture();
  try {
    const id = randomUUID();
    const saved = prepare(f, { jobId: id });
    const head = git(f.repository, "rev-parse", "HEAD");
    writeFileSync(join(f.repository, "untracked.txt"), "preserve");
    assert.throws(() => prepare(f), /uncommitted or untracked/);
    assert.equal(git(f.repository, "rev-parse", "HEAD"), head);
    assert.deepEqual(prepare(f, { jobId: id, saved, resume: true, resourcesRunning: true }), saved);
    assert.equal(readFileSync(join(f.repository, "untracked.txt"), "utf8"), "preserve");
    rmSync(join(f.repository, "untracked.txt"));
    writeFileSync(join(f.repository, "tracked.txt"), "uncommitted fix");
    git(f.repository, "add", "tracked.txt");
    assert.throws(() => prepare(f), /uncommitted or untracked/);
    assert.equal(readFileSync(join(f.repository, "tracked.txt"), "utf8"), "uncommitted fix");
    git(f.repository, "commit", "--quiet", "-m", "preserve fix");
    assert.throws(() => prepare(f, { resourcesRunning: true }), /owned React and authentication/);
    prepare(f);
    assert.throws(() => prepare(f, { jobId: id, saved, resourcesRunning: true }), /reacquiring a different job branch/);
    const mergeHead = join(f.repository, ".git", "MERGE_HEAD");
    writeFileSync(mergeHead, head);
    assert.throws(() => prepare(f), /in-progress Git operation/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("failed refresh never falls back to a stale base or changes the current branch", () => {
  const f = fixture();
  try {
    const branch = git(f.repository, "branch", "--show-current");
    const head = git(f.repository, "rev-parse", "HEAD");
    git(f.repository, "remote", "set-url", "origin", join(f.root, "missing"));
    assert.throws(() => prepare(f), /base refresh failed/);
    assert.equal(git(f.repository, "branch", "--show-current"), branch);
    assert.equal(git(f.repository, "rev-parse", "HEAD"), head);
    assert.equal(git(f.repository, "for-each-ref", "--format=%(refname)", "refs/heads/users/"), "");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("resume refuses missing, rewritten and externally checked-out saved branches", () => {
  const f = fixture();
  try {
    const id = randomUUID();
    const saved = prepare(f, { jobId: id });
    const second = prepare(f);
    const other = join(f.root, "other");
    git(f.repository, "worktree", "add", "--quiet", other, saved.branch);
    assert.throws(() => prepare(f, { jobId: id, saved }), /branch reacquisition failed/);
    assert.equal(git(f.repository, "branch", "--show-current"), second.branch);
    assert.throws(() => verifySharedWorktreeBranch(f.repository, saved), /assigned branch/);
    assert.throws(() => prepare(f, { jobId: id, saved: { ...saved, baseCommit: "0".repeat(40) } }), /ancestry verification failed/);
    git(f.repository, "worktree", "remove", other);
    git(f.repository, "branch", "-d", saved.branch);
    assert.throws(() => prepare(f, { jobId: id, saved }), /Saved branch verification failed/);
    assert.equal(git(f.repository, "branch", "--show-current"), second.branch);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("branch acquisition never overwrites ignored local files", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repository, "ignored.txt"), "local fixture");
    writeFileSync(join(f.source, "ignored.txt"), "remote fixture");
    git(f.source, "add", "-f", "ignored.txt");
    git(f.source, "commit", "--quiet", "-m", "track previously ignored file");
    assert.throws(() => prepare(f), /branch creation failed/);
    assert.equal(git(f.repository, "branch", "--show-current"), "develop");
    assert.equal(readFileSync(join(f.repository, "ignored.txt"), "utf8"), "local fixture");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("shared configuration is explicit and invalid or legacy ownership fails closed", () => {
  const f = fixture();
  try {
    assert.equal(sharedWorktreeConfig({}, f.repository), null);
    assert.equal(sharedWorktreeConfig({ worktreeSetup: { mode: "isolated" } }, f.repository), null);
    assert.equal(prepareSharedWorktree({ repository: f.repository, profile: {}, jobId: "unused" }), null);
    const defaults = structuredClone(f.profile);
    delete defaults.worktreeSetup.baseBranch;
    assert.equal(sharedWorktreeConfig(defaults, f.repository).baseBranch, "develop");
    for (const worktreeSetup of [
      { mode: "unknown" }, { mode: "shared", remote: "--upload-pack=evil" },
      { mode: "shared", baseBranch: "develop^{commit}" }, { mode: "shared", baseBranch: "../develop" }
    ]) {
      assert.throws(() => sharedWorktreeConfig({ ...f.profile, worktreeSetup }, f.repository));
    }
    assert.throws(() => sharedWorktreeConfig({ worktreeSetup: { mode: "shared" } }, f.repository), /baseBranch/);
    assert.throws(() => sharedWorktreeConfig({ ...f.profile, pullRequests: {} }, f.repository), /branchNaming/);
    assert.throws(() => sharedWorktreeConfig(f.profile, f.root), /repository verification failed/);
    mkdirSync(join(f.repository, "nested"));
    assert.throws(() => sharedWorktreeConfig(f.profile, join(f.repository, "nested")), /checkout root/);
    rmdirSync(join(f.repository, "nested"));
    assert.throws(() => prepare(f, { jobId: "--bad" }), /valid job ID/);
    assert.throws(() => prepare(f, { resume: true }), /older job.*no saved/);
    const id = randomUUID();
    const saved = prepare(f, { jobId: id });
    assert.throws(() => prepare(f, { jobId: randomUUID(), saved }), /ownership is invalid/);
    assert.throws(() => prepare(f, { jobId: id, saved, profile: {} }), /restore shared mode/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("explicit reviewed reuse preserves a dirty existing PR branch without fetching or switching", () => {
  const f = fixture();
  try {
    const originalId = randomUUID();
    const original = prepare(f, { jobId: originalId });
    writeFileSync(join(f.repository, "tracked.txt"), "reviewed work");
    writeFileSync(join(f.repository, "untracked.ts"), "preserve too");
    const review = reviewSharedWorktree(f.repository, f.profile);
    assert.equal(review.branch, original.branch);
    assert.equal(review.dirty, true);
    git(f.repository, "remote", "set-url", "origin", join(f.root, "unavailable"));
    const jobId = randomUUID();
    const saved = prepare(f, { jobId, resume: true, reviewedWorkspace: review });
    assert.equal(saved.branch, original.branch);
    assert.equal(saved.reusedFromJobId, originalId);
    assert.equal(readFileSync(join(f.repository, "tracked.txt"), "utf8"), "reviewed work");
    assert.equal(readFileSync(join(f.repository, "untracked.ts"), "utf8"), "preserve too");
    assert.deepEqual(prepare(f, { jobId, saved, resume: true, resourcesRunning: true }), saved);
    assert.match(sharedWorktreeGuidance(saved), /existing PR for this branch/);
    assert.throws(() => stashReviewedSharedWorktree({ ...f, reviewedWorkspace: review }), /tracked changes/);
    writeFileSync(join(f.repository, "tracked.txt"), "base");
    const freshReview = reviewSharedWorktree(f.repository, f.profile);
    assert.equal(freshReview.freshBranch.available, true);
    assert.deepEqual(freshReview.freshBranch.files, ["untracked.ts"]);
    writeFileSync(join(f.repository, "untracked.ts"), "updated preserved source");
    assert.throws(() => stashReviewedSharedWorktree({ ...f, reviewedWorkspace: freshReview }), /changed since review/);
    const receipt = stashReviewedSharedWorktree({
      ...f, reviewedWorkspace: reviewSharedWorktree(f.repository, f.profile)
    });
    assert.equal(git(f.repository, "show", `${receipt.stashRef}^3:untracked.ts`), "updated preserved source");
    assert.equal(existsSync(join(f.repository, "untracked.ts")), false);
    assert.equal(git(f.repository, "branch", "--show-current"), original.branch);
    git(f.repository, "remote", "set-url", "origin", f.source);
    writeFileSync(join(f.source, "new-base.md"), "latest base");
    git(f.source, "add", ".");
    git(f.source, "commit", "--quiet", "-m", "Advance develop");
    const next = prepare(f);
    assert.notEqual(next.branch, original.branch);
    assert.equal(next.baseCommit, git(f.source, "rev-parse", "HEAD"));
    assert.equal(readFileSync(join(f.repository, "new-base.md"), "utf8"), "latest base");
    assert.equal(git(f.repository, "rev-parse", original.branch), original.baseCommit);
    assert.equal(git(f.repository, "stash", "list", "--max-count=1", "--format=%H"), receipt.stashRef);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("workspace reuse rejects stale reviews, protected branches and in-progress Git operations", () => {
  const f = fixture();
  try {
    assert.equal(reviewSharedWorktree(f.repository, f.profile), null);
    prepare(f);
    const review = reviewSharedWorktree(f.repository, f.profile);
    writeFileSync(join(f.repository, "tracked.txt"), "not reviewed");
    assert.throws(() => prepare(f, { reviewedWorkspace: review }), /changed since review/);
    const fresh = reviewSharedWorktree(f.repository, f.profile);
    writeFileSync(join(f.repository, ".git", "MERGE_HEAD"), fresh.head);
    assert.throws(() => prepare(f, { reviewedWorkspace: fresh }), /in-progress Git operation/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
