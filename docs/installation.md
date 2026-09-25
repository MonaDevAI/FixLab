# Installation

FixLab supports Agency Copilot and direct GitHub Copilot CLI execution. Install
and authenticate the runtime selected for the local runner before installing
FixLab.

For known CLI, package-manager, private-feed, Playwright, authentication, and
runtime failures, see [Troubleshooting](troubleshooting.md).

## Prerequisites

The machine running FixLab needs:

- Agency with GitHub Copilot CLI support, or GitHub Copilot CLI directly
- Git
- Node.js 18 or later
- PowerShell 7
- The .NET SDK required by the target repository
- A repository-local `@playwright/test` or `playwright` package
- Microsoft Edge or another repository-approved Playwright browser
- Access to the source repository and its allowed validation environments

Azure CLI is optional. It is required only when the local dashboard loads
Azure DevOps work items. Authenticate with `az login` using the developer
identity that already has access to the requested organization and project.
FixLab does not persist the resulting Azure DevOps resource token.

Agency remains the default compatibility runtime. Use your organization's
supported installation and authentication instructions, then verify:

```powershell
agency --version
agency copilot
```

For direct mode, install and authenticate GitHub Copilot CLI, then verify
`copilot --help`. Select direct mode with `--runtime copilot` or
`FIXLAB_RUNTIME=copilot`.

FixLab does not install either runtime or manage its authentication.
Installing FixLab does not start a server or background service. The local
dashboard starts only when you run `fixlab dashboard`.

## Install directly from GitHub

FixLab is not currently published to the public npm registry. Install the
public GitHub repository with npm:

```powershell
npm install --global github:MonaDevAI/FixLab
fixlab --help
```

### Intelligent Windows bootstrap

An npm-based installer cannot recover when the shell resolves a damaged or
mismatched Node/npm pair. From a FixLab clone, use the plan-first PowerShell
bootstrap to locate NVM for Windows and select a coherent runtime:

```powershell
pwsh -File scripts/install-fixlab.ps1 -Repository C:\path\to\application
pwsh -File scripts/install-fixlab.ps1 -Repository C:\path\to\application -Yes
```

The bootstrap:

- Discovers NVM through `NVM_HOME`, the standard roaming/local directories,
  and NVM's `settings.txt`.
- Reads an exact Node version from `-NodeVersion`, `.nvmrc`,
  `.node-version`, exact `package.json` `engines.node`, or the repository
  profile's optional `toolchain.nodeVersion`.
- Requires `node.exe` and `npm.cmd` from the same NVM version directory.
- Runs an offline `npm pack --dry-run` probe before selecting a runtime.
- Uses the selected `npm.cmd` by absolute path instead of changing the
  machine's permanent `PATH`.
- Verifies the installed `fixlab.cmd`.

The default command only prints the plan. `-Yes` approves changes. If the exact
Node version is absent, both `-InstallNode` and `-Yes` are required before the
bootstrap invokes `nvm install`; it verifies the runtime files afterward and
fails if NVM reports success without installing them.

```powershell
pwsh -File scripts/install-fixlab.ps1 `
  -Repository C:\path\to\application `
  -NodeVersion 22.23.3 `
  -InstallNode `
  -Yes
```

The bootstrap never uninstalls or repairs NVM, silently replaces Node, or
modifies the system `PATH`.

### Repair an incoherent Node runtime

If NVM reports an exact version but the version directory launches another
Node release, or npm is absent or internally inconsistent, use the plan-first
portable repair:

```powershell
pwsh -File scripts/repair-node-runtime.ps1 `
  -Repository C:\path\to\application

pwsh -File scripts/repair-node-runtime.ps1 `
  -Repository C:\path\to\application `
  -Yes
