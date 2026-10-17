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

Direct Copilot execution accepts `--model` or `FIXLAB_MODEL`; Agency rejects
nonempty model overrides. Dashboard jobs retain their selected model through
queueing, retries and saved-context recovery. An omitted model uses the
dashboard's configured default; an explicit empty selection uses Copilot's
own default. HydraFusion adds `--experimental --model hydrafusion` and remains
an account-dependent research preview, not a guaranteed cost or speed saving.
Stage markers are requested before tools and parsed even when adjacent in
rendered output, but model-dependent buffering can still delay visible updates.
Snapshots also retain their originating runtime. A dashboard restores only
compatible jobs; other-runtime or ambiguous legacy contexts remain in history
rather than being silently resumed through a different executor.

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

`fixlab <repository>` is the Agency-like conversational entry point. It opens
the packaged FixLab agent directly in that repository so setup, diagnosis,
implementation, and validation can proceed in one interactive runtime
session. `fixlab chat` is a separate thin terminal client for an already
running dashboard job. When the dashboard is unavailable, chat uses the
current ready repository or prompts for its path. For an incomplete repository
it creates the initial profile when missing and opens the interactive
onboarding agent; after readiness succeeds, it starts the dashboard as a
detached loopback process and reconnects. It polls only the loopback dashboard
API, streams the bounded job output, and sends comments or resume actions back
to the same dashboard-owned runtime session. Exiting the terminal leaves the
job running; an explicit stop request terminates only the executor owned by
that job.

The stdio MCP server also connects an existing host conversation to that
dashboard. `fixlab_dashboard_status` reads a bounded `/api/conversation`
projection containing instance/repository/job identity, stages, gate status
and an actionable recovery question, without raw logs or private inputs.
`fixlab_dashboard_reply` submits an explicit user answer to
`/api/conversation/reply`. The server checks instance, repository and current
job identity after reading the request body, before any state change. Stale
answers conflict instead of targeting a replacement job. Permissions and
authentication retain their separate approval flows. The host must invoke
status and its question UI; MCP does not inject prompts into idle sessions.

An optional Copilot notification extension supplies event-only delivery
separately from that request/response MCP bridge. Its in-process Node.js
monitor reads the same bounded loopback projection without model calls,
bound to one canonical repository, dashboard instance and job. Unchanged
states stay local. New blocker fingerprints, reviewed permission nonces,
completion and monitor termination enqueue a host turn through
`session.send({ mode: "enqueue" })`; those turns still consume tokens.
Messages contain identity and event metadata, not raw blocker instructions,
logs or request bodies. The host refreshes state before presenting a decision
and retains all existing explicit-approval and mutation guards.

Installation and starting a watch are separate opt-ins. The monitor does not
persist configuration or job content, automatically follow replacement jobs,
or continue beyond its Copilot session. Completion, hold/cancellation and
identity replacement end the watch. Consecutive read failures are bounded,
and ambiguous message-delivery failures stop rather than creating duplicate
approval prompts. Private history, required gate evidence and executor process
ownership are unchanged. This monitor observes state, not the runtime itself.

`fixlab_dashboard_control` covers existing job/queue, profile gate, frontend,
authentication, scoped permission, session and intake operations through a
fixed route allow-list. Each request carries the expected instance, canonical
repository and current job; writes also carry explicit user authorization.
The dashboard advertises the identity-bound control protocol; MCP refuses
older dashboards rather than sending requests whose guards could be ignored.
The server verifies these before dispatch and after asynchronous body reads,
then runs the original handler and its existing safety checks. Forwarded
responses use bounded operational metadata rather than raw logs, browser state
or credentials. The bridge does not replace authentication, process ownership,
permission nonces, environment approvals or executor-backed validation.
Browser-only PR requests must verify the assigned source commit and use the
repository's Playwright configuration instead of guessing commands or quietly
expanding to full regression.

