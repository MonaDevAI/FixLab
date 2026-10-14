import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function git(repository, args, description) {
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
  return result.stdout.trim();
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

export function prepareSharedWorktree({ repository, profile, jobId, saved = null, resume = false, resourcesRunning = false }) {
  const config = sharedWorktreeConfig(profile, repository);
  if (!config) {
    if (saved) {
      throw new Error("This job owns a shared worktree branch; restore shared mode before resuming it");
    }
    return null;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(jobId)) {
    throw new Error("Shared worktree jobs require a valid job ID");
  }
  const gitPath = (name) => {
    const value = git(repository, ["rev-parse", "--git-path", name], "Git operation verification");
    return isAbsolute(value) ? value : resolve(repository, value);
  };
  if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"].some((name) => existsSync(gitPath(name)))) {
    throw new Error("Finish the in-progress Git operation before reusing the shared worktree");
  }
  const currentBranch = git(repository, ["branch", "--show-current"], "Current branch verification");
  const dirty = git(repository, ["status", "--porcelain", "--untracked-files=all"], "Shared worktree cleanliness check");
  if (saved) {
    const branch = branchRef(repository, saved.branch, "Saved job branch");
    if (
      saved.mode !== "shared" ||
      !branch.endsWith(`/fixlab-${jobId}`) ||
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
    throw new Error("This older job has no saved shared-worktree branch. Resume it with its original workspace policy; do not guess its branch");
  }
  if (resourcesRunning) {
    throw new Error("Stop the shared checkout's owned React and authentication sessions before starting another job branch");
  }
  if (dirty) {
    throw new Error("The shared worktree has uncommitted or untracked files; preserve them before starting another job");
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
- Check dependency and configuration readiness for the selected branch; cached dependencies are not proof that changed manifests were restored.
- Recheck frontend health and authenticated access after reacquisition. Browser/session state and build outputs are not evidence that a previous branch is still loaded.`;
}
