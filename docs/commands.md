# FixLab commands

## Interactive repository shell

```text
fixlab <repository> [--runtime <agency|copilot>]
```

This is the shortest Agency-like entry point. FixLab opens its interactive
agent in the selected repository and retains conversational context while it
inspects or helps onboard the repository, accepts a bug or enhancement,
diagnoses the affected behavior, implements the smallest fix, validates it,
and prepares the evidence-backed pull-request outcome.

Use `fixlab run <repository> -- <request>` when the complete request is already
known and should execute without first entering the interactive conversation.

## Repository onboarding

```text
fixlab onboard [repository] [--yes] [--authenticate] [--start-dashboard] [--runtime <agency|copilot>]
```

The first run creates the repository profile and stops before using generic
placeholder paths. After the profile is configured, a plan-only run prints the
repository-owned restore and Playwright commands. `--yes` approves those
commands, `--authenticate` runs the repository-owned interactive browser login,
and `--start-dashboard` starts the dashboard only after Doctor passes.

`fixlab init` installs these prompt files under `.github/prompts` without
overwriting repository-owned versions.

| Command | Purpose | Completion gate |
|---|---|---|
| `/fixlab.bugfix` | Run the full VS Code reproduce, repair, and verification loop for one bug | The root cause is fixed and every affected gate has explicit evidence |
| `/fixlab.intake` | Capture the defect, expected behavior, scope, and safe data | The request is measurable and missing inputs are explicit |
| `/fixlab.diagnose` | Trace the affected code and establish the root cause | The cause is supported by repository evidence |
| `/fixlab.reproduce` | Create or run the smallest failing check | The original symptom is reproduced or a blocker is recorded |
| `/fixlab.fix` | Implement the smallest complete correction | Only required production and test files are changed |
| `/fixlab.validate` | Run focused tests, lint, type-check, and builds | Every required check passes or is explicitly skipped with risk |
| `/fixlab.live-test` | Start owned applications and run the browser journey | The running application proves the expected behavior |
| `/fixlab.pr` | Prepare the evidence-backed pull-request outcome | The PR contains the exact change, evidence, and remaining risks |

The commands read `.github/fixlab/repository-profile.json` and repository
instructions before acting. They never replace repository-owned commands,
environment controls, or approval requirements.

## Executor-backed dashboard checks

`fixlab gate --port <port> --job <id> --gate <id> --repository <worktree>`
runs a required `validation.gates` entry through the dashboard-owned compact
executor. The dashboard supplies this command with the correct job and port.
It returns a nonzero exit code for failed, cancelled, timed-out, or stale
validation. It does not accept arbitrary commands or an arbitrary repository.
The repository must be the checkout selected when starting that dashboard.
For an isolated checkout, onboard it and start its dashboard before the job;
an agent-created sibling cannot substitute evidence for the assigned source.

Configure each gate in the repository profile:

```json
{
  "validation": {
    "gates": [
      {
        "id": "frontend-typecheck",
        "command": "npm",
        "args": ["run", "type-check"],
        "workingDirectory": "frontend",
        "timeoutSeconds": 300
      }
    ]
  }
}
```

Use focused, repository-owned commands and finite timeouts. By default every configured
gate is required; agent markers and ordinary `fixlab exec` runs cannot replace
its evidence. A profile may explicitly set `reuse: true` on eligible
deterministic local gates; reuse is off by default and must never be enabled
for live/browser checks or mutations. Source edits require revalidation.
Legacy profiles without gates
remain runnable but cannot establish executor-backed PR readiness. These
checks do not intercept all agent tools or enforce external PR permissions.

### API-only validation

To avoid running unrelated frontend checks for internal API changes, add an
opt-in policy alongside the existing `validation.gates`:

```json
{
  "apiOnly": {
    "baseRef": "origin/main",
    "paths": ["backend/src", "backend/tests"],
    "fullValidationPaths": ["backend/src/Contracts", "backend/src/Controllers"],
    "gateIds": ["backend-build", "backend-tests"]
  }
}
```

