<p align="center">
  <img src="assets/fixlab-logo.svg" width="180" alt="FixLab logo">
</p>

<h1 align="center">FixLab</h1>

<p align="center">
  From a bug or small enhancement to a tested, evidence-backed pull request.
</p>

FixLab is a reusable engineering workflow that helps teams turn software
defects into tested, review-ready changes.

FixLab is a separately branded, independently versioned product that can run
through **Agency Copilot** or directly through **GitHub Copilot CLI**. Agency
remains the default compatibility runtime. FixLab supplies the specialized
defect investigation, application startup, testing, browser validation, and
evidence workflow without bundling or forking either runtime.

It understands the common shape of applications with a React frontend and a
.NET backend: source code, pull requests, isolated worktrees, tests, local
applications, browser journeys, and validation evidence. Each repository
provides its own commands and paths through a small configuration file, so the
FixLab workflow stays reusable and product details remain with the owning team.

You describe the defect or select a pull request. FixLab prepares an isolated
workspace, investigates the affected code, runs the relevant checks, starts the
required applications, validates the behavior in a browser, and records what
passed, what was skipped, and what still needs human attention.

---

## Get started

1. **Install and sign in to a supported runtime.**

   Agency remains the default:

   ```shell
   agency --version
   agency copilot
   ```

   To use GitHub Copilot CLI directly, install and authenticate `copilot`, then
   select it with `--runtime copilot` or `FIXLAB_RUNTIME=copilot`.

2. **Install or run the FixLab CLI package.**

   ```shell
   npm install --global github:MonaDevAI/FixLab
   fixlab init
   fixlab dashboard
   ```

   While developing locally, use `npm install --global .` from this repository.
   `fixlab init` adds the repository profile and packaged Copilot prompt
   commands plus a `fixlab-autofix` Visual Studio Code agent without
   overwriting existing files. Installation does not start a server; `fixlab
   dashboard` explicitly starts the local dashboard and opens it in the system
   browser.

   FixLab is not yet listed in the official GitHub Copilot plugin marketplace
   and `@fixlab/cli` is not published to the public npm registry. For current
   evaluation, install the CLI and plugin directly from this GitHub repository.
   After the separate marketplace submission is reviewed and merged, the
   stable plugin command will be:

   ```shell
   copilot plugin install fixlab@copilot-plugins
   ```
3. **Describe the application.**
   Set the frontend and backend paths, restore and test commands, startup
   commands, ports, safe environments, and browser journeys.
4. **Start with validation-only mode.**
   Let FixLab verify an existing pull request without changing source code or
   updating the pull request.

   ```shell
   fixlab prepare
   fixlab doctor
   fixlab setup-playwright
   fixlab validate --pr 123
   ```

Detailed instructions are in the
[installation guide](docs/installation.md),
[getting-started guide](docs/getting-started.md) and
[repository onboarding guide](docs/repository-onboarding.md).

## Develop and validate FixLab

FixLab includes repository-level and module-level agent instructions, a
reproducible Node.js development container, a committed dependency lock file,
and one deterministic completion gate:

```shell
./scripts/setup.sh
npm run validate
```

On Windows, run `pwsh -File scripts/setup.ps1` instead of the shell setup
script.

The gate checks JavaScript syntax and whitespace policy, formatting,
repository-wide documentation links and required guidance, focused tests, and
the npm package contents. Pull-request CI also uploads JUnit and documentation
drift reports as machine-readable evidence.

The repository-local CodeBlend skill can reassess the engineering loop:

```text
Run the /codeblend-ai-composite skill against the current repository root.
```

See [AI-readiness engineering](docs/ai-readiness.md) for the baseline,
maintenance loop, and interpretation rules.

To run the plugin through either runtime from this checkout:

```shell
agency copilot --plugin-dir . --agent fixlab:fixlab
copilot --plugin-dir . --agent fixlab:fixlab
```

---

## What FixLab does

FixLab moves through a visible, evidence-backed workflow:

1. **Intake** - captures a defect or pull request and the expected behavior.
2. **Diagnosis** - identifies the affected components and relevant tests.
3. **Isolation** - creates a dedicated Git worktree for the job.
4. **Validation or repair** - runs focused checks and, when enabled, prepares a
   surgical code change.
5. **Application startup** - starts only the frontend and backend processes the
   job owns.
6. **Browser testing** - runs repository-defined Playwright journeys on the
   developer or runner machine.
