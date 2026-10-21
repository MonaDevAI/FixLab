# Installation

FixLab supports Agency Copilot and direct GitHub Copilot CLI execution. Install
and authenticate the runtime selected for the local runner before installing
FixLab.

For known CLI, package-manager, private-feed, Playwright, authentication, and
runtime failures, see [Troubleshooting](troubleshooting.md).

## Recommended path: install, then run

Once your supported runtime is installed and signed in, use just:

```powershell
npm install --global github:MonaDevAI/FixLab
fixlab chat C:\source\application --runtime copilot
```

Replace the path with your clone. For Agency, replace `copilot` with `agency`.
If setup is incomplete, chat opens a guided interactive setup with an explicit
onboarding request. Review the real profile paths and commands, approve the
scoped restore/browser setup, and complete any required feed sign-in and
application MFA yourself. FixLab checks readiness before starting the dashboard.
If setup fails, it reports the prerequisite rather than starting a broken job.

The commands below are manual setup and troubleshooting alternatives, not a
checklist that every user must run. A PR-only feature needs its approved commit
installed until the change reaches the default branch.

## Use the dashboard

Describe your request and select **Start job**. Attach images when useful;
**Run options** holds mode, environment and evidence settings.

The sidebar opens saved work, run details, connections and settings on demand.
On a small screen, select **Menu** first. **Back to chat** hides those tools
without clearing your draft or running a job. A repository that needs setup
shows **Set up a repository**; Azure DevOps intake is optional and separate.

Approval requests and errors remain inline. Review the actual command, path
or diff before approving; enter sign-in details only in the normal browser.
Required checks and managed approvals are unchanged.

## Prerequisites

The machine running FixLab needs:

- Agency with GitHub Copilot CLI support, or GitHub Copilot CLI directly
- Git
- Node.js 20.19+ in the 20.x line, or 22.12+ (required by the bundled Copilot SDK)
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
Installing FixLab does not start a server or background service. Run
`fixlab chat` after installation; if no dashboard is running, chat asks for
the repository path, opens interactive onboarding when needed, and starts the
local dashboard in the background after the profile is ready.

## Install directly from GitHub

