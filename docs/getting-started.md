# Getting started

Complete the [installation guide](installation.md) before onboarding a
repository.

## Prerequisites

A FixLab runner typically needs:

- Agency Copilot
- Git
- Node.js
- PowerShell 7
- The .NET SDK selected by the repository's `global.json`, when present
- Microsoft Edge or another approved Playwright browser
- Repository access
- Access to the selected non-production validation environment

Install only the tools required by the repository profile.

## Onboard a repository

1. Run `fixlab init` to create
   `.github/fixlab/repository-profile.json` and the FixLab prompt commands
   under `.github/prompts`.
2. Declare the frontend and backend paths.
3. Add deterministic restore, test, lint, build, and startup commands.
4. Define safe validation environments.
5. Add browser journeys that use non-sensitive test data.
6. Document the repository's process ownership and cleanup rules.
7. Validate the profile before enabling pull request creation.

Review the repository-owned restore commands, then prepare the fresh checkout:

```powershell
fixlab prepare
fixlab prepare --yes
```

The first command prints the frontend and backend restore plan without making
changes. The approved command runs only `frontendRestore` and `backendRestore`
from the repository profile in their configured application directories.

Run `fixlab doctor` after preparation.

Start the local dashboard explicitly:

```powershell
fixlab dashboard
```

Installation and `fixlab init` do not start it automatically. The dashboard
shows profile readiness, accepts `bug-fix` or `small-enhancement` requests, and
offers fix-and-validate and validate-only modes. Bug fix is the default request
type. Start with validate-only when
onboarding a repository; that mode prohibits edits, commits, pushes, and pull
request changes.

The Azure DevOps input accepts up to 20 comma-, space-, or newline-separated
IDs or URLs. FixLab authenticates once, loads the unique bugs concurrently,
shows the selected list before submission, and creates one bounded request
with a result row for every bug. Outcomes distinguish repository fixes from
already-fixed, expected, duplicate, no-change, blocked, and external causes.
An external MDG result is highlighted with MDG as the owner. FixLab creates a
combined pull request only when at least one proven repository code change is
needed; it does not create an empty pull request for external-only outcomes.
While a job is running, the submit action changes to **Add to queue**. Up to 20
pending jobs are shown by position. A passed job starts the next automatically;
a blocked or failed job pauses the queue so its action-needed state remains
available for same-session resume.

The request field should contain only the bug or required enhancement. Do not
copy profile-owned paths, commands, ports, systems, or environment choices into
the request. FixLab reads that validation context from
`.github/fixlab/repository-profile.json`.

## Choose an intake path

**Enter manually** is selected by default and is always available. Type the bug
or required enhancement and optionally select screenshots.

To load Azure DevOps fields, paste one or more IDs or full URLs such as:

```text
https://dev.azure.com/your-organization/your-project/_workitems/edit/123
456
```

For ID-only entry, add optional repository-owned context:

```json
{
  "azureDevOps": {
    "organization": "your-organization",
    "project": "your-project"
  }
}
```

FixLab uses the developer's current Azure CLI authentication. Run `az login`
with access to the organization when loading fails because authentication is
unavailable. The access token is used only by the local HTTPS request and is
not shown or retained. FixLab loads the newest 20 non-deleted comments along
with the work-item text fields. If comment access alone fails, the selected bug
shows an explicit comments warning and remains available. Comment attachments
and other private work-item attachments are never downloaded automatically.

Up to five PNG, JPEG, or WebP screenshots may be attached, with limits of
2 MiB per file and 8 MiB total. Select files or click the main bug/request
textarea and press `Ctrl+V` after copying an image; a local thumbnail confirms
the paste. Images are stored locally with generated names outside tracked
source, passed to the agent by local path, and excluded from durable metadata
and metrics. Clean shutdown and job replacement remove them; directories older
than seven days are pruned when the dashboard starts.