7. **Evidence** - preserves tests, logs, API assertions, screenshots, skipped
   gates, and remaining risks.
8. **Outcome** - reports validation results or prepares a review-ready pull
   request.

Every required stage must pass or be explicitly marked as skipped with a
visible risk. A skipped check is never reported as successful.

---

## What you can ask FixLab to do

- "Validate pull request 123 without changing it."
- "Reproduce this frontend defect and capture evidence."
- "Find the smallest safe fix and run the affected tests."
- "Use the `fixlab-autofix` VS Code agent to reproduce and fix this bug."
- "Start the React and .NET applications and test this browser journey."
- "Prepare and verify the repository-local Playwright installation."
- "Explain why the production build is blocked."
- "Prepare a pull request with the validation evidence."

The repository profile determines which commands, environments, and browser
journeys are allowed for that application.

---

## Designed for team safety

- **Repository-owned configuration** - application-specific commands and paths
  stay in the application repository.
- **Isolated execution** - each job gets its own worktree, logs, ports, and
  process ownership.
- **Local browser tooling** - Playwright runs on the registered developer or
  runner machine rather than a shared hosted server.
- **Human control** - authentication, sensitive actions, deployment, and pull
  request publication remain permission-controlled.
- **Visible blockers** - timeouts and skipped checks are recorded as risks, not
  converted into false passes.
- **No embedded product data** - credentials, internal endpoints, customer
  records, and application-specific test data do not belong in this repository.

See the full [security model](docs/security.md).

---

## Repository contents

| Path | Purpose |
| --- | --- |
| [`docs/installation.md`](docs/installation.md) | Agency prerequisite, CLI installation, onboarding, update, and uninstall |
| [`docs/FixLab-Installation-and-Smoke-Test.docx`](docs/FixLab-Installation-and-Smoke-Test.docx) | Shareable Word guide for GitHub Copilot CLI or Agency installation and a validation-only smoke test |
| [`docs/getting-started.md`](docs/getting-started.md) | First validation workflow |
| [`docs/architecture.md`](docs/architecture.md) | Dashboard, broker, runner, profile, and evidence architecture |
| [`docs/repository-onboarding.md`](docs/repository-onboarding.md) | How an application adopts FixLab |
| [`docs/security.md`](docs/security.md) | Identity, secrets, process isolation, and data safety |
| [`docs/team-rollout.md`](docs/team-rollout.md) | Recommended team adoption stages |
| [`docs/commands.md`](docs/commands.md) | Packaged FixLab prompt-command workflow |
| [`docs/releasing.md`](docs/releasing.md) | GitHub release and npm trusted-publishing setup |
| [`specs/v1/autofix-loop.md`](specs/v1/autofix-loop.md) | Versioned autofix behavior contract |
| [`specs/v1/validation-evidence.md`](specs/v1/validation-evidence.md) | Versioned completion-evidence contract |
| [`templates/repository-profile.json`](templates/repository-profile.json) | Generic React and .NET repository profile |
| [`examples/react-dotnet`](examples/react-dotnet) | Example onboarding files for a React/.NET repository |
| [`agents/fixlab.md`](agents/fixlab.md) | Agency custom agent |
| [`com.github.copilot/agents/fixlab.agent.md`](com.github.copilot/agents/fixlab.agent.md) | Direct GitHub Copilot CLI custom agent |
| [`prompts`](prompts) | Copilot prompt commands installed by `fixlab init` |
| [`bin/fixlab.js`](bin/fixlab.js) | Dependency-free FixLab CLI |

---

## Current availability

The current GitHub release is `v0.5.4`. This repository contains an installable
CLI, an Agent Plugins 1.0 package for direct GitHub Copilot CLI use, an
Agency-compatible agent, the local dashboard, repository onboarding assets,
and the validation workflow. Install from GitHub while npm and official
marketplace publication remain pending.

The current package launches Agency locally by default and can launch GitHub
Copilot CLI directly. The included dashboard is a single-user local interface
bound to `127.0.0.1`. FixLab does not currently provide a hosted multi-user
broker, shared dashboard, or managed runner service.

Start it from an onboarded repository:

```shell
fixlab dashboard
fixlab dashboard --runtime copilot
fixlab dashboard ..\another-repository --port 4318 --no-open
```

