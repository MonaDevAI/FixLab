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

### 1. Install a supported runtime

Agency is the default compatibility runtime:

```shell
agency --version
agency copilot
```

For direct mode, install and authenticate GitHub Copilot CLI, then use
`--runtime copilot` or set `FIXLAB_RUNTIME=copilot`.

### 2. Install and initialize FixLab

```shell
npm install --global github:MonaDevAI/FixLab
fixlab init
fixlab doctor
fixlab dashboard
```

`fixlab init` adds the repository profile, packaged prompt commands, and the
`fixlab-autofix` Visual Studio Code agent without overwriting existing files.
`fixlab dashboard` starts the local loopback dashboard and opens it in the
system browser.

FixLab is not yet published to the public npm registry or merged into the
official GitHub Copilot plugin marketplace. Until marketplace review is
complete, install it directly from this GitHub repository.

### 3. Start with validation-only mode

Validate an existing pull request without changing its source or updating the
pull request:

```shell
fixlab prepare
fixlab setup-playwright
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
- **Playwright evidence** including measurable assertions, screenshots,
  traces, failures, and explicit data-source behavior.
- **Resumable workflows** for authentication, genuine blockers, manual
  validation, and focused follow-up instructions.
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

The current GitHub release is **v0.6.1**. It includes:

- The dependency-free FixLab CLI.
- An Agent Plugins 1.0 package for GitHub Copilot CLI.
- An Agency-compatible agent.
- A single-user local dashboard.
- Repository onboarding templates and React/.NET examples.
- Manual and Azure DevOps work-item intake.
- Focused validation, browser evidence, queueing, metrics, and recovery.

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
npm run validate
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