This object belongs at `validation.apiOnly`. Adapt every path, the target
reference, and gate ID to the repository. All listed gates must already exist.
Paths are literal repository-relative files or directory prefixes, not globs;
include every API contract or consumer-impacting surface in
`fullValidationPaths`. A path policy cannot prove semantic compatibility.
Request full validation whenever public behavior or frontend impact is uncertain.
Keep the policy absent until it has been reviewed; the template does not
automatically enable exclusions.

New jobs use `validationIntent: "affected"` by default only when this policy
exists. The dashboard's **Validation coverage** selector can explicitly choose
change-aware checks or **All configured checks**. API/MCP callers can select
`"affected"`, `"full"`, or `"scoped"` at job creation or on an authorized resume.
`"full"` always requires all configured gates; `"scoped"` still defers readiness.
Explicit all-UI or manual localhost requests also retain full coverage.

Change-aware validation compares committed changes, index changes, worktree
changes, deletions, both sides of renames, and new non-ignored files against a
pinned Git baseline. Shared checkout jobs use their assigned base commit;
other jobs pin the merge base with `baseRef`. Saved jobs retain that baseline.
Empty, unclassifiable, contract, shared, frontend, or unreadable change sets
require all configured gates. Older saved jobs without a verified baseline
cannot acquire API-only scope on resume.
This also applies when recovery starts a fresh runtime instead of reusing its
old session. Executed-gate history survives dashboard restarts: failed and
cancelled gates stay required, while saved passes become stale and must run
again. Missing legacy history retains full coverage; invalid history requires
a new reviewed job.

For a verified API-only change, `gate` reports excluded entries as
**NOT APPLICABLE**, without executing their commands or creating pass evidence.
The dashboard and conversation status show their reasons and label completion
**API-scope validation passed**, not full validation. Previously executed failures
are never rewritten as exclusions. Later edits can expand required coverage,
and final source verification still invalidates stale results.

Changing a policy requires a new reviewed job. Installing this feature does
not waive failures, change profiles, or upgrade a running dashboard in place.

## Reviewed component validation and permission preflight

### Component validation

For changes beyond the API-only case, a repository can instead configure
`validation.changeAware`. Do not combine it with `validation.apiOnly`.

```json
{
  "changeAware": {
    "baseRef": "origin/main",
    "fullValidationPaths": ["shared", "backend/Contracts", "package.json"],
    "scopes": [
      {
        "paths": ["backend/src", "backend/tests"],
        "gateIds": ["backend-build", "backend-tests"]
      },
      {
        "paths": ["web/src", "web/e2e"],
        "gateIds": ["web-types", "web-tests", "web-build", "web-browser"]
      }
    ]
  }
}
```

Every gate ID must already exist in `validation.gates`. A path can match more
than one scope: the union of all matching gate sets is required. Include shared
mandatory checks in each applicable gate set. Policies support 1-100 scopes,
each with 1-100 literal path prefixes, and require full-validation paths.
This policy uses the same pinned baseline, complete Git change discovery,
recovery safeguards, evidence invalidation and explicit full/scoped behavior
as API-only validation. Unknown paths, an empty change set or any matching
full-validation path require all gates. Previously executed gates remain
required, including failures. Exclusions mean **not applicable**, never passed.

The dashboard defaults a new policy-enabled job to affected validation.
Component-scope completion is labelled separately from full validation; it is
not permission to omit repository-mandated browser, build, or other checks.
Do not enable the policy in a consuming repository until its mapping has been
reviewed.

### Pre-launch permission handoff

Select **Review required external-folder access before starting the executor**
or pass `permissionPreflight: true` to the existing job-start API/control.
The job pauses before any executor launch, workspace acquisition, or frontend
warmup. Review an exact required folder, then separately confirm its resolved
scope through the existing job/request-bound approval flow. Review is not
approval. The first launch is fresh, not a resume of a nonexistent session.
The normal folder restrictions, nonce/origin checks and job-local grant expiry
still apply; restarts do not inherit authorization.