The package installation is machine-wide; repository/worktree preparation is
separate. For another checkout of a configured repository, use plan-first
`fixlab onboard C:\path\to\worktree --from C:\path\to\application --runtime copilot`,
then add `--yes` after reviewing the source profile and declared files.
See [worktree preparation](repository-onboarding.md#preparing-another-worktree)
for scoped dependency grants and interactive authentication.

FixLab is not currently published to the public npm registry. Install the
public GitHub repository with npm:

```powershell
npm install --global github:MonaDevAI/FixLab
fixlab --help
```

### Starting from an existing Copilot session

No separate terminal is required: Copilot can run installation/setup shell
commands after you approve them. Do not paste shell commands as though they
were Copilot slash commands; ask Copilot to execute them.

1. Open Copilot in the application checkout. Use `/login` if prompted to sign
   in, and `/cwd` to verify the selected repository. For long local validation,
   use `/keep-alive` when offered by your Copilot version; otherwise keep the
   machine awake until validation finishes. Manual sleep or closing the lid can
   still interrupt a run.
2. Ask Copilot to check Git, Node.js, npm, PowerShell, the repository's .NET SDK,
   and `copilot --help`. Review the findings before installing missing tools.
   Then ask it to run the following installation commands, approving each
   requested operation:

```powershell
npm install --global github:MonaDevAI/FixLab
copilot plugin install MonaDevAI/FixLab
fixlab --help
```

The agent plugin and executable CLI are separate installations. Plugin
installation does not run npm, add `fixlab` to `PATH`, restore application
dependencies, or authenticate the application. CLI installation does not start
the dashboard. Direct GitHub plugin installation currently emits a deprecation
warning; use the marketplace form only after FixLab is actually available
there, as described below.

3. Restart Copilot after plugin installation and select `/agent fixlab:fixlab`.
   If `fixlab` is not recognized, reopen Copilot so it receives the updated
   environment and follow [PATH troubleshooting](troubleshooting.md#fixlab-is-not-recognized).
4. Ask the agent to onboard this checkout with the prompt below. Review and
   approve proposed profile edits before allowing setup:

```text
Set up FixLab for this checkout using --runtime copilot. Inspect the existing
profile and the repository's real frontend/backend folders and scripts.
Propose profile corrections for my approval; do not assume the example
frontend or backend paths exist. Preserve my branch, edits, and running apps.
Show the onboarding plan, then ask before dependency restoration, browser
installation, private-feed access, or application authentication.
Run fixlab doctor --runtime copilot and report every remaining blocker.
Start the dashboard only after readiness and required approvals pass.
Do not change application code, grant blanket permissions, or run a bug job.
```

Generated profiles are examples, not automatic repository detection. Configure
the actual component paths, validation working directories and commands,
frontend startup, browser configuration and required authentication in
`.github\fixlab\repository-profile.json`. If Doctor points at a nonexistent
`frontend` directory, correct the profile; reinstalling FixLab will not fix it.
An existing application's HTTP 200 is not evidence that its UI/API flows or the
repository's required validation gates passed.

5. Complete sign-in/MFA yourself when the approved authentication flow opens.
   Return to Copilot to verify Doctor and ask it to start the dashboard for
   the same checkout. Plugin installation, profile approval, runtime tool
   authorization and application sign-in are separate steps.

For a background permission blocker, review an exact external folder only when
that is the confirmed missing access. A workflow approval does not transfer the
host session's permissions to a background executor. The adapter currently
uses `--allow-all-tools`; folder approval does not make that flag acceptable to
a policy that forbids blanket tool authorization. Keep background jobs blocked
in that case rather than widening permissions or bypassing the policy.
Unknown tool or organization-policy denials also remain blocked;
see [permission troubleshooting](troubleshooting.md#a-validation-command-is-denied-before-execution).

Existing users normally update without uninstalling. Ask Copilot to run:

```powershell
npm install --global github:MonaDevAI/FixLab
copilot plugin update fixlab
```

Restart Copilot afterward. A running dashboard still uses its loaded code:
review its active jobs and request a controlled restart separately. Do not
stop an existing app or dashboard merely because installation completed.
An unmerged PR is not included in a default-branch install; test its reviewed
CLI commit with `npm install --global "github:MonaDevAI/FixLab#<reviewed-commit>"`.
The package version alone may not distinguish GitHub commits.

### Chat with an existing dashboard from Copilot

Keep the dashboard running. In Copilot CLI, open `/mcp` and add a local stdio
server using `fixlab-mcp` from the same updated FixLab installation. If it is
not on `PATH`, use command `node` with one argument: the absolute installed
`mcp/server.js` path (on Windows, for example
`C:\tools\fixlab\node_modules\@fixlab\cli\mcp\server.js`).
Do not point it at a different preview version accidentally. This registers
the bridge; it does not launch another dashboard or agent job.

Ask Copilot to call `fixlab_dashboard_status` with your explicit repository
path and dashboard port, then show any pending question using its question
UI. After your answer, it calls `fixlab_dashboard_reply` with `confirmed:
true`, the returned `instanceId` and `jobId`, your selected action and details.
Conflicts require reading status again rather than retrying an old answer.
Replies continue the same dashboard-owned job, not a replacement job.

`fixlab_dashboard_control` exposes the existing dashboard operations through
that same identity-bound connection. Your explicit request authorizes routine
steps; Copilot should not ask again for every command. Missing decisions,
folder grants, sign-in/MFA, unsafe-data approvals and deployment approvals
still require their normal review. See the
[operation reference](commands.md#copilot-dashboard-control).

You can ask: "FixLab, test this PR using the configured Playwright settings;
do not change code." Copilot must first verify the assigned checkout matches
the PR source commit, then use `job-start` with `mode: "playwright-only"`,
the request and selected environment. This uses the repository's configured
browser journey and authentication instead of guessing an E2E command or
running full regression. It must not label mock results as live backend
validation. If the checkout or required authenticated session is missing, it
reports that exact prerequisite rather than testing an unrelated branch.

For a workspace blocker, review `git status` and the effective diff first.
Explicitly approving reuse sends the reviewed branch and fingerprint; FixLab
rechecks them under its executor lease and keeps the current branch, existing
PR and uncommitted work. Only the configured user's FixLab job branches are
eligible. No reset, stash, base refresh or branch switch is performed.

Choose `validationIntent: "scoped"` to run only affected tests during
iteration. Full regression stays explicitly deferred and PR readiness blocked.
Choose `"full"` later to run the required gates; this does not mark any gate
passed by itself. Independent safe checks can proceed after unrelated
failures, without bypassing their own prerequisites.
For repositories with a reviewed
[API-only validation policy](commands.md#api-only-validation), choose
`"affected"` for change-aware required gates. `"full"` still runs all configured
checks; installing a newer CLI does not enable exclusions in an old profile or
retroactively waive an existing job's failed frontend checks.

The bridge uses loopback HTTP only, bounded responses and a ten-second
deadline. It does not expose raw logs or browser state, grant blanket folder/tool
permissions, complete sign-in, or approve unsafe data access. Permission
questions include the current request identifier and reviewed folder. Use the
existing scoped review and approval operations, or review them in the dashboard;
ordinary conversation replies cannot grant permissions.
It is request/response, not background injection into an idle Copilot chat:
ask for status when you want progress or have Copilot check at workflow
boundaries. A separate background dashboard cannot create native prompts in
an unconnected conversation.

### Change-only Copilot notifications

For a Copilot CLI version supporting extensions and the `joinSession` SDK,
FixLab can monitor one job without a scheduled Copilot polling loop:

```powershell
fixlab notifications C:\source\application
fixlab notifications C:\source\application --yes
```

The first command only prints the installation plan. `--yes` installs trusted
local extension code under the repository's `.github/extensions` directory.
It does not start a dashboard, watcher or model turn. The loader references the
current FixLab installation: keep it untracked, keep that installation present,
and review any existing extension before replacing it. Nested repository paths
resolve to the Git root; linked extension paths and overwrites are rejected.

Reload Copilot extensions, then ask Copilot to read `fixlab_dashboard_status`
and start `fixlab_watch_start` with its exact repository, port, `instanceId`
and `jobId`. Explicitly consent to event-triggered Copilot turns; the tool's
`confirmed: true` must represent that consent. The existing MCP bridge remains
the path for answering blockers and controlling the job.

The extension polls the compact loopback status every ten seconds using local
Node.js code, with no AI call for unchanged status. A new actionable blocker,
completion or stopped watch queues one Copilot message. These event-triggered
turns still consume tokens. Repeated identical blockers do not create repeated
turns; permission request nonces distinguish new permission reviews. Copilot
reads fresh state and asks through the host's question UI, never treating an
event as approval.

Use `fixlab_watch_status` to refresh the exact watched job and
`fixlab_watch_stop` to stop notifications without stopping the job. Monitoring
ends after completion, hold/cancellation, a changed instance/current job, three
consecutive status-read failures, or ambiguous host-delivery failure. It never
automatically attaches another job or retries an ambiguously delivered prompt.
Closing/replacing the Copilot session loses its in-memory watch; reconnect and
consent again. Polling can miss short-lived states; a replacement-job event
does not claim that the old job succeeded.

This extension does not install a permanent operating-system service, run
outside the connected Copilot session, read raw logs/browser state, or grant
runtime, authentication, publication or deployment permissions. Older
dashboards that mark scoped success blocked retain that limitation; a
notification does not turn their deferred gates into passes.

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
the job, or start a bounded FixLab timer:

```powershell
fixlab keep-awake --minutes 180
fixlab dashboard C:\source\application --keep-awake-minutes 180
```

The FixLab timer prevents system sleep without changing permanent power-plan
settings and releases when the duration ends or the owning process stops.
Locking the screen does not stop ordinary commands, but hibernation, process
termination, and network loss can interrupt a local runner. Interactive browser
or authentication steps may still require an unlocked desktop.

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

Start chat from an onboarded repository:

```powershell
fixlab chat
fixlab chat --runtime copilot
```

When the current directory is not an onboarded repository, chat asks for the
repository path. It can also be supplied directly:

```powershell
fixlab chat C:\source\application
```

Use `fixlab dashboard` to start the local UI server without opening a browser:

```powershell
fixlab dashboard
fixlab dashboard --runtime copilot
```

Open the printed URL manually, request `open dashboard` in terminal chat, or
opt in explicitly with `fixlab dashboard --open`. Onboarding and dashboard
reconnections do not automatically open another tab.

It binds only to `127.0.0.1` and uses port `4317` by default. Browser opening
requires explicit opt-in. Select another repository or port:

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
