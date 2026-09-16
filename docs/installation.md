# Installation

FixLab supports Agency Copilot and direct GitHub Copilot CLI execution. Install
and authenticate the runtime selected for the local runner before installing
FixLab.

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

Install the public repository with npm:

```powershell
npm install --global github:MonaDevAI/FixLab
fixlab --help
```

This installs the CLI, dashboard assets, and packaged FixLab plugin. The
selected runtime remains a separate prerequisite.

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

## Install from a package file

If a release provides `fixlab-cli-<version>.tgz`, install it directly:

```powershell
npm install --global .\fixlab-cli-0.4.0.tgz
fixlab --help
```

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

Replace the template paths, commands, ports, health URLs, environments, and
pull request settings with values owned by that repository. Never add
credentials or sensitive test data to the profile.

## Check the machine and repository

Run:

```powershell
fixlab doctor
```

The command checks:

- Git
- Node.js
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
