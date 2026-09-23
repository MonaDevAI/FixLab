# Architecture

FixLab separates orchestration from repository-specific behavior.

FixLab is distributed and versioned as its own product. It supports Agency
Copilot as the default compatibility runtime and GitHub Copilot CLI as an
optional direct runtime. Both provide agent execution, authentication, plugin
loading, and tools; FixLab does not bundle or fork either runtime.

The package keeps equivalent runtime entry points in `agents/fixlab.md` for
Agency and `com.github.copilot/agents/fixlab.agent.md` for the Agent Plugins
1.0 layout used by direct GitHub Copilot CLI. Repository policy validation
requires those definitions to remain identical.

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
packaged Agency plugin, and retains one active job plus a bounded 20-job
pending queue. It also writes the latest 20 private job summaries to the shared
Git directory so bug outcomes and pull-request readiness remain visible after
a dashboard update or restart. It is not the durable, authenticated team broker
described below.

Dashboard requests are typed as `bug-fix` or `small-enhancement`. Bug fixes
require evidence-backed diagnosis and reproduction. Small enhancements use a
risk-scaled fast path: a concise acceptance contract, affected-surface and
bounded-file-scope checks, and the smallest existing focused test. They avoid
manufactured defect reproductions and skip broad suites or full builds unless
the profile or user-visible/risk evidence requires them. Unlike a general
coding agent, FixLab retains explicit review, live-test, pull-request, and
skipped-stage evidence while prohibiting unrelated changes.

Playwright-validation-only mode provides a narrower read-only path for fixes
that are already implemented. It skips source diagnosis, separate
reproduction, implementation, effective-diff review, non-browser validation,
and pull-request work. The runner performs only profile-required setup,
browser-authentication readiness, required application startup, and the
focused Playwright journey. Skipped stages remain explicit rather than being
reported as passed.

The dashboard's primary free-text input is only the bug or required
enhancement. Repository/profile-defined context supplies commands,
applications, systems, environments, and live-test journeys. The agent owns
contract generation, diagnosis or surface inspection, the smallest required
implementation, effective-diff self-review, focused local validation,
profile-defined startup and live testing, evidence collection, and the gated
pull-request outcome. It asks for human interaction only for authentication,
unsafe-data approval, deployment or pull-request approval, or genuine blockers.
The job form also exposes the repository profile's allowed non-production
environments. A user can explicitly select environments such as DEV or SIT for
profile-defined application startup and Playwright live testing. The server
rejects values outside the profile allowlist and production aliases. The agent
must use the selected environment exactly or block with the missing
prerequisite; it cannot silently fall back to local or another environment.
Direct CLI runs provide the equivalent
`fixlab run --environment <profile-environment>` option.
An optional manual-live-test hold keeps the FixLab-owned frontend available
after successful Playwright validation and blocks the PR stage until the user
records a manual local-mode result. The resumed session then stops only its
owned process and continues the normal PR approval flow.

Repository profiles can enable first-class test synthesis. Before browser
execution, the agent turns the reported behavior and expected result into the
smallest focused Playwright scenario and measurable assertions. A
`synthetic-intercepted` source fulfills business-data reads locally and an
`intercepted` mutation mode captures request counts and payloads without
changing external records. The agent emits structured `FIXLAB_TEST` evidence;
the dashboard highlights the actual data source, mutation behavior, and
scenario beside the job roadmap.

Synthesized Playwright source files are transient validation artifacts by
default. FixLab removes them, along with validation-only configuration edits,
before reviewing or creating the product pull request. A generated
authenticated test is persisted only when the user explicitly requests
permanent browser-test coverage or repository instructions require that exact
test. Existing unrelated browser journeys are not changed to make a broad
suite pass.

For an explicitly selected non-production environment whose profile uses
`non-production-read-only`, the selected backend is the primary data source.
FixLab may fall back to `synthetic-intercepted` only when the backend cannot be
reached or cannot provide safe records required to exercise the reported
behavior. Expected empty-state checks remain real-backend checks. A fallback is
reported through activity and test-evidence markers and proves only the focused
UI behavior, not the selected backend or its data.

Jobs can also request local Playwright video evidence. The agent records only
the focused application journey using repository-supported Playwright video
capture, retains the required screenshot, and stores WebM or MP4 output under
the same repository-owned evidence roots. The dashboard serves recordings only
from those allowlisted roots, limits each video to 50 MiB, and never persists
video contents or paths in dashboard history. Recordings must exclude
credentials, browser profiles, personal windows, and unrelated data.

The repository-onboarding panel detects Azure DevOps organization and project
values from an Azure DevOps Git origin and can persist them to the
repository-owned profile. This keeps numeric work-item intake functional after
profile upgrades without exposing credentials or Azure CLI tokens.

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

