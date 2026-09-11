# Installation

FixLab is an Agency Copilot-powered workflow. Install and authenticate Agency
before installing FixLab.

## Prerequisites

The machine running FixLab needs:

- Agency with GitHub Copilot CLI support
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

Use your organization's supported Agency installation and authentication
instructions. Verify the runtime before continuing:

```powershell
agency --version
agency copilot
```

FixLab does not install Agency or manage Agency authentication.
Installing FixLab does not start a server or background service. The local
dashboard starts only when you run `fixlab dashboard`.

## Install directly from GitHub

Install the public repository with npm:

```powershell
npm install --global github:MonaDevAI/FixLab
fixlab --help
```

This installs the CLI, dashboard assets, and packaged Agency plugin. Agency
itself remains a separate prerequisite.

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
- .NET SDK
- PowerShell
- Agency
- Repository-local Playwright package
- A successful headless launch of the configured Playwright browser
- The FixLab repository profile
- Git repository initialization

Resolve every failed prerequisite before starting a FixLab session.

The repository profile controls the Playwright check:

```json
{
  "browserAutomation": {
    "workingDirectory": "frontend",
    "package": "@playwright/test",
    "browser": "chromium",
    "channel": "msedge"
  }
}
```

`browser` selects the Playwright browser API. The optional `channel` selects an
installed branded browser such as Microsoft Edge. Omit `channel` when the
repository uses Playwright's bundled Chromium.

## Run FixLab

Start the local dashboard from an onboarded repository:

```powershell
fixlab dashboard
```

It binds only to `127.0.0.1`, uses port `4317` by default, and opens the system
browser. Select another repository or port, or suppress browser opening:

```powershell
fixlab dashboard C:\source\application --port 4318 --no-open
```

The dashboard requires `.github\fixlab\repository-profile.json` before a job
can start. It permits one local job at a time and invokes the packaged
`FixLab:fixlab` plugin with the selected repository as its working directory.

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

Internally, the CLI launches the packaged plugin through:

```powershell
agency copilot --plugin local:<installed-fixlab-package> --agent fixlab:fixlab
```

The dashboard uses the same plugin resolution. Closing the dashboard server
terminates only its active Agency child process; it does not terminate
unrelated repository, browser, or developer processes.

## Run the plugin without installing the CLI

From a FixLab checkout:

```powershell
agency copilot --plugin local:. --agent fixlab:fixlab
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

FixLab does not remove Agency, repository profiles, worktrees, evidence, or
application dependencies when the CLI is uninstalled.