Dashboard recovery remembers that preflight completed so an existing runtime
session resumes with the new user instruction rather than restarting its
initial request. Folder grants are still cleared. Restarting as a new job ID
resets preflight and requires fresh approval. If the first approved launch is
blocked by workspace admission, the job keeps its already approved folder and
exposes a separate workspace review. Explicit workspace approval preserves
the reviewed work and starts the first runtime session fresh.

This is opt-in and does not preapprove a tool, URL, authentication step, or
organization-policy restriction. It cannot eliminate all noninteractive
permission denials. Status reports grants already present so an unclassified
denial does not trigger repeated grants or speculative widening.

## Visual Studio Code bugfix agent

`fixlab init` also installs `.github/agents/fixlab-autofix.agent.md`. Open the
onboarded repository in Visual Studio Code, open Copilot Chat, select
`fixlab-autofix` from the agent picker, and provide one bug description. You
can also run `/fixlab.bugfix` to start the same focused workflow.

The agent provides a reusable bugfix workflow: it reads the target
repository's profile instead of hard-coding product components. It classifies the
smallest allowed component, reproduces the defect, traces React or .NET data
flow, makes a surgical fix, adds focused regression coverage, runs configured
validation, and reports evidence for developer review.

## MCP server

FixLab ships a repository-local stdio MCP server:

```shell
fixlab-mcp
```

The `.vscode/mcp.json` configuration starts it over standard input/output. It
exposes read-only tools to summarize FixLab profile readiness and discover
repository validation commands. These tools do not execute commands or make
network requests.

