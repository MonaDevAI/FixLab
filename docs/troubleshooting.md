# Troubleshooting

Run FixLab commands from the root of the local application repository unless a
command explicitly accepts another path.

## Structured command output or reuse is unexpected

Run the command after `--`; use `--cwd` only for a directory inside the
repository:

```powershell
fixlab exec --cwd .\frontend --stage test -- npm test
```

In Windows PowerShell an unquoted `--` is dropped, so `fixlab exec` prints its
usage text instead of running. Quote the separator (`'--'`). Do not wrap the
command in `cmd /c`: the wrapper is denied when no interactive user can approve
it, which blocks the job.

```powershell
fixlab exec --cwd .\frontend --stage test '--' npm test
```

The `Evidence:` path is Git-private and contains redacted `stdout.log`,
`stderr.log`, and `result.json`. A missing stream file means that stream was
empty. The terminal `Context:` line and `result.json.context` report raw and
structured lines, bytes, estimated tokens, omitted lines, and reduction
percentage. These estimates measure command-output reduction only; they do not
represent the complete session context or provider billing. `--reuse` applies
only to supported deterministic validation commands.
If it reports that reuse was ignored, run normally or select an eligible local
test, build, lint, type-check, or validation command.

A cache miss is expected after any command, argument, stage, working-directory,
Git `HEAD`, tracked/untracked worktree, or FixLab-profile change. Timeouts
return exit code 124 after terminating the child; increase
`--timeout-seconds` only when the repository-owned command legitimately needs
more time; values above 2,147,483 seconds are rejected. On Windows, `.cmd` and
`.bat` wrapper arguments containing shell metacharacters are rejected instead
of being interpreted or silently changed. Invoke the underlying executable
directly when such an argument is required. Never use reuse for live or
external checks.

## `fixlab` is not recognized

Verify the global npm prefix and command:

```powershell
npm prefix --global
Get-Command fixlab -ErrorAction SilentlyContinue
```

Install FixLab:

```powershell
npm install --global github:MonaDevAI/FixLab
```

The global prefix must be on the user `PATH`. A common Windows user-level npm
prefix is:

```text
%APPDATA%\npm
```

After changing `PATH` or npm's prefix, open a new PowerShell window and run:

```powershell
fixlab --help
```

## npm fails with an internal JavaScript error

An error such as:

```text
Class extends value undefined is not a constructor or null
```

usually means Node.js and npm resolve from incompatible or damaged
installations. Inspect the same shell that will run FixLab:

```powershell
where.exe node
where.exe npm
node --version
npm --version
npm pack --dry-run --ignore-scripts --json
```

The version command alone is insufficient because a damaged npm installation
can still print its version. Activate or reinstall one coherent Node.js/npm
installation, then rerun:

```powershell
fixlab doctor --runtime agency
fixlab prepare --yes
```

Doctor and Prepare preflight the configured frontend package manager. Prepare
stops before dependency restoration when npm, pnpm, or Yarn cannot run.

If an NVM version directory contains the wrong `node.exe`, or lacks a coherent
npm CLI after reinstalling, use FixLab's plan-first portable repair:

```powershell
pwsh -File scripts/repair-node-runtime.ps1 -Repository C:\path\to\application
pwsh -File scripts/repair-node-runtime.ps1 -Repository C:\path\to\application -Yes
```

The script verifies the official Node.js SHA-256 checksum and does not alter
NVM or the permanent system `PATH`.

## Dependency restore returns `E401` or `E403`

The package manager is working, but the developer or runner is not
authenticated to a repository-owned private feed.

Follow the feed owner's **Connect to feed** instructions. For an Azure
Artifacts npm feed that uses `vsts-npm-auth`, run from the directory containing
the repository `.npmrc`:

```powershell
vsts-npm-auth -C ".npmrc" -T "$HOME\.npmrc" -R -F
```

If PowerShell resolves a script by full quoted path, use the call operator:

```powershell
& "<path-to-vsts-npm-auth.ps1>" -C ".npmrc" -T "$HOME\.npmrc" -R -F
```

Complete the interactive organization sign-in, then rerun `fixlab prepare
--yes`. Tokens belong in the developer or runner credential store or user
`.npmrc`; never copy them into the repository profile or commit them.

## A pull-request URL becomes a malformed Windows path

Commands such as `doctor`, `prepare`, and `dashboard` require a local repository
directory, not a browser URL.

```powershell
Set-Location C:\source\application
fixlab doctor --runtime agency
```

Validate a pull request by number:

```powershell
fixlab validate --pr 123 --runtime agency
```

Current FixLab versions reject HTTP URLs immediately and display this command
guidance.

## Playwright package or browser is unavailable

For a new worktree, first provision its profile and declared non-sensitive
browser configuration with `fixlab onboard WORKTREE --from SOURCE`.
Review the plan and add `--yes` to execute it. Missing `--config` files are
reported explicitly; list private non-sensitive configuration in the source
profile's `worktreeSetup.files`, or provide it manually in the target checkout.

If Doctor reports **Runtime dependency access**, a `node_modules` symlink or
junction points outside the checkout. Run `fixlab onboard WORKTREE` to inspect
the exact dependency paths, then add `--yes` to approve only those directories.
Do not use blanket path grants. Organizational runtime deny rules still apply;
a denied tool or URL needs its own scoped approval, not repeated job resumes.