Each job receives a UUID-backed session from the selected runtime. When the
agent reports a
blocked stage, the local dashboard accepts the required user input and resumes
that same session. Failed jobs can retry, and completed jobs can accept a
focused addition while reusing prior evidence, the branch, and an existing
pull request. Running jobs are not interrupted by dashboard input. The
dashboard records the time of the latest executor output and stops only its
owned executor when no output arrives for the profile-defined
`validation.agentIdleTimeoutMinutes` period (20 minutes by default). The job
then fails explicitly and remains resumable instead of appearing to run
forever. Runtime completion normally waits for output streams to close, but
also settles shortly after the runtime process exits because a retained local
application may inherit an output pipe for a manual-test hold. On startup, a
persisted `running` job with complete terminal markers and a blocked manual
gate is restored as blocked and resumable. Other persisted `running` jobs
cannot still own their original process, so the dashboard converts them to an
interrupted, resumable failure.
New requests submitted while a job is running, blocked, or failed enter the
bounded queue. A passed active job starts the next queued job. Blocked and
failed jobs pause queue advancement so the same session remains resumable. A
user may explicitly dismiss a failed job without resuming it; FixLab preserves
the failed outcome in dashboard history, performs no repository mutation for
that job, and starts the next queued job.
During execution, the agent can emit bounded `FIXLAB_ACTIVITY` evidence and
decision summaries. The dashboard shows these summaries in a separate Agent
analysis panel so users can follow what was checked, what the evidence means,
and what happens next without exposing hidden model reasoning, credentials, or
raw private context. Activity is retained only in the active in-memory job and
is excluded from persisted dashboard history.
The dashboard job list is read-only selectable. Selecting an active, queued,
or recently completed job changes only the displayed roadmap and evidence; it
does not reorder, start, stop, or resume execution. The local server retains
up to 20 job summaries in `.git/fixlab/dashboard-jobs.json` for this view. The
private file contains request summaries, bug identities and outcomes, stage
summaries, and pull-request readiness, but no raw logs, screenshots,
credentials, authentication state, or source content.

## Context and token efficiency

Each job reads the repository profile and existing instructions first, then
uses git status, the effective diff, and task-relevant symbol/file searches to
bound investigation. Work continues in one selected-runtime job/session context.
Unchanged files, completed diagnosis, available dependencies, and broad checks
are not repeated without new risk evidence. Tests and validation are focused
and risk-scaled.

Stage summaries remain structured independently of raw output. The dashboard
retains a bounded local log window and reports how many older entries were
omitted; it does not feed unbounded logs back into prompts.
Polled job responses expose only Azure DevOps identity and state summaries,
not the full loaded descriptions and reproduction text.

Dashboard jobs stream the generated agent prompt through standard input rather
than placing it on the process command line. Request-bearing `fixlab run`
commands use the same stdin transport. Request-free CLI runs instead inherit
terminal stdin so Agency or direct Copilot remains interactive; an
environment-only selection is passed as interactive guidance rather than
starting an autonomous session. This keeps long requests below operating-system
command-line limits without breaking terminal interaction.

The dashboard Agency adapter invokes `agency copilot` with the plugin-qualified
`fixlab:fixlab` agent. The direct dashboard adapter invokes `copilot`, where the
packaged agent is selected as `fixlab:fixlab`, with explicit UUID session or resume
identity, streaming output, non-interactive blocker behavior, and the same tool
approval contract. Direct dashboard mode additionally enables Copilot
autopilot.
Runtime selection changes only execution transport; queueing, marker parsing,
metrics, evidence, validation gates, and pull-request rules remain shared.

Repository profiles may define a Playwright authentication command, non-secret
environment values, and local status paths. The loopback dashboard can start
that command and reports only configured/running/ready state; it never reads or
returns authentication-state contents. The dashboard tracks the owned
authentication process and terminates that handle during clean shutdown.

The loopback dashboard exposes a bounded, selected-job Playwright evidence
gallery. It scans
only repository-owned `test-results`, `playwright-report`, and `artifacts`
directories below the configured browser working directory, ignores symbolic
links and unsupported files, and serves at most 20 images or videos created
after the selected job started. Images use the normal screenshot size limit;
WebM and MP4 videos are limited to 50 MiB each.
Authentication-state paths are outside these allowlisted roots and are never
displayed.

Comments submitted while an agent turn is running are retained only in the
current in-memory job and delivered by resuming the same runtime session after
that turn completes. This preserves the bug batch, branch, evidence, and
existing pull request without interrupting an in-flight tool operation or
creating a second job.

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
