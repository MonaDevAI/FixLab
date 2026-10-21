import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { repositoryState } from "../bin/structured-command.js";
import { createRuntimePermissionPolicy } from "./runtime-permission-policy.js";
import { safeRuntimeText } from "./runtime-requests.js";

const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function verifyIdleGit(repository) {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    const value = git(repository, ["rev-parse", "--git-path", name], "Git operation verification");
    if (existsSync(isAbsolute(value) ? value : resolve(repository, value))) {
      throw new Error("Finish the in-progress Git operation before reusing the shared worktree");
    }
  }
}

function git(repository, args, description, raw = false) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${description} failed (${result.error?.code ?? `Git exit ${result.status}`}). ` +
      "Resolve the Git prerequisite and retry; FixLab will not reset, stash, clean or force-switch this checkout."
    );
  }
  return raw ? result.stdout : result.stdout.trim();
}

function branchRef(repository, branch, description) {
  if (typeof branch !== "string" || !branch || branch.startsWith("-")) {
    throw new Error(`${description} must be a valid Git branch name`);
  }
  git(repository, ["check-ref-format", `refs/heads/${branch}`], description);
  return branch;
}

export function sharedWorktreeConfig(profile, repository) {
  const mode = profile.worktreeSetup?.mode;
  if (mode === undefined || mode === "isolated") {
    return null;
  }
  if (mode !== "shared") {
    throw new Error("worktreeSetup.mode must be shared or isolated");
  }
  const root = realpathSync.native(repository);
  const topLevel = realpathSync.native(git(root, ["rev-parse", "--show-toplevel"], "Shared worktree repository verification"));
  if (root !== topLevel) {
    throw new Error("Shared worktree mode requires the Git checkout root");
  }
  const remote = profile.worktreeSetup.remote ?? "origin";
  if (typeof remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote)) {
    throw new Error("worktreeSetup.remote must be a Git remote name");
  }
  const baseBranch = branchRef(
    root,
    profile.worktreeSetup.baseBranch ?? profile.pullRequests?.defaultTargetBranch,
    "worktreeSetup.baseBranch"
  );
  const naming = profile.pullRequests?.branchNaming;
  if (
    typeof naming?.userId !== "string" ||
    !/^[A-Za-z0-9._-]+$/u.test(naming.userId) ||
    typeof naming.prefixTemplate !== "string" ||
    !naming.prefixTemplate.includes("{userId}")
  ) {
    throw new Error("Shared worktree mode requires pullRequests.branchNaming.userId and prefixTemplate");
  }
  const prefix = branchRef(root, naming.prefixTemplate.replaceAll("{userId}", naming.userId), "Shared branch prefix");
  return { remote, baseBranch, prefix };
}

export function reviewSharedWorktree(repository, profile) {
  const config = sharedWorktreeConfig(profile, repository);
  if (!config) {
    return null;
  }
  const branch = git(repository, ["branch", "--show-current"], "Workspace review");
  const prefix = `${config.prefix}/fixlab-`;
  const owner = branch.startsWith(prefix) ? branch.slice(prefix.length) : "";
  if (!jobIdPattern.test(owner)) {
    return null;
  }
  const state = repositoryState(repository);
  const files = git(repository, ["ls-files", "--others", "--exclude-standard", "-z"], "Untracked file review", true)
    .split("\0").filter(Boolean);
  const policy = createRuntimePermissionPolicy(repository);
  let reason = git(repository, ["status", "--porcelain", "--untracked-files=no"], "Tracked change review")
    ? "Preserve tracked changes separately before starting a fresh branch."
    : files.length > 50 ? "Too many untracked files for automatic recovery; review them separately." : "";
  if (!reason && files.some((file) => {
    const path = resolve(repository, file);
    return !policy.isSourceFile(path) ||
      lstatSync(path).size > 1024 * 1024;
  })) {
    reason = "Untracked files include sensitive, linked, non-source or oversized files; preserve them separately.";
  }
  return {
    branch,
    head: state.head,
    dirty: Boolean(git(repository, ["status", "--porcelain", "--untracked-files=all"], "Workspace review")),
    fingerprint: createHash("sha256").update(JSON.stringify({ branch, config, state })).digest("hex"),
    freshBranch: {
      remote: config.remote, baseBranch: config.baseBranch,
      files: files.slice(0, 50), available: !reason, reason
    }
  };
}

export function stashReviewedSharedWorktree({ repository, profile, reviewedWorkspace }) {
  verifyIdleGit(repository);
  const review = reviewSharedWorktree(repository, profile);
  if (!review || review.branch !== reviewedWorkspace?.branch ||
      review.fingerprint !== reviewedWorkspace?.fingerprint) {
    throw new Error("The workspace changed since review. Review the branch and files again.");
  }
  if (!review.freshBranch.available) {
    throw new Error(review.freshBranch.reason);
  }
  const { files, remote, baseBranch } = review.freshBranch;
  for (const file of files) {
    if (!safeRuntimeText(readFileSync(resolve(repository, file), "utf8"), 1024 * 1024)) {
      throw new Error("A reviewed source file may contain sensitive content; automatic stashing is unavailable.");
    }
  }
  let stashRef = null;
  if (files.length) {
    const previous = git(repository, ["stash", "list", "--max-count=1", "--format=%H"], "Existing stash review");
    git(repository, ["--literal-pathspecs", "stash", "push", "--include-untracked",
      "--message", `FixLab fresh branch from ${review.branch}`, "--", ...files], "Stash reviewed source files");
    stashRef = git(repository, ["stash", "list", "--max-count=1", "--format=%H"], "Saved stash verification");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(stashRef) || stashRef === previous) {
      throw new Error("A new stash could not be verified. Stop and inspect the checkout; no reset or cleanup will be attempted.");
    }
    for (const file of files) {
      git(repository, ["cat-file", "-e", `${stashRef}^3:${file}`], "Stashed file verification");
    }
  }
  const remaining = git(repository, ["status", "--porcelain", "--untracked-files=all"], "Clean checkout verification");
  if (remaining) {
    const summary = safeRuntimeText(remaining, 8000) ? remaining : "Review local Git status for the remaining changes.";
    throw new Error(`The checkout is not clean. Preserved stash: ${stashRef ?? "none"}. No reset or cleanup will be attempted.\n${summary}`);
  }
  return { stashRef, files, previousBranch: review.branch, remote, baseBranch };
}

function recoveryRequired(repository, profile, message) {
  const error = new Error(message);
  error.workspaceReview = reviewSharedWorktree(repository, profile);
  return error;
}

export function prepareSharedWorktree({ repository, profile, jobId, saved = null, resume = false, resourcesRunning = false, reviewedWorkspace = null }) {
  const config = sharedWorktreeConfig(profile, repository);
  if (!config) {
    if (saved) {
      throw new Error("This job owns a shared worktree branch; restore shared mode before resuming it");
    }
    return null;
  }
  if (!jobIdPattern.test(jobId)) {
    throw new Error("Shared worktree jobs require a valid job ID");
  }
  verifyIdleGit(repository);
  const currentBranch = git(repository, ["branch", "--show-current"], "Current branch verification");
  const dirty = git(repository, ["status", "--porcelain", "--untracked-files=all"], "Shared worktree cleanliness check");
  if (reviewedWorkspace) {
    const current = reviewSharedWorktree(repository, profile);
    if (!current || current.branch !== reviewedWorkspace.branch ||
        current.fingerprint !== reviewedWorkspace.fingerprint) {
      throw recoveryRequired(repository, profile, "The workspace changed since review. Review the current branch and diff again before approving reuse.");
    }
    if (saved && saved.branch !== current.branch) {
      throw new Error("Reviewed reuse cannot replace this job's assigned branch.");
    }
    const baseCommit = git(repository, [
      "merge-base", "HEAD", `refs/remotes/${config.remote}/${config.baseBranch}`
    ], "Existing branch base verification");
    return {
      mode: "shared", branch: current.branch, baseCommit,
      remote: config.remote, baseBranch: config.baseBranch,
      reusedFromJobId: current.branch.slice(`${config.prefix}/fixlab-`.length)
    };
  }
  if (saved) {
    const branch = branchRef(repository, saved.branch, "Saved job branch");
    if (
      saved.mode !== "shared" ||
      !(saved.reusedFromJobId
        ? jobIdPattern.test(saved.reusedFromJobId) && branch === `${config.prefix}/fixlab-${saved.reusedFromJobId}`
        : branch.endsWith(`/fixlab-${jobId}`)) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(saved.baseCommit) ||
      typeof saved.remote !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(saved.remote)
    ) {
      throw new Error("Saved shared-worktree ownership is invalid; refusing to select a different branch");
    }
    branchRef(repository, saved.baseBranch, "Saved base branch");
    git(repository, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], "Saved branch verification");
    git(repository, ["merge-base", "--is-ancestor", saved.baseCommit, `refs/heads/${branch}`], "Saved branch ancestry verification");
    if (currentBranch !== branch) {
      if (resourcesRunning) {
        throw new Error("Stop the shared checkout's owned React and authentication sessions before reacquiring a different job branch");
      }
      if (dirty) {
        throw new Error("The shared worktree has uncommitted or untracked files; preserve them before reacquiring this job's branch");
      }
      git(repository, ["switch", "--no-guess", "--no-overwrite-ignore", branch], "Saved branch reacquisition");
    }
    return saved;
  }
  if (resume) {
    throw recoveryRequired(repository, profile, "This older job has no saved shared-worktree branch. Resume it with its original workspace policy or explicitly review and reuse the current job branch; do not guess its branch");
  }
  if (resourcesRunning) {
    throw recoveryRequired(repository, profile, "Stop the shared checkout's owned React and authentication sessions before starting another job branch, or explicitly review reuse of the current branch");
  }
  if (dirty) {
    throw recoveryRequired(repository, profile, "The shared worktree has uncommitted or untracked files; preserve them before starting another job, or explicitly review reuse of the current branch");
  }
  const branch = branchRef(repository, `${config.prefix}/fixlab-${jobId}`, "New job branch");
  git(repository, [
    "fetch", "--no-tags", config.remote,
    `+refs/heads/${config.baseBranch}:refs/remotes/${config.remote}/${config.baseBranch}`
  ], "Shared worktree base refresh");
  const baseCommit = git(repository, [
    "rev-parse", "--verify", `refs/remotes/${config.remote}/${config.baseBranch}^{commit}`
  ], "Fetched base verification");
  git(repository, ["switch", "--no-guess", "--no-overwrite-ignore", "-c", branch, baseCommit], "New job branch creation");
  return { mode: "shared", branch, baseCommit, remote: config.remote, baseBranch: config.baseBranch };
}

export function verifySharedWorktreeBranch(repository, workspace) {
  if (workspace && git(repository, ["branch", "--show-current"], "Completed job branch verification") !== workspace.branch) {
    throw new Error("The agent changed the shared checkout's assigned branch. Reconcile the saved job branch before resuming; its result cannot be accepted");
  }
}

export function sharedWorktreeGuidance(workspace) {
  if (!workspace) {
    return "";
  }
  return `\nShared worktree contract:
- The dashboard has exclusively acquired this checkout on branch ${workspace.branch}, based on ${workspace.remote}/${workspace.baseBranch} at ${workspace.baseCommit}.
- Work in this checkout and on this exact branch. Do not create another worktree, switch branches, reset, stash, clean, or merge/rebase the base branch.
- Reuse this job's existing PR on resume. Another job can use the same folder only after owned execution stops and the checkout is clean.
- When this branch was explicitly reused, continue its existing PR for this branch; do not create a duplicate PR or discard reviewed uncommitted changes.
- Check dependency and configuration readiness for the selected branch; cached dependencies are not proof that changed manifests were restored.
- Recheck frontend health and authenticated access after reacquisition. Browser/session state and build outputs are not evidence that a previous branch is still loaded.`;
}
