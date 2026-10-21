# Repository onboarding

FixLab must not assume that every React and .NET repository has the same layout.
The target repository owns a versioned profile.

## Dashboard chat setup

Choose **Add local repository** in the repository sidebar and enter the absolute
root of an existing local Git working tree. A deterministic chat asks about
application folders, commands and loopback health URLs, browser tests, sign-in
configuration, non-production environments and branch ownership. It makes no
model calls and never asks for credentials or authentication-file contents.

Review the proposed settings and exact file list before **Apply reviewed setup**.
Only the profile and missing packaged FixLab prompts/agent files are written;
existing custom scaffolding is not overwritten. No dependencies are installed,
commands executed, authentication performed or jobs started. Configuration alone
is not a passed Doctor or browser check. Failed multi-file scaffolding can leave
some newly created files; reload and review again rather than blindly retrying.

**Open repository workspace** reuses a verified local owner or opens an idle
loopback workspace in the same dashboard host. The original repository job keeps
running when you switch workspaces. The host owns at most eight additional
workspaces; shutting down that host closes its owned workspaces and resources,
not independently started dashboard processes.

Under **Settings & usage**, **Load repository settings** exposes the supported
repository-level fields without returning environment-variable values or a raw
profile. Preview and confirm every save. Unshown configuration is preserved,
including structured environment definitions; add new structured definitions
in the repository profile before enabling them through the editor. Production
operation policy cannot be enabled here. An executor lease or active owned
frontend/sign-in session prevents saving, without stopping those resources.
Only the selected repository's ownership scopes are checked for setup writes
and workspace opening. An unreachable or identity-mismatched registered owner
in those scopes blocks the operation; it is not evidence that its resources
stopped. Unrelated unavailable dashboard registrations do not block setup.
Plans expire after ten minutes and are invalidated by concurrent profile edits.
Setup paths reject traversal and symbolic links.

## Required information

### Repository

- Default branch
- Allowed pull request target branches
- Developer user ID and branch prefix template
- Working directories
- Dependency restore commands
- Build and test commands

### Components

For each component, identify:

- Source paths
- Test paths
- Shared dependencies
- Maintainer or code owner
- User-visible validation requirements

### Applications

Declare:

- Startup command
- Health endpoint
- Owned local port
- Required environment variables
- Whether a deployed dependency or local dependency is required

### Browser journeys

Each journey should specify:

- Route or entry point
- Required role
- Safe test-data requirements
- User actions
- Exact observable assertion
- Cleanup behavior

The profile must also declare:

- `browserAutomation.testCommand`, which runs the repository-owned Playwright suite.
- `browserAutomation.testSynthesis`, which enables focused scenario generation,
  declares the default test-data source and mutation mode, and requires
  scenario evidence.
- `browserAutomation.authentication.required`, explicitly stating whether login is needed.
- An authentication command and status paths when authentication is required.
- A reviewed `browserAutomation.authentication.proofCommand` for authenticated
  browser readiness. It must exercise a read-only signed-in assertion against
  `FIXLAB_TARGET_ENVIRONMENT`, fail for expired/unauthenticated state, and close
  its owned browser. A helper exit or state-file existence is not login proof.
  Dashboard proof is memory-only and bound to the job, selected environment,
  configuration and unchanged regular status-file identities; new jobs and
  changed state require a fresh proof. No browser-state contents are inspected
  or copied by this check.
  Include the persistent browser-profile directory in `statusPaths` as well
  when ownership checks must detect another browser using it. Directory identity
  is checked without treating browser lock-file updates as credential changes;
  at least one regular status file is still required for authenticated proof.
- `browserAutomation.dataSafety.policy`, describing mock, read-only, or intercepted-mutation behavior.
- `browserAutomation.dataSafety.productionAllowed: false`.

Optionally, declare `trustedDependencyRoots`, a list of absolute directories, when a
working directory's `node_modules` is a link to a shared install outside the
repository. Non-interactive agents cannot answer path-permission prompts, so FixLab
passes `--add-dir` only for `node_modules` links under these roots, in the profile's
working directories. Without this field, no external path is granted. Filesystem roots
are ignored.
Synthesized scenario source is transient by default. The agent must remove
generated test files and validation-only configuration changes before the
product pull request. A repository can require a permanent generated browser
test through its instructions, or the user can request one explicitly;
otherwise newly created authenticated `*.auth.spec.ts` files are validation
artifacts rather than product changes.

Use `defaultDataSource: "synthetic-intercepted"` with
`mutationMode: "intercepted"` when Playwright should fulfill reads locally and
capture mutation intent without changing an external record. Repositories may
instead declare `local-fixture`, `non-production-read-only`, or
`non-production-approved`; any approved write still requires the normal human
unsafe-data approval.

With `non-production-read-only`, an explicitly selected DEV or SIT environment
is tried first. If that backend is unavailable or cannot provide a safe record
required for the assertion, FixLab may fall back to
`synthetic-intercepted`/`intercepted` and must report that the backend was not
validated. Expected empty-state scenarios must remain against the selected
backend and must not be replaced by synthetic results.

Do not place real credentials, tokens, user identities, customer records, or
internal service URLs in the profile.

Configure repository branch ownership explicitly:

```json
{
  "pullRequests": {
    "branchNaming": {
      "userId": "developer-alias",
      "prefixTemplate": "users/{userId}"
    }
  }
}
```