The dashboard reads `.github\fixlab\repository-profile.json`, accepts
`bug-fix` or `small-enhancement` requests in fix-and-validate, validate-only,
or Playwright-validation-only mode, invokes the packaged `fixlab:fixlab` plugin through the selected runtime,
and displays one active staged job with polled logs. Multi-bug requests display one
outcome per Azure DevOps bug, including the responsible boundary such as the
application, MDG, data, or deployment. The Azure DevOps intake accepts up to
20 comma-, space-, or newline-separated IDs or URLs, authenticates once, and
loads the unique bugs concurrently. It runs one job at a time, accepts up to
20 additional jobs in a visible local queue, and does not expose a public
network listener. A blocked or failed active job pauses the queue until the
user resumes it. A failed job can instead be explicitly dismissed while
remaining failed in history, which starts the next queued job without resuming
the failed session. A passed job starts the next queued job automatically. The
job list is selectable: users can inspect the active roadmap, pending
roadmaps, and up to 20 recently completed roadmaps without changing which job
the runner is executing.

Playwright-validation-only mode is the shortest browser path. It skips source
diagnosis, separate reproduction, implementation, diff review, non-browser
validation, and pull-request work. It still performs repository-profile setup
required to start the applications, verifies or requests browser
authentication, executes the focused Playwright journey, and preserves exact
screenshots, traces, failures, blockers, and skipped-stage evidence.

FixLab can also synthesize that focused journey from the bug and expected
behavior. Repository profiles declare the default test-data source and mutation
mode. With `synthetic-intercepted`, Playwright fulfills business-data reads
locally and intercepts mutations, allowing the UI payload and request count to
be verified without changing a real record. The dashboard displays the
reported scenario, data source, and mutation behavior as explicit evidence.

The primary input is only the bug or required enhancement. FixLab obtains
commands, applications, allowed systems and environments, and live-test
journeys from the repository profile. The agent owns the complete lifecycle:
it creates a concise acceptance or fix contract, diagnoses the defect or checks
the affected surface, makes the smallest required change, self-reviews the
effective diff, runs focused local tests/type-checks/builds, starts
profile-defined applications, executes the profile-defined live test, collects
evidence, and creates or updates the pull request only after required gates
pass. It does not ask the user to direct routine steps.

Human interaction is reserved for authentication, unsafe-data approval,
deployment or pull-request approval, and genuine blockers. FixLab never
hardcodes an environment choice; the repository profile supplies and governs
that context. A blocked, failed, or completed job exposes an input panel for
the prerequisite, manual result, retry instruction, controlled skip, or next
focused change. FixLab resumes the same runtime session and reuses completed
diagnosis, validation evidence, branch, and pull request.

Manual entry is the default intake path and remains available for every
repository. Optionally, paste up to 20 Azure DevOps work-item URLs or IDs and
select **Load bugs**. Numeric IDs use the repository profile:

```json
{
  "azureDevOps": {
    "organization": "your-organization",
    "project": "your-project"
  }
}
```

Full URLs use their own organization and project. The dashboard obtains an
Azure DevOps resource token from the locally authenticated `az` CLI identity
and uses it only for the HTTPS request. Tokens are never displayed, logged,
stored in job state, or cached. Missing Azure CLI, authentication, profile
fallback, work-item access, or malformed URLs fail explicitly. Loaded intake
includes safe text fields such as title, description, reproduction steps,
acceptance criteria, state, type, web URL, and the newest 20 non-deleted
comments; HTML is converted to readable text. A comment-only access failure is
shown explicitly without discarding the rest of the bug. FixLab downloads up
to five supported attached or embedded images with the same local token.
Non-image attachments are never downloaded automatically.

Manual or Azure DevOps intake can include up to five PNG, JPEG, or WebP
screenshots by file selection or by pressing `Ctrl+V` anywhere on the
dashboard, limited to 2 MiB each and 8 MiB total. Other browser-readable
clipboard image formats are converted to PNG. Azure DevOps images share the
same count and size limits. Files receive generated
names and remain outside tracked source under
`.git\fixlab\dashboard-artifacts\<job-id>` (or a repository-specific OS
temporary directory for non-Git repositories). Only local paths and user text
are sent to the agent. The dashboard removes the prior job's artifacts when a
new job becomes active, retains queued-job artifacts until their turn, removes
all active and queued artifacts on clean shutdown, and prunes artifact
directories older than seven days at startup. Abrupt termination can leave
files until that pruning pass.

