<p align="center">
  <img src="assets/fixlab-logo.svg" width="180" alt="FixLab logo">
</p>

<h1 align="center">FixLab</h1>

<p align="center">
  From a bug or small enhancement to a tested, evidence-backed pull request.
</p>

FixLab is a reusable engineering workflow that helps teams turn software
defects into tested, review-ready changes.

FixLab is **powered by Agency Copilot**. Agency supplies the agent runtime,
authentication, plugin loading, tools, and interactive session. FixLab supplies
the specialized defect investigation, application startup, testing, browser
validation, and evidence workflow. FixLab does not install or replace Agency.

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

1. **Install and sign in to Agency Copilot.**

   Follow your organization's supported Agency installation and authentication
   instructions, then verify:

   ```shell
   agency --version
   agency copilot
   ```

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
3. **Describe the application.**
   Set the frontend and backend paths, restore and test commands, startup
   commands, ports, safe environments, and browser journeys.
4. **Start with validation-only mode.**
   Let FixLab verify an existing pull request without changing source code or
   updating the pull request.

   ```shell
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

To run the Agency plugin directly from this checkout:

```shell
agency copilot --plugin local:. --agent fixlab:fixlab
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
| [`prompts`](prompts) | Copilot prompt commands installed by `fixlab init` |
| [`bin/fixlab.js`](bin/fixlab.js) | Dependency-free FixLab CLI |

---

## Current availability

This repository now contains an installable CLI and local Agency plugin in
addition to the reusable architecture, onboarding contract, and repository
profile template. The CLI provides repository initialization, prerequisite
diagnostics, direct agent launch, and validation-only pull request launch.

The current package launches Agency locally. A shared dashboard, durable broker,
and registered runner service remain separate future distribution layers. The
included dashboard is a single-user local interface bound to `127.0.0.1`.

Start it from an onboarded repository:

```shell
fixlab dashboard
fixlab dashboard ..\another-repository --port 4318 --no-open
```

The dashboard reads `.github\fixlab\repository-profile.json`, accepts
`bug-fix` or `small-enhancement` requests in fix-and-validate or validate-only
mode, invokes the packaged
`FixLab:fixlab` Agency plugin from that repository, and displays one staged job
with polled logs. It runs one job at a time and does not expose a public network
listener.

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
that context.

Manual entry is the default intake path and remains available for every
repository. Optionally, paste a full Azure DevOps work-item URL and select
**Load**, or enter a numeric ID when the repository profile supplies:

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
acceptance criteria, state, type, and web URL; HTML is converted to readable
text. Private work-item attachments are never downloaded automatically.

Manual or Azure DevOps intake can include up to five PNG, JPEG, or WebP
screenshots, limited to 2 MiB each and 8 MiB total. Files receive generated
names and remain outside tracked source under
`.git\fixlab\dashboard-artifacts\<job-id>` (or a repository-specific OS
temporary directory for non-Git repositories). Only local paths and user text
are sent to the agent. The dashboard removes the prior job's artifacts when a
new job starts, removes active artifacts on clean shutdown, and prunes artifact
directories older than seven days at startup. Abrupt termination can leave
files until that pruning pass.

Within a job, FixLab reads the profile and repository instructions first,
checks git status and the effective diff, and focuses searches on relevant
symbols and files. It reuses the same Agency session context and avoids
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

### Runtime dependency

`@fixlab/cli` intentionally does not bundle Agency. The `fixlab run` and
`fixlab validate` commands resolve the installed `agency` executable and launch:

```shell
agency copilot --plugin local:<fixlab-package> --agent fixlab:fixlab
```

Run `fixlab doctor` to verify Agency, Git, Node.js, .NET, PowerShell, the
repository-local Playwright package, a real headless browser launch, and the
repository profile before starting a job.

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