Shared-checkout admission failures on an eligible configured-user FixLab
branch expose a reviewed-reuse question instead of misleading incomplete
stage markers. Explicit approval binds the branch, HEAD, profile branch
configuration and tracked/untracked content fingerprint. Admission rechecks
this under the executor lease, preserves the current branch and work, records
the original branch-owner job ID, and does not fetch or switch. Saved ownership
still verifies branch format and base ancestry on subsequent resumes.
In-progress Git operations and unverified executor termination remain blocked.
When admission never started a runtime session, reviewed recovery starts one
with the same job ID rather than attempting to resume a nonexistent session.
Dashboard-generated pending-gate review blockers do not count as agent progress
for a zero-progress launch retry.

User-selected scoped iteration is persisted separately from gate evidence.
Full regression remains deferred and readiness blocked until the user
selects full validation and the required gates pass. Independent safe checks
can continue after unrelated failures; dependencies and approvals still apply.

An opt-in `validation.changeAware` policy generalizes API-only selection to
reviewed component path-to-gate mappings. All matching scope gate sets are
combined, with pinned-baseline and executed-history safeguards unchanged.
Unknown, empty, unreadable and full-validation-path changes retain all gates.
An optional job `permissionPreflight` pauses before executor admission and
uses the existing exact-folder review/approval flow. It grants nothing by
itself, and the first approved invocation starts a new runtime session rather
than resuming one that never ran. No grants persist across dashboard restart.

The packaged dashboard is a dependency-free, single-user local implementation.
It binds to `127.0.0.1`, reads the selected repository profile, invokes the
packaged Agency plugin, and retains one active job plus a bounded 20-job
pending queue and a separate persisted held-job collection. It also writes the
latest 20 private job summaries to the shared Git directory so bug outcomes,
held workflow state, and pull-request readiness remain visible after a
dashboard update or restart. It is not the durable, authenticated team broker
described below.

Same-repository dashboard instances publish private, temporary loopback
ownership records and verify the random instance ID at the live endpoint
before forwarding a session-control request. The session panel reconnects to
live owners or resumes their saved job context; stop and shutdown require
explicit owner confirmation. Shutdown leaves the HTTP dashboard available
and stops only its tracked agent, frontend and authentication processes.
Conflicting reachable owners are reported rather than automatically killed.

Executor admission also acquires one atomic filesystem lease per canonical
repository before invoking a runner. Git worktrees share the Git common
directory; standalone non-Git repositories use their canonical directory.
An acquisition records the owner, job, process generation and a unique nonce.
All new jobs, queue starts, retries and automatic continuations use this same
boundary. A logical timeout or stop request does not release the lease or
enable resume before the executor's termination promise settles. Unverified
termination, partial reservations and owner crashes remain fail-closed; neither
an HTTP timeout nor PID reuse authorizes automatic reclamation.

