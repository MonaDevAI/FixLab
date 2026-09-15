# Changelog

All notable changes to FixLab are documented in this file.

## Unreleased

- Add an optional direct GitHub Copilot CLI runtime for the CLI and dashboard
  while retaining Agency as the default compatibility runtime.
- Add repository-configured Playwright authentication status/connect controls
  and same-session comments for running dashboard jobs.
- Highlight the inferred active roadmap step while a running agent is between
  explicit stage updates.
- Load bounded Azure DevOps comments and images, support clipboard-pasted
  screenshot evidence, and expose access warnings without discarding bugs.
- Add a visible 20-job running queue with same-session blocker handling.
- Add privacy-safe period statistics for bugs, execution time, exact Copilot
  token usage, and input cache reuse.
- Add a repository-installed `fixlab-autofix` Visual Studio Code agent and
  `/fixlab.bugfix` prompt for one-bug reproduce, repair, and verification
  workflows.
- Add versioned autofix/evidence specifications, enforced repository policy
  checks, a scheduled GitHub agentic learned-rule review, and automatic revert
  pull-request proposals for failed trusted pushes.
- Add executable proof-of-bug/proof-of-fix coverage for flaky containment and
  multi-commit rollback restoration, plus a scheduled proof drill.
- Require code-owner review, stale-approval dismissal, and passing CI/CodeQL
  checks for normal changes to `main`.

## 0.5.1

- Add the reusable FixLab logo to the public repository and packaged assets.
- Display the product identity prominently in the GitHub README.

## 0.5.0

- Add manual or Azure DevOps work-item intake.
- Add bounded local screenshot evidence without storing tokens, request
  attachments, or screenshot paths in the repository metadata cache.
- Sanitize loaded work-item content and use the developer's local Azure
  authentication without persisting bearer tokens.

## 0.4.0

- Add an explicit, dependency-free local dashboard command for any onboarded
  repository.
- Add bug-fix and risk-scaled small-enhancement request types.
- Add token-efficiency guidance, bounded dashboard logs, and a safe,
  metadata-only same-repository cache.
- Show repository readiness, staged job progress, and polled local logs.
- Enforce single-job execution, validate-only protections, complete terminal
  stage markers, safe static serving, and owned-child shutdown.
- Package the dashboard UI and add integration coverage with a fake executor.

## 0.3.1

- Fix `fixlab run` and `fixlab validate` to use Agency's resolved `FixLab`
  plugin qualifier.
- Add regression coverage for launching the packaged FixLab agent.

## 0.3.0

- Add repository-installed FixLab prompt commands.
- Add GitHub Actions for continuous integration and npm releases.
- Add MIT licensing and GitHub contribution templates.
- Add React/.NET onboarding examples and release documentation.

## 0.2.0

- Add guided repository-local Playwright setup.
- Support npm, pnpm, Yarn, and configured browser channels.
- Verify the configured browser with a real headless launch.

## 0.1.0

- Package the FixLab CLI and Agency Copilot plugin.
- Add repository profiles, validation-only workflows, and onboarding guides.
