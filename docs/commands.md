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

The first run detects bounded repository metadata: React package location,
package manager and scripts, exact Node.js version, ASP.NET project location,
Playwright command, startup port, and default branch. FixLab writes those
values to the initial repository profile and reports anything it could not
resolve. It never overwrites an existing profile.

When discovery produces usable paths, onboarding immediately prints the
repository-owned restore and Playwright plans. In an interactive terminal it
offers to run those commands and, after Doctor passes, to start the dashboard.
Non-interactive runs remain plan-first. `--yes` approves setup explicitly,
`--authenticate` runs the repository-owned browser login, and
`--start-dashboard` starts the dashboard only after Doctor passes.

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

FixLab ships a repository-local, read-only MCP server:

```shell
fixlab-mcp
```

The `.vscode/mcp.json` configuration starts it over standard input/output. It
exposes tools to summarize FixLab profile readiness and discover repository
validation commands. The server does not execute validation, modify files,
read credentials, or make network requests.

## Local dashboard command

```text
fixlab dashboard [repository] [--port <number>] [--no-open] [--keep-awake-minutes <minutes>]
```

The command starts the packaged local UI on `127.0.0.1:4317` by default and
opens the system browser unless `--no-open` is supplied. It does not run during
installation or `fixlab init`. The UI starts one selected-runtime job at a time
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
and profile hash. It reuses only sanitized profile shape, prior result, and
stage summaries, with 20-entry and 64-KiB limits. It is not a repository scan
or source cache. `HEAD` or profile changes miss automatically, instruction
changes require rereading, and non-Git repositories skip durable reuse.