Restore repository dependencies first:

```powershell
fixlab prepare
fixlab prepare --yes
```

Then inspect and approve repository-local Playwright setup:

```powershell
fixlab setup-playwright
fixlab setup-playwright --yes
```

Doctor performs a real launch of the configured browser. Resolve that failure
before starting a FixLab job.

## Browser authentication is not ready

Doctor lists the missing status paths from
`browserAutomation.authentication.statusPaths`. From any directory, point the
globally installed FixLab CLI at the local repository:

```powershell
fixlab authenticate C:\path\to\repository
fixlab authenticate C:\path\to\repository --yes
```

The first command prints a redacted plan. The second runs the repository-owned
authentication command from its configured working directory, applies the
profile-defined environment, and verifies the required status paths. To run
the repository command directly instead, change to the configured working
directory and execute it. For example:

```powershell
$env:E2E_START = "npm start"
npm run test:e2e:auth
```

Complete sign-in and MFA in the headed browser, keep it open until the terminal
reports that authentication state was saved, and verify the configured paths:

```powershell
Test-Path .\e2e\.auth\user.json
Test-Path .\e2e\.edge-profile
```

Use the actual status paths declared by the repository profile. Authentication
state contains sensitive tokens, must remain Git-ignored, and must never be
shared or committed. Rerun:

```powershell
fixlab doctor --runtime agency
```

## `.NET SDK` reports `ENOENT`

The selected shell cannot find `dotnet`:

```powershell
where.exe dotnet
dotnet --version
```

Install the repository-required SDK or restore its installation directory to
`PATH`, then open a new PowerShell window. Doctor runs `dotnet --version` from
the repository root so any `global.json` requirement is enforced.

## A validation command is denied before execution

A runtime permission denial is not a test failure. Compound shell commands,
cross-directory dependency reuse, or an unapproved executable can be blocked
before Jest, TypeScript, or another validator starts.

For a new direct Copilot job, use **Copilot needs your response** to approve the
specific runtime request once, deny it, or answer the agent's question. The live
session waits without an idle timeout; it does not need Resume. Sign in only in
the normal browser, then choose the agent's readiness option if offered.
Stop/hold/shutdown invalidates outstanding prompts. A dashboard/runtime restart
cannot replay an approval, and a historical unclassified denial has no live
request to approve. This feature does not make failed tests or organization
restrictions automatically approvable.

For an Agency or older dashboard job that reports "no interactive user response was available"
or "Denied, no one to approve", use the browser's **Copilot permission required**
panel. Inspect the logs, then review and explicitly confirm a specific external
folder only when the failure is a path restriction. Ordinary workflow or PR
approval cannot authorize the background runtime. Review itself grants nothing.
No separate terminal is needed for folder approval.

A folder grant cannot resolve a denied tool, URL or organization policy. If the
scope is unknown, keep the job paused. Do not grant blanket access or reroute an
operation through another wrapper to evade a denial. See
[background runtime permissions](commands.md#background-runtime-permissions).

After the required access is authorized, use the repository's configured
command directly from its working directory:

```powershell
$env:CI = "true"
npm test -- --watchAll=false --runInBand <focused-test>
npm run type-check
```

Record the original command as blocked and report the direct command's actual
result. Do not describe a permission denial as a passing or failing test.

## Local validation times out after Windows becomes idle

Windows can enter Modern Standby while local Git, Node.js or browser work is
still running. After waking, a probe can report `ETIMEDOUT`, a job can be
failed before its executor starts, or a browser expectation can miss a short
intermediate state. A successful focused retry does not make the original
full validation pass.

For FixLab contributors running from its source checkout, use:

```powershell
pwsh -File scripts\validate.ps1
```

This runs the unchanged full `npm run validate` gate with a temporary system
and display idle-sleep request. The previous Windows execution state is
restored in `finally`, including when validation exits nonzero or throws.
It does not change the machine's power plan, disable manual sleep, alter
timeouts, skip checks, or hide failed attempts. Keep the lid open during a run.
On other platforms, use `npm run validate` directly.

When operating through Copilot, `/keep-alive` is another option if available in
that version. Verify the machine remained awake rather than assuming a tool
process prevented sleep. Windows System events from
`Microsoft-Windows-Kernel-Power` with IDs 506/507 show Modern Standby entry/exit;
read their timestamps and reasons to distinguish idle sleep from an actual
Git or application defect. If a failure persists while awake, investigate it
instead of repeatedly retrying or increasing deadlines.

## Doctor still reports blockers

Doctor is intentionally strict. Resolve every `FAIL` before starting the
dashboard or an autonomous job:

```powershell
fixlab doctor --runtime agency
```

The package-manager probe waits 30 seconds by default. On a slow machine or a
large repository, raise the limit (1,000 to 600,000 ms) for the current shell:

```powershell
$env:FIXLAB_DOCTOR_TIMEOUT_MS = "90000"
fixlab doctor
```

## A job is rejected with "Preflight failed"

Before queuing a job, the dashboard checks that the tools named in the
repository profile's restore and startup commands (`npm`, `pnpm`, `yarn`,
`dotnet`) are on `PATH`. The check is offline. It does not contact the
application, DEV, or any maintenance window. Install the missing tool, open a
new shell, and restart the dashboard from that shell.

Do not bypass missing authentication, production exclusions, private-feed
access, browser launch, or repository-profile safety requirements.