After submission, the agent owns the complete lifecycle: acceptance or fix
contract, diagnosis or affected-surface inspection, smallest required
implementation, effective-diff self-review, focused tests/type-check/build,
profile-defined application startup, repository-defined live testing against
the allowed required system or environment, evidence collection, and the
pull-request outcome. A pull request is created or updated only after required
gates pass.

Routine engineering steps require no human direction. Interaction is limited
to authentication, unsafe-data approval, deployment or pull-request approval,
or a genuine blocker. Environment choices are never hardcoded by the
dashboard; the repository profile controls them.

When a stage is blocked, the dashboard displays an **Action needed** panel.
Enter the missing prerequisite, safe test record, approval, or manual result
and resume. Failed jobs can be retried with corrected details, and completed
jobs can accept one focused addition and update the existing pull request.
FixLab resumes the same Agency session rather than starting diagnosis again.
A controlled skip remains visibly recorded as an unverified risk.

For efficient repeat work in the same repository, FixLab reads the profile and
instructions first, checks git status and the effective diff, and searches only
task-relevant symbols and files. It reuses the current job/session context and
does not reread unchanged files, repeat completed diagnosis, reinstall
available dependencies, or rerun broad checks unless new evidence requires it.
Focused searches, focused tests, and risk-scaled validation are the default.

The dashboard keeps concise stage summaries and a bounded local raw-log window.
For Git repositories it also stores a small metadata-only cache in
`.git\fixlab\dashboard-cache.json`, keyed by repository identity, `HEAD`, and
profile-content hash. A matching later job can reuse sanitized profile shape,
prior result, and stage summaries. Request text, raw logs, credentials,
screenshots, and source contents are excluded, and the cache is limited to 20
entries and 64 KiB.

Workflow statistics are retained for the last 500 jobs in
`.git\fixlab\dashboard-metrics.json` and can be filtered to 24 hours, 7 days,
30 days, or all retained records. The cards show bugs queued, completed jobs,
average execution time, and token totals when Copilot emits an exact terminal
usage summary. Cache reuse is calculated as cached input divided by total
input. It is not an exact token-reduction or cost-savings percentage without a
comparable baseline. The metrics file excludes request text, comments,
screenshots, credentials, raw logs, and source contents.

`HEAD` or profile changes cause an automatic miss; instruction changes require
the instructions to be reread. Non-Git repositories skip durable reuse. The
cache is not a repository scan or source index, so the current diff and
task-relevant files remain authoritative.

Small enhancements follow a risk-scaled fast path. FixLab first records a
concise acceptance contract, checks the affected surface, bounds the file
scope, and uses the smallest existing focused test instead of inventing a
failing defect reproduction. It skips broad suites and full builds unless the
repository profile or user-visible/risk evidence requires them. This differs
from a general coding agent because review, live-test, pull-request, and
skipped-stage evidence remain mandatory, and unrelated changes remain
prohibited.

The installed prompt files provide the staged workflow:

```text
/fixlab.intake
/fixlab.diagnose
/fixlab.reproduce
/fixlab.fix
/fixlab.validate
/fixlab.live-test
/fixlab.pr
```

See [FixLab commands](commands.md) for the purpose and completion gate of each
stage.

Start with the template in
[`templates/repository-profile.json`](../templates/repository-profile.json).

## Recommended first workflow

Use validation-only mode for an existing pull request:

1. Resolve the pull request source and target commits.
2. Create an isolated worktree.
3. Inspect the effective diff.
4. Run focused tests selected from changed files.
5. Run type checking and changed-file linting.
6. Start only the applications required for the changed area.
7. Execute the smallest browser journey that verifies the behavior.
8. Capture logs, API assertions, and screenshots.
9. Publish the result without modifying the pull request.

After the team trusts validation-only runs, enable fix-and-validate mode with
review and pull request controls.

## Environment policy

- Prefer local validation when dependencies can run safely.
- Use a designated development environment for external integrations.
- Use a designated integration environment only when development data is
  insufficient.
- Never select production automatically.
- Keep environment URLs, client identifiers, and credentials outside this
  documentation repository.