`fixlab_dashboard_status` and `fixlab_dashboard_reply` additionally connect an
existing conversation to a running loopback dashboard using an explicit
repository and port. Status returns a compact question and gate summary,
without raw logs. Reply requires the user's explicit answer and matching
instance/job IDs, and may queue a comment or resume that same job. It does not
start a replacement job or grant runtime permissions. The dashboard retains
execution, process ownership and validation authority. See
[Copilot dashboard chat setup](installation.md#chat-with-an-existing-dashboard-from-copilot).

### Copilot dashboard control

`fixlab_dashboard_control` accepts `repository`, loopback `port`, current
`instanceId`, current `jobId` (or `null` when none), `operation` and a
`parameters` object containing the normal dashboard API payload.
Mutations require `confirmed: true` representing actual user authorization.
Read status again after a conflict or timeout; do not blindly replay an
operation that may already have started.

| Operations | Parameters / behavior |
|---|---|
| `sessions`, `onboarding-status`, `frontend-status`, `authentication-status` | `{}`; reads existing configuration/session status |
| `metrics` | Optional `period`; reads aggregate metrics |
| `job-start` | `request`, `mode`, optional `targetEnvironment`, model and existing job options; creates/queues a job |
| `job-stop`, `job-dismiss` | `{}`; acts on the bound current job |
| `job-hold`, `job-resume`, `job-restart`, `queue-cancel` | `jobId` identifies the existing current/held/queued job; restart explicitly creates a new job, unlike recovery reply |
| `history-purge` | Existing dashboard purge payload and confirmation; never removes code or untracked source |
| `frontend-start`, `frontend-stop` | `{}`; uses profile settings and tracked process ownership |
| `authentication-start` | `{}`; opens configured human sign-in, never supplies credentials or completes MFA |
| `session-control` | `ownerId`, `jobId`, `action`, `resource`, and `confirmed` where required by normal session controls |
| `permission-review` | `jobId`, `requestId`, `directory`; reviews the exact existing folder request |
| `permission-approve` | Reviewed `jobId`, fresh `requestId`, exact `directory`, `confirmed: true`; never grants tools or URLs |
| `validation-run` | `jobId`, `gateId`, `repository`; runs only a configured required gate on the assigned checkout |
| `onboarding-configure` | Existing Azure DevOps organization/project settings; preserves onboarding validation |
| `work-items-load` | Existing Azure DevOps intake selection; preserves authenticated read-only loading |

Control uses an explicit route allow-list, not arbitrary URLs or shell
commands. The server checks instance/repository/job identity before dispatch
and again after reading a request body. Responses contain only bounded
operational metadata, not raw logs, credentials, screenshots or browser-state
files; full evidence remains in the dashboard. A start/stop acceptance is not
proof that a test passed. Ordinary operations have a ten-second deadline;
configured validation gates retain the bounded gate execution deadline.

For example, after status verifies the correct PR checkout, start browser-only
testing with `operation: "job-start"` and:

```json
{
  "request": "Test this PR using the configured Playwright settings; do not change code.",
  "mode": "playwright-only",
  "targetEnvironment": "dev"
}
```

Use only an environment allowed by that repository's profile. An already
running or blocked job can cause this request to queue; inspect the returned
job/queue state rather than assuming immediate execution.

## Change-only Copilot notifications

```text
fixlab notifications [repository] [--yes]
```

Plan the installation first, then use `--yes` to add a project-local Copilot
extension loader referencing this installation. Existing custom code is never
overwritten. Reload extensions and explicitly start one job-bound monitor
using `fixlab_watch_start`; installation alone starts nothing.

| Extension tool | Behavior |
| --- | --- |
| `fixlab_watch_start` | Requires repository, port, instance/job IDs and explicit `confirmed: true` consent to event-triggered model turns |
| `fixlab_watch_status` | Refreshes compact state for that same watched identity |
| `fixlab_watch_stop` | Stops notifications, not the dashboard job |

Unchanged status checks make no model calls. Only new blockers, completion or
watch termination enqueue Copilot turns, which still consume tokens. No event
approves an action or passes a validation gate. See
[installation and lifecycle limits](installation.md#change-only-copilot-notifications).

## Local dashboard command

```text
fixlab dashboard [repository] [--port <number>] [--open|--no-open] [--keep-awake-minutes <minutes>]
```

The command starts the packaged local UI on `127.0.0.1:4317` by default without
opening the browser. Open the printed URL manually, request `open dashboard`
in chat, or explicitly supply `--open`. `--no-open` remains supported.
Onboarding and reconnecting do not automatically open browser tabs.
The dashboard does not run during installation or `fixlab init`.

### Background runtime permissions

A background Copilot job cannot show an interactive terminal permission prompt.
When it reports a non-interactive permission denial, FixLab stops the owned
executor and shows **Copilot permission required** in the browser. Do not use
ordinary Resume or PR approval to grant runtime access.

Inspect the raw logs first. If a specific external folder is needed, enter its
absolute path, select **Review folder access**, verify the resolved folder and
read/write scope, then select **Grant this folder and resume** and confirm.
This adds only that folder and its descendants to this job's runtime access.
It can also load trusted agent configuration from that folder. It does not
approve tools, URLs, credentials, production operations, or organization-policy
exceptions. The grant expires when the dashboard restarts and is never copied
to a new job.

If the denial's scope is unclear, leave the job paused. The runtime's text output
does not identify structured permission scopes, and a folder grant cannot fix
every permission denial. Another denial pauses the job again without repeated
automatic retries; a separate terminal is not needed for this folder review.
After owned termination is verified, **Dismiss blocked job and continue queue**
also remains available without granting permissions or enabling ordinary Resume.
If an already approved folder target changes, its grants are cleared and a new
permission review is required; a failed restart cannot restore the stale grants.
The UI starts one selected-runtime job at a time
and displays the intake, diagnosis, reproduce, fix, review, local-stack,
live-test, and pull-request stages with polled logs.

Use `--keep-awake-minutes` to prevent system sleep temporarily while the
dashboard is running:

```text
fixlab dashboard C:\source\application --keep-awake-minutes 180
```

For a standalone timer without starting the dashboard:

```text
fixlab keep-awake --minutes 180
```

The timer releases automatically when its duration ends or its FixLab process
stops. It does not change permanent power-plan settings or unlock the desktop;
interactive browser and authentication steps may still require an unlocked
screen.

The user supplies only the bug or required enhancement. The agent loads
validation context from the repository profile and autonomously owns contract
generation, diagnosis or affected-surface inspection, the smallest required
change, effective-diff review, focused local validation, profile-defined
application startup and live testing, evidence, and the gated pull-request
outcome. It never hardcodes environment choices. Human interaction is reserved
for authentication, unsafe-data approval, deployment or pull-request approval,
and genuine blockers.

Attach an interactive terminal to the active dashboard job with:

```text
fixlab chat [repository] [--port <number>] [--runtime <agency|copilot>]
```

Free text is sent to the same runtime session. `/status`, `/logs`,
`/evidence`, and `/pr` inspect the current job; `/retry`, `/continue`, and
`/skip` resume it with explicit guidance; `/stop` terminates only the
FixLab-owned executor and leaves the job resumable; `/exit` closes the shell
without stopping the job. Streamed activity redraws the `fixlab>` input line
instead of overwriting partially typed text. While the input line contains
text, background activity is buffered and displayed only after the line is
submitted, preventing typed fragments from becoming duplicate comments.

If no dashboard is listening, chat uses the current directory when it contains
a ready FixLab profile. Otherwise it asks for the local repository path and
opens the interactive onboarding agent. It initializes a missing profile,
requires onboarding to finish with a ready profile, starts the loopback
dashboard in the background, and connects automatically. The optional
repository argument supports non-interactive path selection.

When a dashboard is already listening, interactive chat displays its
repository before attaching. Press Enter to keep it or enter another local
repository path. FixLab starts the alternate repository on the next available
loopback port and connects to that dashboard instead.

Common operations do not require slash syntax. Natural phrases such as
`start dashboard`, `show status`, `show logs 50`, `show pull request`,
`show evidence`, and `switch repository to C:\source\application` execute
immediately. Other free text remains guidance for the active FixLab agent and
is queued after its current turn when the job is already running.

Create a separate bug job without opening the browser:

```text
new bug Product search returns duplicate rows
add a bug: Save remains disabled after validation succeeds
```

The new bug starts immediately when FixLab is idle or enters the dashboard
queue when another job is active. Use ordinary free text without the
`new bug` prefix when the instruction belongs to the current job.

Remove a waiting job without interrupting the active job:

```text
cancel waiting job 2
remove job 253ef92a-7bdf-47bd-b944-cdb0e6297580 from the queue
/cancel-job 2
```

The removed job remains visible as cancelled in dashboard history. FixLab
deletes its queued screenshot artifacts and renumbers the remaining jobs.

Manual entry is the default intake path. The dashboard can also load a full
Azure DevOps work-item URL or use a numeric ID with this optional profile
section:

```json
{
  "azureDevOps": {
    "organization": "your-organization",
    "project": "your-project"
  }
}
```

Azure DevOps loading uses the local developer's authenticated Azure CLI
identity and never exposes or stores the bearer token. It loads safe work-item
text and metadata without downloading private attachments. Both intake paths
can add up to five validated PNG/JPEG/WebP screenshots (2 MiB each, 8 MiB
total). Generated files remain outside tracked source, are sent to the agent
only as local paths, and are excluded from the durable metadata cache.

Within one job/session, the prompt requires profile/instruction-first reading,
git status and effective-diff inspection, task-relevant symbol searches, and
focused risk-scaled validation. It avoids unchanged-file rereads, repeated
diagnosis, dependency reinstalls, and unjustified broad checks. Stage summaries
are concise and the dashboard raw-log view is bounded. Git repositories use a
metadata-only cache under `.git/fixlab`, keyed by repository identity, `HEAD`,
worktree inputs, profile hash, and discovered instruction hashes. It reuses
only profile shape, prior result, fixed stage/status summaries, and gate
statuses, with 20-entry, 64-KiB, and seven-day limits. It retains no
agent-authored messages or source contents and cannot pass a gate. Current
instructions are reread; recurring lessons require review before promotion.
Non-Git repositories skip durable reuse.