```

The repair script:

- Reads the exact Node version from the repository profile, `.nvmrc`,
  `.node-version`, or exact `package.json` `engines.node`.
- Downloads the official Windows archive and `SHASUMS256.txt` only from
  `nodejs.org`.
- Verifies the archive SHA-256 checksum before extraction.
- Validates the extracted `node.exe` version and npm CLI.
- Marks the portable root as FixLab-owned and refuses to replace an existing
  runtime in an unowned directory.
- Replaces only the exact FixLab-owned portable runtime directory after
  checksum and runtime validation.
- Does not uninstall NVM, change the permanent `PATH`, or modify the system
  Node installation.

Use the printed temporary `PATH` command in the current PowerShell session,
then rerun `fixlab doctor`, `fixlab prepare`, or `fixlab authenticate`.

This installs the CLI, dashboard assets, and packaged FixLab plugin. The
selected runtime remains a separate prerequisite.

Direct GitHub repository plugin installation is supported for development and
pre-release verification:

```powershell
copilot plugin install MonaDevAI/FixLab
```

GitHub Copilot CLI warns that direct repository plugin installs are deprecated.
FixLab is not yet listed in the official marketplace. After its separate
marketplace pull request is reviewed and merged, use the stable marketplace
form:

```powershell
copilot plugin install fixlab@copilot-plugins
```

The installed custom agent is selected as `fixlab:fixlab`.

After `fixlab init` and profile configuration, review and run the target
repository's own dependency restore commands:

```powershell
fixlab prepare
fixlab prepare --yes
```

`fixlab prepare` executes only the configured `frontendRestore` and
`backendRestore` commands, and only after `--yes`. This keeps a fresh
installation reproducible without hard-coding npm or .NET assumptions into
FixLab.

Authenticate to repository-owned private package feeds before approving the
plan. Use the organization's supported credential provider (for example, the
Azure Artifacts **Connect to feed** instructions for local development or
`npmAuthenticate` in Azure Pipelines). Credentials belong in the developer or
runner credential store, never in the repository profile or a committed
`.npmrc`.

FixLab can inspect the repository profile and prepare the repository-local
Playwright installation commands:

```powershell
fixlab setup-playwright
```

This first prints the detected package manager and exact commands without
changing the repository. Review them, then approve execution:

```powershell
fixlab setup-playwright --yes
```

The command:

- Detects npm, pnpm, or Yarn from the repository lock file
- Installs the configured Playwright package as a development dependency when
  it is missing
- Installs the configured browser or browser channel
- Performs a real headless launch to verify the installation
- Stops with an explicit failure if installation or verification fails

You can also install Playwright manually. For example:

```powershell
Set-Location <application-repository>\frontend
npm install --save-dev @playwright/test
npx playwright install chromium
```

Use the package and browser required by the application repository. Playwright
and its browser binaries remain on the developer or registered runner machine.
FixLab never installs them silently; `--yes` is required before setup commands
are executed.

## Install from a Git checkout

Clone the FixLab repository and install its CLI globally:

```powershell
git clone <fixlab-repository-url>
Set-Location FixLab
npm install --global .
fixlab --help
```

This installs the `fixlab` command. The CLI retains the packaged Agency plugin
and launches it through the existing `agency` executable.

## Onboard an application repository

Open the React and .NET application repository, then create its FixLab profile:

```powershell
Set-Location <application-repository>
fixlab init
```

Edit:

```text
.github\fixlab\repository-profile.json
```

Open the file in the developer's normal editor. For example:

```powershell
code .github\fixlab\repository-profile.json
```

If Visual Studio Code is unavailable:

```powershell
notepad .github\fixlab\repository-profile.json
```

Replace the template values with paths and commands owned by the application
repository. A React and .NET profile normally defines:

```json
{
  "version": 1,
  "name": "Application React and .NET",
  "architecture": "React frontend backed by an ASP.NET API.",
  "components": [
    {
      "name": "React frontend",
      "paths": ["frontend/src", "frontend/e2e"],
      "testPatterns": [
        "frontend/src/**/*.test.ts",
        "frontend/src/**/*.test.tsx",
        "frontend/e2e/**/*.spec.ts"
      ]
    },
    {
      "name": ".NET API",
      "paths": ["backend/src"],
      "testPatterns": ["backend/tests/**/*.cs"]
    }
  ],
  "validation": {
    "commands": {
      "frontendRestore": "npm ci",
      "frontendTest": "npm test -- --runInBand",
      "frontendTypeCheck": "npm run type-check",
      "frontendBuild": "npm run build",
      "backendRestore": "dotnet restore Application.sln",
      "backendTest": "dotnet test Application.sln",
      "backendBuild": "dotnet build Application.sln"
    },
    "productionBuildTimeoutMinutes": 20,
    "blockerPolicy": "continue-on-owned-process-timeout"
  },
  "applications": {
    "frontend": {
      "workingDirectory": "frontend",
      "command": "npm start",
      "port": 3000,
      "healthUrl": "http://127.0.0.1:3000"
    },
    "backend": {
      "workingDirectory": "backend",
      "command": "",
      "port": 0,
      "healthUrl": "",
      "requiredForLiveTest": false
    }
  },
  "browserAutomation": {
    "workingDirectory": "frontend",
    "package": "@playwright/test",
    "browser": "chromium",
    "testCommand": "npm run test:e2e",
    "testSynthesis": {
      "enabled": true,
      "defaultDataSource": "synthetic-intercepted",
      "mutationMode": "intercepted",
      "requireScenarioEvidence": true
    },
    "authentication": {
      "required": false,
      "command": "",
      "statusPaths": []
    },
    "dataSafety": {
      "policy": "Use local test data and intercept every mutating request.",
      "productionAllowed": false
    }
  },
  "environments": ["local", "dev", "sit"],
  "pullRequests": {
    "defaultTargetBranch": "main",
    "requireConfirmation": true,
    "branchNaming": {
      "userId": "developer-alias",
      "prefixTemplate": "users/{userId}"
    }
  }
}
```

Use repository-relative paths and commands that run non-interactively. Replace
the example solution, directories, startup command, test command, environments,
target branch, and developer alias. If browser authentication is required, set
`authentication.required` to `true` and configure the repository-owned login
command and status paths as described below.

Save the file, then validate both the machine and profile with the selected
runtime:

```powershell
fixlab doctor --runtime agency
```

Resolve every `FAIL` before running a job. Never add credentials, tokens,
cookies, browser-state contents, private endpoints, customer records, or
sensitive test data to the profile.

### Upgrade an existing repository profile

`fixlab init` preserves an existing profile and never overwrites repository
policy. After updating FixLab, run:

```powershell
fixlab init
fixlab doctor --runtime copilot
```

The first command reports fields that require a manual profile upgrade. The
doctor command validates the resulting profile before the dashboard starts.

Profiles created before test synthesis became required must add an explicit
policy. Use the repository's actual data-safety model rather than copying an
environment choice blindly:

```json
{
  "browserAutomation": {
    "testSynthesis": {
      "enabled": true,
      "defaultDataSource": "synthetic-intercepted",
      "mutationMode": "intercepted",
      "requireScenarioEvidence": true
    }
  }
}
```

Use `synthetic-intercepted` when reads and writes should remain local. A
repository that intentionally reads approved DEV or SIT data can use
`non-production-read-only`; retain `intercepted` unless external writes have a
separately reviewed approval policy.

## Check the machine and repository

Run:

```powershell
fixlab doctor
```

The command checks:

- Git
- Node.js
- The frontend package manager configured by `frontendRestore`, including a
  successful `npm`, `pnpm`, or Yarn version check
- The .NET SDK selected by the target repository, including any
  `global.json` requirement
- PowerShell
- The selected Agency or GitHub Copilot CLI runtime
- Repository-local Playwright package
- A successful headless launch of the configured Playwright browser
- The FixLab repository profile
- Git repository initialization

Resolve every failed prerequisite before starting a FixLab session.
The .NET check runs `dotnet --version` from the target repository so the normal
SDK resolver validates `global.json`, rather than accepting an unrelated SDK
installed elsewhere on the machine.

If Doctor reports that the frontend package manager cannot start, run the
reported version command in the same shell:

```powershell
node --version
npm --version
npm pack --dry-run --ignore-scripts --json
where.exe node
where.exe npm
```

`npm --version` alone is insufficient because a damaged npm installation can
print its version while operational commands fail internally. Node.js and npm
must resolve from one compatible, internally consistent installation. NVM
users should activate the intended version before retrying. FixLab also repeats
this preflight immediately before an approved `fixlab prepare --yes` and stops
before dependency restoration when the package manager is broken.

A package manager that starts successfully can still fail restore with `E401`
or `E403` when the repository uses a private feed. Authenticate with the
repository owner's supported credential provider, then rerun preparation.
FixLab does not create, copy, or persist private-feed credentials.

For a long local batch, run `/keep-alive` in GitHub Copilot CLI before starting
the job. Locking the screen does not stop ordinary commands, but system sleep,
hibernation, process termination, and network loss can interrupt a local
runner. Browser interactions may still require an unlocked desktop.

The repository profile controls the Playwright check:

```json
{
  "browserAutomation": {
    "workingDirectory": "frontend",
    "package": "@playwright/test",
    "browser": "chromium",
    "channel": "msedge",
    "authentication": {
      "command": "npm run test:e2e:auth",
      "environment": {
        "E2E_START": "npm start"
      },
      "statusPaths": [
        "e2e/.auth/user.json"
      ]
    }
  }
}
```

`browser` selects the Playwright browser API. The optional `channel` selects an
installed branded browser such as Microsoft Edge. Omit `channel` when the
repository uses Playwright's bundled Chromium.

The optional `authentication` block enables the dashboard's **Check status**
and **Connect Playwright** controls. `statusPaths` are checked for existence
only; FixLab never reads or returns their browser-state contents.

## Run FixLab

Start the local dashboard from an onboarded repository:

```powershell
fixlab dashboard
fixlab dashboard --runtime copilot
```

It binds only to `127.0.0.1`, uses port `4317` by default, and opens the system
browser. Select another repository or port, or suppress browser opening:

```powershell
fixlab dashboard C:\source\application --port 4318 --no-open
```

The dashboard requires `.github\fixlab\repository-profile.json` before a job
can start. It permits one local job at a time and invokes the packaged
`fixlab:fixlab` plugin with the selected repository as its working directory.

Start an interactive FixLab session:

```powershell
fixlab run
```

Start with a specific request:

```powershell
fixlab run . -- "Reproduce the reported defect and validate the smallest safe fix."
```

Validate a pull request without changing it:

```powershell
fixlab validate --pr 123
```

Agency mode launches:

```powershell
agency copilot --plugin-dir <installed-fixlab-package> --agent fixlab:fixlab
```

Direct mode launches:

```powershell
copilot --plugin-dir <installed-fixlab-package> --agent fixlab:fixlab
```

The dashboard uses the same plugin resolution and streams long prompts through
standard input. Closing it terminates only its tracked runtime and Playwright
authentication handles; it does not terminate unrelated repository, browser,
or developer processes.

## Run the plugin without installing the CLI

From a FixLab checkout:

```powershell
agency copilot --plugin-dir . --agent fixlab:fixlab
copilot --plugin-dir . --agent fixlab:fixlab
```

## Update or uninstall

From a newer checkout:

```powershell
npm install --global .
```

To remove the CLI:

```powershell
npm uninstall --global @fixlab/cli
```

FixLab does not remove Agency, GitHub Copilot CLI, repository profiles,
worktrees, evidence, or application dependencies when the CLI is uninstalled.
