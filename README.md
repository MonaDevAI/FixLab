<p align="center">
  <img src="assets/fixlab-logo.svg" width="180" alt="FixLab logo">
</p>

<h1 align="center">FixLab</h1>

<p align="center">
  From a bug or small enhancement to a tested, evidence-backed pull request.
</p>

FixLab coordinates repository-aware diagnosis, scoped code changes, focused
tests, and Playwright validation through **Agency Copilot** or **GitHub Copilot**.
It supports React/.NET applications and backend-only API validation.
Application-specific paths, commands, environments, and safety rules stay in
the application's repository-owned profile.

## Get started

**First installation:** read [installation.md](installation.md) for prerequisites,
what FixLab adds to your machine, and reviewed repository setup.
Use the [detailed installation guide](docs/installation.md) for other setup paths
or download the [Word quickstart](docs/FixLab-Installation-Guide-Quickstart.docx).

Install and authenticate a supported Copilot runtime, then run:

```powershell
npm install --global github:MonaDevAI/FixLab
```

### Onboard and check the application before chat

```powershell
fixlab onboard C:\source\application --runtime copilot
```

If onboarding creates an example profile, replace its paths and commands with
the real application layout, then rerun `onboard` to review the restore and
Playwright setup plans. Do not create empty folders to satisfy example paths.
After reviewing and approving that setup:

```powershell
fixlab onboard C:\source\application --runtime copilot --yes
fixlab doctor C:\source\application --runtime copilot
```

Resolve every Doctor blocker before continuing. Add `--authenticate` to the
approved onboarding command only if the profile requires browser sign-in;
complete sign-in and MFA yourself.

### Start chat

```powershell
fixlab chat C:\source\application --runtime copilot
```

Replace the path with your checkout; use `--runtime agency` for Agency.
Guided setup checks readiness before starting the local dashboard. Review the
profile and approve only the required setup, sign-in, and tool operations.
Installing the CLI alone does not start a service or make an application ready.
The profile's `frontend` and `backend` paths are examples: point them to your
real checkout layout rather than creating empty folders to satisfy checks.

Prefer Copilot to perform setup? Use the
[copy-paste installation prompt](docs/installation.md#copy-paste-installation-prompt).
For VS Code, follow the
[custom-agent setup](docs/installation.md#install-and-use-in-visual-studio-code).

### Stop or replace an unused dashboard

At `fixlab>`, `/stop` stops the job and leaves it resumable; `/exit` disconnects
chat without stopping the dashboard. Press **Ctrl+C in the dashboard's
terminal** to stop the server and release its port.

If Copilot started it in the background, ask:

> Shut down FixLab on port 4317 and only its owned processes. Leave other
> applications running.

Start a replacement using the available port:

```powershell
fixlab dashboard C:\source\application --port 4317 --runtime copilot
```

In another terminal, connect chat to that same port:

```powershell
fixlab chat C:\source\application --port 4317 --runtime copilot
```

Closing a browser tab or exiting Copilot does not stop a detached dashboard.
No reinstall or file deletion is needed. Restarting preserves saved jobs;
submit a new request for a fresh job.

## What you can do

| Workflow | Outcome |
| --- | --- |
| Fix a bug or small enhancement | Scoped changes, validation evidence, and an authorized pull request |
| Validate an existing change or PR | Findings and evidence without source or PR changes |
| Run focused Playwright validation | Browser or configured API assertions without an implementation job |

## Architecture and benefits

FixLab coordinates the developer-facing dashboard and CLI, a repository-owned
profile, Copilot execution, and configured validation. It runs locally on the
developer or runner machine; the configured AI service supplies model access.

### System architecture

![FixLab architecture: local orchestration, repository contract, Copilot runtime, evidence, and external services](assets/fixlab-architecture-diagram.png)

The dashboard and terminal chat share job state, blockers, and results.
Interrupted work can resume in the same job; a bounded queue keeps later
requests separate.
During the existing PR step, verified reusable learning is captured in a
reviewed repository skill (`.github/skills/<topic>/SKILL.md`), updating a
matching skill rather than duplicating it. No extra roadmap stage is added.
If there is no new reusable learning, the PR says so instead of adding a file.

### End-to-end job flow

![FixLab workflow: intake, diagnosis, reproduction, change, review, local stack, live test, and outcome](assets/fixlab-workflow-diagram.png)

Efficient delivery defaults to focused checks and an authorized **draft PR**.
Optional broad tests/builds are controlled by saved preferences; required
repository checks and CI/merge policies still apply. Failed, deferred, stale,
or skipped checks are never reported as passed.

See [architecture and benefits](docs/architecture-overview.md) for components,
benefits, deployment, recovery, and trust boundaries, or the
[architecture reference](docs/architecture.md) for runtime and MCP contracts.

## Documentation

| Start here | Read next |
| --- | --- |
| [First installation](installation.md) | Prerequisites, machine changes, and reviewed setup |
| [Detailed installation](docs/installation.md) | Copilot prompt, VS Code, updates, and optional integrations |
| [Getting started](docs/getting-started.md) | First job, dashboard use, approvals, and recovery |
| [Architecture and benefits](docs/architecture-overview.md) | Component diagrams, job flow, deployment, and trust boundaries |
| [Repository onboarding](docs/repository-onboarding.md) | Profiles, worktrees, API-only validation, and linked applications |
| [Troubleshooting](docs/troubleshooting.md) | Installation, authentication, runtime, and validation blockers |
| [All documentation](docs/README.md) | Technical references, security, rollout, and contributor guides |

## Execution and safety

FixLab is a **single-user local tool**, not a hosted multi-user broker or
managed runner service. The dashboard binds to `127.0.0.1`; worktrees isolate
changes, not operating-system privileges.

Authentication, sensitive actions, deployment, and publication retain their
approval requirements. Only FixLab-owned processes and artifacts may be
cleaned up. Never put credentials, browser state, private endpoints, or
customer data in prompts, source, logs, or durable caches.
See the [security model](docs/security.md).

Install from GitHub until npm/marketplace publication is available; consult
[GitHub releases](https://github.com/MonaDevAI/FixLab/releases) for published
versions. A default-branch install can contain changes newer than a release.

## Contributing

See [Contributing](CONTRIBUTING.md) for reproducible setup and the required
`npm run validate` completion gate, including the Windows validation runner.
Behavior contracts live in [`specs/v1`](specs/v1); start a repository profile
from [`templates/repository-profile.json`](templates/repository-profile.json).

---

<p align="center">
  Copyright &copy; 2026 FixLab Contributors. All rights reserved.<br>
  Released under the <a href="LICENSE">MIT License</a>.
</p>
