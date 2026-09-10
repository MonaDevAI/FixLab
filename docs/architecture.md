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