Within a job, FixLab reads the profile and repository instructions first,
checks git status and the effective diff, and focuses searches on relevant
symbols and files. It reuses the same runtime session context and avoids
rereading unchanged files, repeating completed diagnosis, reinstalling
available dependencies, or rerunning broad checks without risk evidence.
Validation remains focused and risk-scaled. Stage summaries are retained
separately, while the local raw-log view is bounded to avoid unbounded context.

For Git repositories, the dashboard keeps a small durable metadata cache under
the repository's Git directory at `.git\fixlab\dashboard-cache.json` (or the
shared Git directory for worktrees). Entries are keyed by repository identity,
current `HEAD`, and the repository-profile content hash. A matching later job
receives only the concise profile shape, prior result, and sanitized stage
summaries. The cache never stores request text, raw logs, credentials,
screenshots, screenshot paths, or source contents; it is capped at 20 entries
and 64 KiB.

The dashboard also stores up to 500 privacy-safe job metric records in
`.git\fixlab\dashboard-metrics.json` in the shared Git directory. Period cards
cover bugs queued, completed-job counts, average execution time, and exact
input, cached-input, cache-write, and output token totals when Copilot emits a
terminal usage summary. **Input cache reuse** is cached input divided by total
input. It is not labelled token reduction or cost savings because those claims
require a trustworthy comparable baseline. Metrics exclude request text,
comments, screenshots, credentials, raw logs, and source contents.

`HEAD` or profile-content changes automatically miss the cache. Instruction
changes are also prompt-level invalidation boundaries and must be reread. For
correctness, non-Git repositories do not receive durable cache reuse. This is
verified metadata reuse, not a durable repository scan or source-index cache;
task-specific facts are always checked against the current diff and relevant
files.

Small enhancements use a risk-scaled fast path: FixLab defines a concise
acceptance contract, checks and bounds the affected surface, uses the smallest
existing focused test, and avoids manufacturing a defect reproduction. Broad
suites and full builds are skipped unless the profile or user-visible/risk
evidence requires them. Unlike a general coding agent, this path still requires
explicit review, live-test, pull-request, and skipped-stage evidence and
prohibits unrelated changes.

### Runtime selection

`@fixlab/cli` intentionally does not bundle Agency or GitHub Copilot CLI.
Agency is the default compatibility runtime:

```shell
agency copilot --plugin-dir <fixlab-package> --agent fixlab:fixlab
```

Direct mode uses the same packaged plugin. Both runtimes select the namespaced
agent identifier `fixlab:fixlab`:

```shell
fixlab run --runtime copilot -- "fix this defect"
fixlab validate --pr 123 --runtime copilot
fixlab dashboard --runtime copilot
```

Set `FIXLAB_RUNTIME=copilot` to make direct mode the local default. Long
dashboard prompts continue to travel over standard input rather than process
arguments. Session IDs, resume, streaming output, stage markers, queueing,
metrics, evidence, and validation gates remain identical across adapters.

The dashboard includes **Check status** and **Connect Playwright** controls when
the repository profile defines `browserAutomation.authentication`. Status is
based only on repository-owned local state paths; authentication output and
browser-state contents are not returned to the browser or stored by FixLab.
For the selected job, it also displays up to 20 recent PNG, JPEG, or WebP screenshots from
repository-owned `test-results`, `playwright-report`, and `artifacts`
directories created after that job started. Each Playwright live test must save at least one non-sensitive
screenshot under `test-results`; authentication-state files are never scanned
or served.
While a job is running, **Add comment to current job** queues a focused
instruction for the same runtime session. It is delivered automatically after
the current agent turn and does not create another dashboard job or pull
request.

Run `fixlab doctor --runtime copilot` or `fixlab doctor --runtime agency` to
verify the selected runtime plus Git, Node.js, the repository-selected .NET
SDK, PowerShell, repository-local Playwright package, a real headless browser
launch, and the repository profile before starting a job.

---

## Learn more

- [Install FixLab](docs/installation.md)
- [Get started](docs/getting-started.md)
- [Understand the architecture](docs/architecture.md)
- [Onboard a repository](docs/repository-onboarding.md)
- [Review the security model](docs/security.md)
- [Plan a team rollout](docs/team-rollout.md)

---

<p align="center">
  Copyright &copy; 2026 FixLab Contributors. All rights reserved.<br>
  Released under the <a href="LICENSE">MIT License</a>.
</p>
