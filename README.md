<p align="center">
  <img src="assets/fixlab-logo.svg" width="180" alt="FixLab logo">
</p>

<h1 align="center">FixLab</h1>

<p align="center">
  From a bug or small enhancement to a tested, evidence-backed pull request.
</p>

FixLab is a reusable engineering workflow for investigating, validating, and
repairing software defects. It combines repository-aware diagnosis, isolated
worktrees, focused tests, local application startup, Playwright browser
journeys, and review evidence in one visible workflow.

FixLab is designed for applications with a **React frontend and .NET backend**.
Application-specific commands, paths, environments, and browser journeys stay
in a small repository-owned profile, so FixLab remains product-neutral.

FixLab runs through **Agency Copilot** or directly through
**GitHub Copilot CLI**. It does not bundle or fork either runtime.

## At a glance

| | |
| --- | --- |
| **Use cases** | Bug fixes, small enhancements, pull-request validation, and focused Playwright validation |
| **Primary scope** | React frontends with .NET backends |
| **Execution** | Local developer or registered runner machine |
| **Runtimes** | Agency Copilot or GitHub Copilot CLI |
| **Output** | Test results, logs, screenshots, blockers, risks, and a review-ready pull request |
| **Safety model** | Repository-owned configuration, isolated worktrees, human-controlled sensitive actions |

## Get started