FixLab replaces `{userId}` with the configured value and instructs the agent to
create branches beneath the resolved prefix. It never substitutes `copilot`,
`fixlab`, or another runtime name for the repository user's ID.

## Worktree setup

### Reusing one checkout for sequential jobs

Opt in to shared mode in a dedicated runner checkout's repository profile:

```json
{
  "worktreeSetup": {
    "mode": "shared",
    "remote": "origin",
    "baseBranch": "develop",
    "files": ["frontend/playwright.local.config.ts"]
  },
  "pullRequests": {
    "defaultTargetBranch": "develop",
    "branchNaming": {
      "userId": "developer-alias",
      "prefixTemplate": "users/{userId}"
    }
  }
}
```

Start `fixlab dashboard` against this checkout, or connect with `fixlab chat`.
Shared fix-and-validate jobs use that same folder, dependencies and local
browser profile; they do not create a folder per bug. Each new job refreshes
the configured remote base and creates a separate `users/<alias>/fixlab-<job-id>`
branch from its fetched commit, not from the previous fix branch. Omit
`baseBranch` to use `pullRequests.defaultTargetBranch`; the default remote is
`origin`. No network fetch is performed merely by installing or inspecting
the profile.

The existing repository executor lease fences preparation and execution.
Another job can reuse the folder after execution has verifiably stopped,
even while its earlier PR is pending. Use **Hold** to release a blocked job
to the queue, and **Resume** to reacquire its saved branch and session.
Resumption never fetches, rebases or resets that branch. Restarting a job
creates a new session and branch from the refreshed base. Saved shared
ownership survives dashboard restarts; legacy jobs without a saved branch
must be resumed using their original workspace policy.

Branch changes require a clean index and working tree, including untracked
files, and no merge/rebase/cherry-pick in progress. Stop owned frontend and
authentication processes before selecting a different branch. FixLab never
stashes, resets, deletes files, overwrites ignored files, or force-switches
another worktree's branch. A failed fetch blocks the new job instead of using
a stale base. The Git refresh is noninteractive and has a 30-second timeout;
authenticate to the remote separately if necessary.

Keep this checkout's reusable profile/configuration available on the base
branch or locally ignored; uncommitted setup files must be committed or
explicitly ignored before starting. Branch-dependent dependencies must still
be checked after acquisition. Existing browser state can be reused only after
authenticated access is verified for the selected environment. Ignore browser
state and dependencies in Git; never copy credentials between checkouts.

Shared mode is opt-in; omitted mode or `"isolated"` preserves existing
behavior. Direct interactive bug-fix and `fixlab run` execution are blocked in
shared mode because they do not have the dashboard's branch-resume contract.
Validation-only jobs do not switch branches or refresh the base.

### Preparing another worktree

A Git worktree does not inherit ignored profiles, untracked browser
configuration, restored dependencies, or authenticated browser state. Declare
only the non-sensitive configuration files needed by another checkout:

```json
{
  "worktreeSetup": {
    "files": ["frontend/playwright.local.config.ts"]
  }
}
```

Start with the configured source checkout and review the plan:

```powershell
fixlab onboard C:\source\application-worktree --from C:\source\application --runtime copilot
fixlab onboard C:\source\application-worktree --from C:\source\application --runtime copilot --yes
```

`--from` requires another checkout of the same Git repository. Without `--yes`,
it changes no files and runs no commands. Approval copies the profile and only
the declared files, initializes missing FixLab prompts, runs the profile's
restore and Playwright setup, and checks readiness. Matching files are
preserved; differing configuration requires a manual merge. Only a profile
that exactly matches the packaged unchanged example can be replaced
automatically. All file paths must stay within their checkout, without
symlink/junction escapes. Dependency folders, credential files and browser
state are excluded.

An explicit `--config` file in the profile's browser test command must exist
in the target checkout or be included in the copy plan. Missing configuration
blocks setup and dashboard readiness instead of silently skipping live testing.
After provisioning, rerun onboarding without `--from` if the target profile
has been customized.

When `node_modules` links outside the checkout, onboarding lists the exact
resolved dependency directories. `--yes` approves adding only those paths
to `trustedDependencyRoots`; runtime adapters pass them through `--add-dir`.
Doctor reports unapproved links before a non-interactive job starts. This
does not grant all filesystem paths, approve URLs, or override runtime deny
rules. Explicit runtime denial remains a blocker, not a reason to repeat
unchanged approvals.

For required browser sign-in, add `--authenticate` after reviewing the
repository-owned authentication command. Sign-in/MFA must be completed by the
user in this checkout's own browser profile. A profile directory existing is
not proof of a valid application session. Add `--start-dashboard` only when
all Doctor checks can pass; serve this worktree's actual code, not a healthy
server from another checkout.

## Profile review checklist

- Commands run non-interactively.
- Paths are repository-relative.
- Tests are focused and deterministic.
- Full builds have a bounded timeout.
- Local processes have explicit ownership markers.
- Production is excluded.
- Browser profiles are stored outside Git.
- Screenshots are sanitized before sharing.
- Pull request creation requires authorization.
- Deployment is a separate, explicitly approved capability.

`fixlab doctor` and the dashboard both block startup when the frontend startup
command, loopback health URL, Playwright command, authentication intent, or
data-safety policy is missing. This prevents a job from reaching the live-test
stage before the repository has a runnable, non-mutating browser-validation
contract. When authentication is required, every configured status path must
also exist; the authentication command should create its final status marker
only after sign-in succeeds.
