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
- Microsoft Edge or another repository-approved Playwright browser
- Access to the source repository and its allowed validation environments

Use your organization's supported Agency installation and authentication
instructions. Verify the runtime before continuing:

```powershell
agency --version
agency copilot
```

FixLab does not install Agency or manage Agency authentication.

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
npm install --global .\fixlab-cli-0.1.0.tgz
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
- The FixLab repository profile
- Git repository initialization

Resolve every failed prerequisite before starting a FixLab session.

## Run FixLab

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