Already inside Copilot? Follow the
[Copilot installation steps](docs/installation.md#starting-from-an-existing-copilot-session)
without opening a separate terminal.

### 1. Install a supported runtime

Agency is the default compatibility runtime:

```shell
agency --version
agency copilot
```

For direct mode, install and authenticate GitHub Copilot CLI, then use
`--runtime copilot` or set `FIXLAB_RUNTIME=copilot`.

Direct Copilot dashboard jobs use the official Copilot SDK and its bundled
runtime to show live **Allow once / Deny** permission prompts and agent questions.
Your response continues the same executor; human wait does not trigger the idle
timeout. Authentication stays in the normal browser. Agency and unclassified
text denials retain the existing fail-closed folder-review flow. See
[background runtime permissions](docs/commands.md#background-runtime-permissions).

Select a direct Copilot model with `--model <model>` or `FIXLAB_MODEL`.
For the account-dependent HydraFusion research preview:

```powershell
fixlab dashboard C:\path\to\application --runtime copilot --model hydrafusion --open
```

The Copilot dashboard also offers a per-job model selector. Leave it at
Copilot default to avoid an override. Model selection is not supported by the
Agency runtime; unavailable models produce runtime errors rather than silently
switching models. Preview models may buffer stage updates, and FixLab does not
guarantee lower token usage, charges, or elapsed time.

### 2. Install and initialize FixLab

```shell
npm install --global github:MonaDevAI/FixLab
fixlab chat
```

When no dashboard is running, chat asks for the local repository path. For a
new or incomplete repository it opens the interactive onboarding agent first;
after the profile becomes ready, it starts the loopback dashboard and connects.
Ask it in plain language to onboard the repository, diagnose a UI or API bug,
run the profile-defined React/.NET validation, and create or update the pull
request. The repository-path form `fixlab C:\path\to\application` remains
available for a direct Agency-like interactive agent session.

Example UI request:

To control an existing dashboard from the current Copilot conversation, connect
the bundled MCP server using the
[Copilot dashboard chat setup](docs/installation.md#chat-with-an-existing-dashboard-from-copilot).
It supports status and recovery replies plus existing dashboard job, queue,
validation, frontend, authentication, permission and intake operations.
For automatic change-only prompts without scheduled AI polling, opt into the
[Copilot notification extension](docs/installation.md#change-only-copilot-notifications).
Its local monitor makes no model calls while checking status; only new
blockers, completion or an ended connection enqueue Copilot turns.
For example: "FixLab, test this PR using the configured Playwright settings;
do not change code." The host verifies the PR checkout and uses browser-only
mode rather than starting a full fix/regression job.
Repositories can also opt into
[change-aware API-only validation](docs/commands.md#api-only-validation):
internal API changes run the reviewed backend gates, while excluded frontend
checks remain explicitly not applicable. Full validation still runs every
configured gate, and uncertain or cross-component changes retain full coverage.
Reviewed [component path-to-gate policies](docs/commands.md#component-validation)
can also select the combined required checks for other known change surfaces.
An optional [pre-launch permission review](docs/commands.md#pre-launch-permission-handoff)
collects an exact job-bound folder approval before executor startup; it does
not grant tools, URLs, or organization-policy exceptions.

```text
Reproduce this React UI bug, make the smallest fix, run focused tests and
Playwright, capture evidence, and create or update the PR.
```

Example API request:

```text
Reproduce this .NET API bug, make the smallest fix, run focused tests and
build, start the backend when required, verify the HTTP behavior, and create
or update the PR.
```

For explicit plan-first onboarding without entering the interactive shell:

```shell
fixlab onboard C:\path\to\application
```

For a new worktree of an already configured repository, use
`fixlab onboard C:\path\to\worktree --from C:\path\to\application`.
Review the source profile and its `worktreeSetup.files` allowlist, then rerun
with `--yes` to provision only those non-sensitive files and run setup.
Onboarding also discovers external linked `node_modules` directories and
requires explicit approval before recording their exact runtime path grants.
Authentication and MFA remain interactive; credentials and browser state are
never copied. See [Repository onboarding](docs/repository-onboarding.md).

The first onboarding run creates the repository-owned profile and stops for
review. After configuring that profile, rerun to inspect the setup plan, then
approve dependency restoration, Playwright setup, browser authentication, and
dashboard startup explicitly:

```powershell
fixlab onboard C:\path\to\application --yes --authenticate --start-dashboard --runtime copilot
```

On Windows, when Node/npm command resolution may be inconsistent, use the
plan-first bootstrap from a FixLab clone:

```powershell
pwsh -File scripts/install-fixlab.ps1 -Repository C:\path\to\application
pwsh -File scripts/install-fixlab.ps1 -Repository C:\path\to\application -Yes
```

The bootstrap discovers NVM for Windows, honors an exact repository Node pin,
tests a real npm operation, and invokes the selected `npm.cmd` by absolute
path. It never installs Node unless `-InstallNode` is also supplied.

If NVM repeatedly produces an incoherent runtime, install a checksum-verified
portable Node runtime without changing the system `PATH`:

```powershell
pwsh -File scripts/repair-node-runtime.ps1 -Repository C:\path\to\application
pwsh -File scripts/repair-node-runtime.ps1 -Repository C:\path\to\application -Yes
```

`fixlab init` adds the repository profile, packaged prompt commands, and the
`fixlab-autofix` Visual Studio Code agent without overwriting existing files.
`fixlab dashboard` starts the local loopback dashboard and opens it in the
system browser. `fixlab chat` attaches a terminal chat to that dashboard's
active job so terminal and browser interactions share one session and evidence
record. When no dashboard is running, `fixlab chat` uses the current onboarded
repository or asks for its path, starts the dashboard in the background, and
then connects. Streaming activity clears and redraws the `fixlab>` line so
partially typed input remains usable while validation continues. Background
activity is buffered until the current input line is submitted. At startup,
chat displays the connected repository and lets the user keep it or enter
another path; a different repository starts on the next available loopback
port. Common operational requests also work as plain English, including
`start dashboard`, `show status`, `show logs`, `show pull request`,
`show evidence`, and `switch repository`. `new bug <details>` creates a
separate bug-fix job instead of adding guidance to the current job. Waiting
jobs can be removed without interrupting the active job by selecting **Remove
from queue** in the dashboard or typing `cancel waiting job <position>`.
The dashboard lifecycle controls can also hold an active or waiting job,
resume a held job in its retained session, restart a terminal job with a new
job ID and session, and delete terminal history older than a chosen number of
days. Active, waiting, and held jobs are never removed by history cleanup.

FixLab is not yet published to the public npm registry or merged into the
official GitHub Copilot plugin marketplace. Until marketplace review is
complete, install it directly from this GitHub repository.

### 3. Start with validation-only mode

Validate an existing pull request without changing its source or updating the
pull request:

```shell
fixlab prepare
fixlab setup-playwright
fixlab authenticate
fixlab validate --pr 123
```

See the [installation guide](docs/installation.md),
[getting-started guide](docs/getting-started.md), and
[repository onboarding guide](docs/repository-onboarding.md) for complete
setup instructions.

## How it works

```text
Bug, enhancement, or pull request
              |
              v
      Repository profile
              |
              v
 Intake -> Diagnosis -> Isolation -> Fix or validation
              |
              v
 Tests -> Local applications -> Browser journey
              |
              v
 Evidence, risks, and pull-request outcome
```

Every required stage must pass or be explicitly recorded as skipped with a
visible risk. FixLab never reports a skipped or timed-out gate as successful.

## What FixLab provides

- **Repository-aware diagnosis** that reads project instructions, inspects the
  effective diff, and focuses on relevant symbols and tests.
- **Isolated execution** using a dedicated Git worktree, owned ports, logs, and
  child processes.
- **Focused validation** through repository-defined lint, test, type-check,
  build, API, and browser commands.
- **Readiness preflight** for repository profiles, runtimes, package managers,
  authentication, application startup, and configurable doctor timeouts before
  expensive work begins.
- **Early draft pull requests** that become visible after focused regression
  checks while independent local builds and browser validation continue, then
  publish after local validation and approval without waiting for remote CI.
- **Playwright evidence** including measurable assertions, screenshots,
  videos, traces, failures, explicit data-source behavior, connect-and-retry
  authentication, and reuse of an already started React frontend.
- **Resumable workflows** for authentication, genuine blockers, manual
  validation, focused follow-up instructions, one-click failed-job recovery,
  and preserved completed stages after interruption.
- **Dashboard job controls** for a bounded queue, cancellation, hold/resume,
  restart with retained history, age-based history cleanup, status heartbeats,
  and privacy-safe metrics.
- **Chat-first operation** through browser or terminal, including natural
  language status, logs, evidence, pull-request, repository-switching, and
  new-job commands.
- **Long-running reliability** through bounded keep-awake sessions,
  command-aware redacted summaries, nested-worktree fingerprints, linked
  dependency support, and explicit blocked/timed-out/skipped outcomes.
- **Pull-request readiness** based on completed gates, effective-diff review,
  remaining risks, and preserved evidence.

FixLab supports three primary modes:

| Mode | Purpose |
| --- | --- |
| **Fix and validate** | Diagnose a defect or small enhancement, make the smallest safe change, and run required validation |
| **Validate only** | Verify an existing change or pull request without modifying source |
| **Playwright validation only** | Run the shortest browser-focused path and preserve browser evidence |

Example requests:

- "Validate pull request 123 without changing it."
- "Reproduce this frontend defect and capture evidence."
- "Find the smallest safe fix and run the affected tests."
- "Start the React and .NET applications and test this browser journey."
- "Prepare a pull request with the validation evidence."

## Safe by design

- Application-specific behavior remains in the application repository.
- Local services bind to `127.0.0.1`.
- Playwright runs on the developer or runner machine, not a shared FixLab
  server.
- Only FixLab-owned processes and artifact directories may be stopped or
  removed.
- Credentials, browser state, private endpoints, and customer data are never
  stored in source, prompts, logs, or durable caches.
- Authentication, unsafe-data access, deployment, and pull-request publication
  remain human-controlled.

Read the complete [security model](docs/security.md).

## Current availability

The current GitHub release is **v0.7.3**. It includes:

- The dependency-free FixLab CLI.
- An Agent Plugins 1.0 package for GitHub Copilot CLI.
- An Agency-compatible agent.
- A single-user local dashboard.
- Repository onboarding templates and React/.NET examples.
- Manual and Azure DevOps work-item intake.
- Focused validation, early draft pull requests, and browser evidence with
  screenshots, traces, and optional video.
- Queue cancellation, hold/resume, terminal-job restart, age-based history
  cleanup, recovery, status heartbeats, and privacy-safe metrics.
- Repository preflight, configurable doctor and idle timeouts, authenticated
  Playwright connect/retry, and reuse of a pre-started React frontend.
- Browser and terminal chat controls for status, logs, evidence, comments,
  retries, owned-process stops, repository switching, and new jobs.
- Bounded keep-awake support and command-aware summaries that retain redacted
  evidence while reducing the output sent back into an agent session.

The dashboard is local and bound to `127.0.0.1`. FixLab does not currently
provide a hosted multi-user broker, shared dashboard, or managed runner
service. Detailed queue, intake, caching, metrics, authentication, runtime, and
evidence behavior is documented in
[Architecture](docs/architecture.md) and
[Getting started](docs/getting-started.md).

## Develop FixLab

Install reproducibly and run the repository completion gate:

```shell
./scripts/setup.sh
npm run validate
```

On Windows:

```powershell
pwsh -File scripts/setup.ps1
pwsh -File scripts\validate.ps1
```

The Windows runner executes the same complete `npm run validate` gate while
temporarily preventing idle system/display sleep. It restores the previous
execution state on success or failure and preserves the gate's exit code.
It does not change power plans, override manual sleep, increase test deadlines,
skip checks, or turn a successful retry into a passing aggregate.

Local and CI unit suites run at most two test files concurrently. This bounds
overlapping process-tree, PowerShell compiler, and browser fixtures on shared
machines without increasing their deadlines or weakening containment checks.
Individual tests retain their concurrency behavior. CI still fails when an
initial failure passes its one bounded confirmation; retries never turn flaky
results into a successful validation gate.

To run browser acceptance against an installed package rather than this checkout:

```powershell
$env:FIXLAB_TEST_PACKAGE_ROOT = 'C:\path\to\node_modules\@fixlab\cli'
npm run test:e2e
Remove-Item Env:FIXLAB_TEST_PACKAGE_ROOT
```

Run the plugin from this checkout:

```shell
agency copilot --plugin-dir . --agent fixlab:fixlab
copilot --plugin-dir . --agent fixlab:fixlab
```

## Documentation

| Guide | Purpose |
| --- | --- |
| [Installation](docs/installation.md) | Runtime prerequisites, installation, updates, and uninstall |
| [Troubleshooting](docs/troubleshooting.md) | CLI, package manager, private feed, Playwright, and runtime errors |
| [Getting started](docs/getting-started.md) | First validation workflow and dashboard use |
| [Architecture](docs/architecture.md) | Dashboard, queue, runtime, cache, metrics, runner, and evidence design |
| [Repository onboarding](docs/repository-onboarding.md) | Adopt FixLab in a React/.NET repository |
| [Security](docs/security.md) | Identity, secrets, process isolation, and data safety |
| [Team rollout](docs/team-rollout.md) | Recommended adoption stages |
| [Commands](docs/commands.md) | Packaged FixLab prompt-command workflow |
| [Releasing](docs/releasing.md) | GitHub release, marketplace, and npm publishing |
| [AI-readiness engineering](docs/ai-readiness.md) | Repository evaluation and maintenance loop |

Versioned behavior contracts are in
[`specs/v1`](specs/v1), and a generic repository profile is available at
[`templates/repository-profile.json`](templates/repository-profile.json).

---

<p align="center">
  Copyright &copy; 2026 FixLab Contributors. All rights reserved.<br>
  Released under the <a href="LICENSE">MIT License</a>.
</p>
