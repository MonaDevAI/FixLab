# FixLab

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
   npm install --global @fixlab/cli
   fixlab init
   ```

   While developing locally, use `npm install --global .` from this repository.
   `fixlab init` adds the repository profile and packaged Copilot prompt
   commands without overwriting existing files.
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
and registered runner service remain separate future distribution layers.

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
