# Architecture

FixLab separates orchestration from repository-specific behavior.

```text
Defect or pull request
        |
        v
FixLab dashboard or CLI
        |
        v
Durable job queue and evidence store
        |
        v
Registered runner
  - isolated worktree
  - repository profile
  - tests and builds
  - local applications
  - browser automation
        |
        v
Result, evidence, and pull request status
```

## Components

### Dashboard or CLI

Collects defect details, screenshots, repository selection, validation mode,
environment choice, and blocker policy. It displays stages, evidence, and
required human actions.

The packaged dashboard is a dependency-free, single-user local implementation.
It binds to `127.0.0.1`, reads the selected repository profile, invokes the
packaged Agency plugin, and retains one in-memory job while the process runs.
It is not the durable, authenticated team broker described below.

Dashboard requests are typed as `bug-fix` or `small-enhancement`. Bug fixes
require evidence-backed diagnosis and reproduction. Small enhancements use a
risk-scaled fast path: a concise acceptance contract, affected-surface and
bounded-file-scope checks, and the smallest existing focused test. They avoid
manufactured defect reproductions and skip broad suites or full builds unless
the profile or user-visible/risk evidence requires them. Unlike a general
coding agent, FixLab retains explicit review, live-test, pull-request, and
skipped-stage evidence while prohibiting unrelated changes.

The dashboard's primary free-text input is only the bug or required
enhancement. Repository/profile-defined context supplies commands,
applications, systems, environments, and live-test journeys. The agent owns
contract generation, diagnosis or surface inspection, the smallest required
implementation, effective-diff self-review, focused local validation,
profile-defined startup and live testing, evidence collection, and the gated
pull-request outcome. It asks for human interaction only for authentication,
unsafe-data approval, deployment or pull-request approval, or genuine blockers.

## Context and token efficiency

Each job reads the repository profile and existing instructions first, then
uses git status, the effective diff, and task-relevant symbol/file searches to
bound investigation. Work continues in one Agency job/session context.
Unchanged files, completed diagnosis, available dependencies, and broad checks
are not repeated without new risk evidence. Tests and validation are focused
and risk-scaled.

Stage summaries remain structured independently of raw output. The dashboard
retains a bounded local log window and reports how many older entries were
omitted; it does not feed unbounded logs back into prompts.

Git repositories also receive a bounded durable metadata cache in
`.git/fixlab/dashboard-cache.json`, using the shared Git directory for
worktrees. Its key combines a hashed repository identity, current `HEAD`, and
the repository-profile content hash. A matching job prompt may reuse the
profile shape, prior result, and sanitized concise stage summaries. It never
stores request text, raw logs, credentials, screenshots, or source contents.
The file is capped at 20 entries and 64 KiB.

Changing `HEAD` or profile content causes an automatic cache miss. Instruction
changes remain an explicit prompt-level invalidation boundary and are reread.
Non-Git repositories skip durable reuse. This cache is deliberately not a
repository scan or source-index cache: current diffs and task-relevant files
remain authoritative.

### Broker

Stores jobs durably, authenticates callers, assigns work to runners, streams
status, and preserves audit records. A team deployment should host this behind
organizational identity and authorization controls.

### Runner

Executes work on a registered machine. A runner owns its worktree, ports,
browser profile, logs, and child processes. It must never terminate unrelated
developer processes.

### Repository profile

Defines:

- Component paths and ownership boundaries
- Restore, lint, test, build, and startup commands
- Frontend and backend ports
- Supported validation environments
- Browser test journeys
- Allowed pull request target branches
- Timeout and blocker behavior

### Evidence store

Preserves structured test results, API assertions, screenshots, decisions,
skipped gates, remaining risks, and pull request links.

## Workflow stages

1. Intake
2. Diagnosis
3. Reproduction
4. Fix or validation
5. Review
6. Local application startup
7. Live testing
8. Pull request outcome

Every required stage must pass or be explicitly marked skipped with a visible
risk. A skipped gate must never be reported as passed.

## Blocker handling

FixLab should support both:

- **Strict:** required builds and tests must complete.
- **Continue on owned-process timeout:** after a configured timeout, terminate
  only the verified FixLab-owned process, record the gate as unverified, and
  continue to independent live validation when safe.

Authentication, authorization, data-safety, and unrelated-process conflicts
must continue to block automatically.
