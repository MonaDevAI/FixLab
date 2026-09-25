# FixLab commands

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
fixlab dashboard [repository] [--port <number>] [--no-open]
fixlab dashboard [repository] --stop
```

The command starts the packaged local UI on `127.0.0.1:4317` by default and
opens the system browser unless `--no-open` is supplied. It does not run during
installation or `fixlab init`. The UI starts one selected-runtime job at a time
and displays the intake, diagnosis, reproduce, fix, review, local-stack,
live-test, and pull-request stages with polled logs.

Use `fixlab dashboard [repository] --stop` from another terminal to request a
graceful shutdown. FixLab stores an instance-specific local control token and
will stop only the dashboard that created that record; it does not terminate
unrelated Node.js processes.

The user supplies only the bug or required enhancement. The agent loads
validation context from the repository profile and autonomously owns contract
generation, diagnosis or affected-surface inspection, the smallest required
change, effective-diff review, focused local validation, profile-defined
application startup and live testing, evidence, and the gated pull-request
outcome. It never hardcodes environment choices. Human interaction is reserved
for authentication, unsafe-data approval, deployment or pull-request approval,
and genuine blockers.

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
