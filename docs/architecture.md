# Architecture

FixLab separates orchestration from repository-specific behavior.

FixLab is distributed and versioned as its own product. Agency Copilot remains
an external runtime dependency that provides agent execution, authentication,
plugin loading, and tools; FixLab does not bundle or fork Agency.

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
packaged Agency plugin, and retains one active in-memory job plus a bounded
20-job pending queue while the process runs. It is not the durable,
authenticated team broker described below.

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

### Intake sources

Manual text is the default and permanently available intake path. Azure DevOps
intake accepts a full `dev.azure.com` work-item URL, or an ID when
`azureDevOps.organization` and `azureDevOps.project` are configured in the
repository profile. Up to 20 unique IDs or URLs can be loaded as one batch.
The local server asks Azure CLI for one Azure DevOps resource token using the
developer's authenticated identity, loads the items concurrently, uses the
token only in outbound HTTPS authorization headers, and does not expose it to
the browser, job state, logs, prompts, or cache.

The loader keeps ID, title, description, reproduction or acceptance text,
state, type, web URL, and the newest 20 non-deleted comments after converting
HTML to text. A comment-request failure becomes a bounded explicit warning
without hiding the accessible work item. The loader discovers supported
attached files and authenticated embedded-image URLs, downloads at most five
PNG, JPEG, or WebP images within the shared 2 MiB per-image and 8 MiB total
limits, and skips non-image attachments. Azure-loaded, user-selected, or
clipboard-pasted screenshots are validated by count, declared type, extension,
base64 encoding, signature, per-file size, and total size. Generated local
files live under the Git directory or a repository-specific OS temporary
directory. Only their local paths are placed in the job prompt.

Artifacts belong to active or queued dashboard jobs. Replacing a completed
active job removes its files, clean shutdown removes active and queued files,
and startup prunes directories older than seven days. Abrupt process
termination can retain artifacts until the next pruning pass.

Each job receives a UUID-backed Agency session. When the agent reports a
blocked stage, the local dashboard accepts the required user input and resumes
that same session. Failed jobs can retry, and completed jobs can accept a
focused addition while reusing prior evidence, the branch, and an existing
pull request. Running jobs are not interrupted by dashboard input.
New requests submitted while a job is running, blocked, or failed enter the
bounded queue. A passed active job starts the next queued job. Blocked and
failed jobs pause queue advancement so the same session remains resumable.

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
Polled job responses expose only Azure DevOps identity and state summaries,
not the full loaded descriptions and reproduction text.

The dashboard streams the generated agent prompt through standard input rather
than placing it on the process command line. This keeps multi-bug requests and
other long inputs below operating-system command-line limits while preserving
the same in-memory prompt and output stream.

Git repositories also receive a bounded durable metadata cache in
`.git/fixlab/dashboard-cache.json`, using the shared Git directory for
worktrees. Its key combines a hashed repository identity, current `HEAD`, and
the repository-profile content hash. A matching job prompt may reuse the
profile shape, prior result, and sanitized concise stage summaries. It never
stores request text, raw logs, credentials, screenshots, screenshot paths,
or source contents.
The file is capped at 20 entries and 64 KiB.

The shared Git directory also holds
`.git/fixlab/dashboard-metrics.json`, bounded to 500 job records. Records
contain identifiers, queue/start/finish timestamps, terminal status, bug count,
execution and queue-wait durations, and parsed Copilot token totals. They never
contain request text, comments, screenshots, credentials, raw logs, or source
content. The local API aggregates 24-hour, 7-day, 30-day, or all-retained
periods. Cache reuse is `cached input / total input`; without a defined
comparable baseline it is not represented as exact token reduction or cost
savings.

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

## Repository engineering loop

FixLab itself uses the same deterministic loop expected from onboarded
repositories:

1. Repository and module agent instructions define scope and safety invariants.
2. A lock-file-backed development environment installs reproducibly.
3. `npm run validate` runs syntax linting, formatting policy, documentation
   drift checks, focused tests, and package-content validation.
4. Pull-request CI publishes JUnit and documentation-drift evidence.
5. CODEOWNERS and the pull-request template keep a human reviewer on the loop.
6. Scheduled maintenance deletes only GitHub Actions artifacts older than the
   configured retention window, caps deletions per run, and retains a
   machine-readable report.
7. A failed CI run triggers evidence-preserving containment. The follow-up
   workflow never checks out or executes untrusted pull-request code; it
   records the failure and notifies the affected pull request or issue queue.
8. If a trusted push to `main` fails, the rollback workflow proposes a revert
   pull request. The rollback never auto-merges and must pass the normal status
   checks and approving-review policy.
9. The self-healing drill independently exercises the flaky-containment and
   rollback algorithms without forcing a production CI failure.

The documentation drift gate resolves local Markdown links and verifies that
the contributor completion command remains documented. This is intentionally
deterministic; semantic review can add advice but cannot replace the blocking
repository-wide check.

## Blocker handling

FixLab should support both:

- **Strict:** required builds and tests must complete.
- **Continue on owned-process timeout:** after a configured timeout, terminate
  only the verified FixLab-owned process, record the gate as unverified, and
  continue to independent live validation when safe.

Authentication, authorization, data-safety, and unrelated-process conflicts
must continue to block automatically.
