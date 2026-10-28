# FixLab documentation

Use this index instead of treating every guide as an installation checklist.
The Markdown guides are the maintained source of truth; the superseded
installation/smoke-test Word guide has been consolidated into them.

## Install and run your first job

| Guide | What it covers |
| --- | --- |
| [Installation](installation.md) | Prerequisites, guided/manual setup, updates, and uninstall |
| [Copilot installation prompt](installation.md#copy-paste-installation-prompt) | One reviewed setup request to paste into Copilot |
| [Visual Studio Code](installation.md#install-and-use-in-visual-studio-code) | CLI setup and discovery of the repository custom agent |
| [Getting started](getting-started.md) | First validation request, dashboard controls, evidence, and recovery |
| [Repository onboarding](repository-onboarding.md) | Application profiles, worktrees, API-only validation, and linked applications |
| [Troubleshooting](troubleshooting.md) | Known installation, feed, browser, runtime, and readiness failures |

## Understand and operate FixLab

| Guide | What it covers |
| --- | --- |
| [Architecture and benefits](architecture-overview.md) | Diagram-led introduction, job flow, deployment, and trust boundaries |
| [Architecture reference](architecture.md) | Detailed execution, queue, permission, recovery, cache, and evidence contracts |
| [Commands](commands.md) | CLI/prompt workflows, validation gates, MCP controls, and runtime permissions |
| [Security model](security.md) | Identity, secrets, process ownership, local isolation, and data safety |
| [Team rollout](team-rollout.md) | Staged adoption and review practices |

Optional host integration is described in
[Copilot dashboard chat](installation.md#chat-with-an-existing-dashboard-from-copilot)
and [change-only notifications](installation.md#change-only-copilot-notifications).
Neither replaces application authentication or grants blanket tool permissions.

## Contribute and maintain

| Guide | What it covers |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Reproducible development setup and required completion gates |
| [Releasing](releasing.md) | GitHub releases, plugin distribution, and npm publication |
| [AI-readiness engineering](ai-readiness.md) | Evaluation and maintenance loop |
| [AI-readiness decision](adr/0001-ai-readiness-feedback-loop.md) | Rationale for the repository feedback loop |
| [Versioned contracts](../specs/v1) | Behavioral specifications |
| [Changelog](../CHANGELOG.md) | Recorded product changes |

For vulnerability reporting, follow [SECURITY.md](../SECURITY.md).
