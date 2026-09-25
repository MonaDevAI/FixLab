# Troubleshooting

Run FixLab commands from the root of the local application repository unless a
command explicitly accepts another path.

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

The script verifies the official Node.js SHA-256 checksum, requires a real npm
operation to succeed, and does not alter NVM or the permanent system `PATH`.
It refuses to execute an existing portable runtime unless its destination root
is already marked as FixLab-owned, and rejects junctions, symbolic links, or
other reparse points before runtime execution or recursive cleanup.

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

Use the repository's configured command directly from its working directory:

```powershell
$env:CI = "true"
npm test -- --watchAll=false --runInBand <focused-test>
npm run type-check
```

Record the original command as blocked and report the direct command's actual
result. Do not describe a permission denial as a passing or failing test.

## Doctor still reports blockers

Doctor is intentionally strict. Resolve every `FAIL` before starting the
dashboard or an autonomous job:

```powershell
fixlab doctor --runtime agency
```

Do not bypass missing authentication, production exclusions, private-feed
access, browser launch, or repository-profile safety requirements.
