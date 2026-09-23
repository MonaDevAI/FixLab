# Changelog

All notable changes to FixLab are documented in this file.

## Unreleased

- Keep backend-first validation and transient synthesized-Playwright cleanup
  guidance aligned across dashboard, CLI, packaged-agent, and initialized-agent
  entry points.
- Promote a scoped learned rule and regression gate for cross-runtime
  behavioral guidance parity.
- Forward CLI requests to Agency over standard input and verify that
  backend-first guidance appears only when both an approved environment and
  non-production read-only data are selected.
- Keep request-free runs interactive by reserving stdin forwarding and the
  autonomous Agency invocation for runs that carry a request, and preserve
  inherited terminal input for interactive use.

## 0.6.1 - 2026-09-21

- Keep synthesized authenticated Playwright scenarios out of product pull
  requests unless permanent browser-test coverage is explicitly requested or
  required by repository instructions.

## 0.6.0 - 2026-09-21

- Refresh installation, release, marketplace, availability, and team-rollout
  guidance to distinguish current GitHub distribution from pending npm,
  marketplace, and hosted-service work.
- Identify MonaDevAI as the plugin publisher in marketplace-facing metadata.
- Warn when `fixlab init` preserves an older profile that requires newly
  mandatory fields, and document the explicit test-synthesis upgrade.
- Explain directly in the dashboard how to correct and resume a failed active
  job before its paused queue can continue.
- Add an explicit, confirmed failed-job dismissal that preserves the failed
  history entry and advances the queue without resuming repository work.
- Clear and refocus the bug input after every successful submission, including
  jobs added to the running queue.
- Use an explicitly selected DEV or SIT read-only backend as the primary data
  source, with visible synthetic fallback only when required data is
  unavailable and without claiming backend validation.

## 0.5.4 - 2026-09-18

- Create tagged GitHub releases independently of optional npm publication and
  require an explicit repository opt-in before publishing to the npm registry.

## 0.5.3 - 2026-09-18

- Install the Playwright Chromium runtime before the tagged release validation
  gate so browser tests can run on a fresh GitHub-hosted runner.

## 0.5.2 - 2026-09-18

- Recover persisted running jobs as interrupted and resumable after dashboard
  restart.
- Stop an owned executor after a configurable no-output interval and display
  the latest output age so stalled jobs do not appear active indefinitely.
- Add first-class Playwright test synthesis with repository-configured
  synthetic/intercepted data, structured scenario evidence, and a highlighted
  dashboard summary of data source and mutation behavior.
- Keep unrelated test, lint, type-check, and production-build diagnostics out
  of the local application-startup stage so independently ready Playwright
  validation can continue.
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
- Add Agent Plugins 1.0 marketplace release guidance, correct the documented
  GitHub Copilot agent identifier, and provide a concrete private vulnerability
  reporting route.

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