An opt-in `worktreeSetup.mode: "shared"` profile lets sequential dashboard jobs
reuse the selected checkout. Admission holds that same executor lease while
checking cleanliness, refreshing the configured remote base and acquiring a
job-specific branch. Its branch and base commit are persisted with the job.
Held/resumed jobs reacquire their saved branch without syncing it to the base;
restarted jobs acquire a new branch. PRs can remain pending while another job
uses the folder, but dirty files, in-progress Git operations and owned
frontend/authentication processes prevent branch changes. The executor must
leave its assigned branch selected. See [shared checkout setup](repository-onboarding.md#reusing-one-checkout-for-sequential-jobs).

Windows executors launch suspended, enter a non-breakaway Windows Job Object,
then resume. Each executor has one hidden console that ordinary tooling
descendants inherit, preventing transient PowerShell and command-prompt windows
without sharing shell state between jobs. Input, output and errors remain piped
to the supervisor and dashboard logs. Noninteractive CLI probes and setup
helpers also hide their Windows console windows; interactive agent sessions
continue using the user's terminal.
If the runtime reports that permission was denied because no interactive user
was available, the dashboard stops its owned executor at the first denial and
keeps the lease until termination is verified. It displays a separate permission
panel rather than treating ordinary workflow input or PR approval as runtime
authorization. Current CLI text output does not identify a structured permission
scope; the panel says so and does not infer that a denied command is safe.

For a confirmed external-folder restriction, the user can review an absolute
folder and explicitly grant its resolved path before restarting the same job.
The resumed executor receives only that additional `--add-dir` scope; the grant
includes read/write access and trusted agent configuration beneath that folder.
Roots, home and repository ancestors, broader installation parents, and known
credential/browser-state/configuration folders are rejected. The target is
revalidated at approval and each subsequent launch. Approval is bound to the
current job and request nonce, requires the dashboard's exact loopback host and
same origin, and never survives a restart or transfers to a new job. A late,
stale, or unconfirmed approval cannot start an executor. Ordinary comments,
retries and automatic continuation cannot bypass the pending permission review.
Tool, URL, sandbox and organization-policy restrictions remain authoritative;
a folder grant does not authorize them. Another denial pauses again instead of
automatically retrying or granting blanket access. This is a folder-access
handoff, not an interactive Copilot permission-prompt bridge.
Managed long-running frontends keep their input pipe open until owned shutdown;
React-style servers can interpret EOF as a request to exit. One-shot setup and
authentication helpers still receive EOF, and process-tree containment and
termination proofs remain unchanged.
The supervisor terminates remaining descendants after launcher
exit or an owned stop request, and records a nonce-bound proof only after the
job's active process count reaches zero. Lease release requires both supervisor
exit and that proof; a supervisor crash remains fail-closed. This uses built-in
Windows PowerShell and its C# compiler, with no native package dependency.
Unavailable containment or missing proof is an explicit failure, never a
fallback to launcher-only checks. Dedicated Windows CI exercises real detached
descendants, explicit stop, wrapper crash and lease succession.

Manual localhost validation must use a frontend managed outside the Windows
executor, such as the dashboard's React session, and verify it serves the
validated checkout. Dashboard-managed applications remain under session
controls rather than being terminated by an agent. Missing checkout or health
evidence remains a blocker.

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
An optional manual localhost gate is independent of Playwright. After the
profile-defined React frontend passes its loopback health check, the dashboard
opens that URL in the user's default browser, keeps the FixLab-owned frontend
available, and blocks completion until the user records Passed or Failed. The
resumed session then stops only its owned process and continues the normal
gated outcome.

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

Artifacts belong to active, queued, or held dashboard jobs. Holding a job keeps
its artifacts available while the dashboard remains running. Replacing a
completed active job removes its files, clean shutdown removes registered job
files, and startup prunes directories older than seven days. Abrupt process
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
Waiting jobs can be removed by queue position or job ID before execution. The
dashboard records the job as cancelled, deletes only its FixLab-owned
screenshot artifacts, renumbers the remaining queue, and never interrupts the
active executor.
An active job can instead be held. The dashboard marks it `holding`, stops only
the executor owned by that job, flushes bounded partial output, persists it as
`held`, and immediately advances the waiting queue. Blocked, failed, and
waiting jobs can be held without launching an executor. Resuming a previously
started held job reuses its UUID runtime session and retained workflow stage;
resuming a held waiting job returns it to normal first-launch queue semantics.
A terminal passed, failed, blocked, or cancelled job can be restarted as a new
job with a new ID and runtime session while the original outcome remains in
history.

Age-based cleanup accepts a whole number of days and removes only terminal
passed, failed, blocked, or cancelled summaries older than that cutoff. It can
remove a terminal current summary as well as retained history, but never
deletes an active, waiting, or held job. FixLab removes only the purged jobs'
owned artifact directories and does not mutate repository source.
During execution, the agent can emit bounded `FIXLAB_ACTIVITY` evidence and
decision summaries. The dashboard shows these summaries in a separate Agent
analysis panel so users can follow what was checked, what the evidence means,
and what happens next without exposing hidden model reasoning, credentials, or
raw private context. When executor output is quiet during a long-running build,
test, or browser step, the dashboard adds periodic heartbeat comments to this
panel so expected command latency is distinguishable from a stalled session.
Heartbeats do not count as executor output and do not reset the profile-defined
idle watchdog. Activity is retained only in the active in-memory job and is
excluded from persisted dashboard history.
The dashboard job list includes active, queued, held, and recently completed
jobs. Selecting a job changes the displayed roadmap and evidence and enables
only lifecycle actions valid for its current state; selection alone never
changes execution. The local server retains up to 20 job summaries in
`.git/fixlab/dashboard-jobs.json` for this view. The private file contains
request summaries, bug identities and outcomes, stage summaries, held state,
and pull-request readiness, but no raw logs, screenshots, credentials,
authentication state, or source content.

## Context and token efficiency

Each job reads the repository profile and existing instructions first, then
uses git status, the effective diff, and task-relevant symbol/file searches to
bound investigation. Work continues in one selected-runtime job/session context.
Unchanged files, completed diagnosis, available dependencies, and broad checks
are not repeated without new risk evidence. Tests and validation are focused
and risk-scaled.

For fix-and-validate jobs with pull-request publication already authorized,
FixLab uses an early-draft pipeline. After the scoped production change and
smallest focused regression checks pass, it removes transient validation
artifacts, reviews the effective diff, pushes the checkpoint, and creates or
updates a draft pull request. Independent builds, application startup, and
browser journeys continue while the draft is visible. Later reviewed
checkpoints update the same branch and PR. The PR remains explicitly
validation-in-progress until required local validation and approval gates
pass or repository policy records an accepted outcome. FixLab then publishes
the authorized PR by clearing its draft status and verifies the provider's
`isDraft` state is false before reporting the PR stage passed. Publication
does not wait for remote CI or build completion: some providers trigger PR
builds only after publication. Those checks remain reported as pending, not
passed, and normal review, build, and merge policies remain enforced. Failed
publication or state verification blocks or fails the PR stage.

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
worktrees. Its key combines a hashed repository identity, current `HEAD`,
source/worktree fingerprint, repository-profile hash, and instruction-content
hash. A matching job prompt may reuse the profile shape, prior result, fixed
stage/status summaries, and concise validation gate statuses. Agent-written
messages are not copied into this memory. It never
stores request text, raw logs, credentials, screenshots, screenshot paths,
or source contents.
The file is capped at 20 entries, 64 KiB, and seven days. Memory is advisory;
it cannot pass a validation gate. Recurring lessons still require review in
the existing learned-rules workflow before becoming repository instructions.

The shared Git directory also holds
`.git/fixlab/dashboard-metrics.json`, bounded to 500 job records. Records
contain identifiers, queue/start/finish timestamps, terminal status, bug count,
execution and queue-wait durations, and parsed Copilot token totals. They never
contain request text, comments, screenshots, credentials, raw logs, or source
content. The local API aggregates 24-hour, 7-day, 30-day, or all-retained
periods. Cache reuse is `cached input / total input`; without a defined
comparable baseline it is not represented as exact token reduction or cost
savings.

Changing `HEAD`, worktree inputs, profile content, or discovered repository
instructions causes an automatic cache miss. Current instructions are reread.
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

`fixlab exec` is the command-output boundary between validation tools and the
agent context. It captures stdout and stderr separately, redacts credential
patterns before persistence, and returns only bounded unique diagnostics,
framework-aware test counts, tail failures, timing, and context-reduction
metadata. Node test/TAP, Playwright, Jest, and .NET test summaries retain
passed, failed, skipped, cancelled, and total counts without returning every
successful test line. Full redacted evidence and `result.json` are stored under
the worktree's Git-private
`fixlab/command-evidence` path, never in tracked source.

Each compact summary reports raw and retained line counts, byte counts,
estimated tokens, omitted lines, and the reduction percentage. The same
measurements are persisted in `result.json.context` so reductions can be
compared across commands and repositories without retaining raw output in the
agent prompt. Token counts use the transparent `bytes / 4` estimate and are
directional rather than model-billing measurements.

Successful deterministic local validations may be reused only by explicit
request. Their fingerprint includes platform, command and arguments, stage,
working directory, Git `HEAD`, content hashes for every tracked and untracked
file, worktree status, and repository-profile content. A changed input causes execution;
failed results are never cached. Evidence and cache records are capped at 100
entries and seven days, and each output stream is capped at 50 MiB.
Individual lines exceeding 64 Ki characters are omitted with an explicit
capture notice so an unbroken output stream cannot grow collector memory
without bound. Retained diagnostic and failure-tail lines are limited to
2000 characters; the private evidence retains other lines up to capture limits.

### Dashboard-owned validation gates

Profiles may declare `validation.gates`: between one and 20 required entries
with a unique lowercase `id`, executable `command`, string `args`,
repository-relative `workingDirectory`, and `timeoutSeconds` (1-7200).
Choose the smallest commands that cover the repository contract; gates are
not inferred from restore, startup, authentication, or deployment commands.
The template contains examples and must be adapted during onboarding.

An optional `validation.apiOnly` policy supplies a reviewed base reference,
literal internal-API paths, mandatory full-validation paths, and a subset of
configured gate IDs. It applies only to `validationIntent: "affected"`; profiles
without the policy preserve the existing default, and explicit `"full"` never
excludes a gate. A policy-enabled new job defaults to affected validation.
The dashboard captures the shared checkout's assigned base or the merge base
with the configured reference after checkout admission, then persists that
commit across recovery. Recovery is tracked independently of runtime-session
reuse, so a fresh-runtime retry cannot recapture an unavailable baseline.
Missing saved baselines and Git inspection failures
fall back visibly to all configured gates, never to fewer checks.

The classifier unions committed, staged, unstaged and untracked paths, disables
rename collapsing, and requires every changed path to be in the API allowlist
and outside the declared contract/consumer-impact paths. Unknown, empty or
cross-component changes require all gates. This is reviewed path-based policy,
not semantic proof: uncertain API compatibility requires explicit full coverage.
Applicability is recomputed before execution and at completion; status polling
reuses that checkpoint instead of repeatedly spawning Git. Previously run
gates remain required even if a later edit narrows the path set, retaining their
failure evidence. Excluded gates have `status: "not-applicable"` and a reason,
not a synthetic command result or a passed status. API-scope completion and
full validation remain distinct in dashboard and MCP projections.
Private snapshots retain a bounded executed-gate history with IDs, statuses,
and exit codes, not logs or command contents. Recovery preserves failures and
cancellations, makes saved passes or interrupted executions stale, and keeps
all previously executed gates required. Missing legacy history retains full
coverage for that job; malformed or incompatible history blocks recovery.

Dashboard jobs receive `fixlab gate --port <port> --job <id> --gate <id>
--repository <worktree>` instructions. The loopback endpoint resolves the
executable from the job's reviewed profile, not from request-supplied commands.
It accepts only the current running job, rejects browser-origin requests,
restricts the target to the assigned dashboard checkout, and runs one bounded
gate at a time through the structured executor. This applies in shared and
isolated modes; sharing a Git common directory does not establish assignment.
For isolation, onboard the worktree and start its dashboard before creating a
gated job. Gated jobs cannot switch checkouts through a validation request.
Requests are rejected after owned executor stop or dashboard shutdown begins,
including requests whose bodies were still arriving when shutdown began.
Only executor results can pass these gates; agent stage markers cannot.

Unchanged successful job-local evidence is reused when a gate is requested
again only if the profile explicitly sets `reuse: true` and its command is
eligible deterministic local validation. Reuse defaults to off. Playwright,
live checks, startup, authentication, installation, deployments, and mutations
must not opt in; unsupported command families never reuse. Failed results are
not reused. Source changes during a check make its
result stale. Final job completion fingerprints inputs again and blocks
readiness for missing, failed, cancelled, timed-out, or stale evidence.
Holding and held jobs remain blocked until resumed completion verifies inputs.
Deleted and renamed tracked files are included in source fingerprints.
While a dashboard-owned gate runs, its own timeout replaces agent-output idle
detection; the agent idle watchdog is rearmed after gate success or failure.
Profile changes require a new job. Cancellation and dashboard shutdown stop
the owned validation command. Evidence from a previous dashboard process is
not trusted as a fresh pass after restart.

Legacy profiles without gates can still launch, but dashboard PR readiness
is explicitly blocked as unconfigured. Playwright-only jobs retain their
existing browser-evidence contract and do not acquire non-browser gates.
Gate status is available in the job API; compact command evidence is shown in
dashboard logs. Full evidence remains Git-private. This is validation
enforcement inside FixLab, not interception of every agent shell command or
an authorization boundary against a process running as the same local user.
It does not independently prevent an agent from publishing a PR through an
unmediated external tool. Freshness is verified at job completion; later
external edits require a resumed job and revalidation.

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
