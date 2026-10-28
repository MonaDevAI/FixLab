# Getting started

This guide covers the first job and day-to-day operation. Use
[Installation](installation.md) for tool setup and
[Repository onboarding](repository-onboarding.md) for profile configuration.

## Prerequisites

Complete the [installation prerequisites](installation.md#prerequisites),
configure the application's `.github/fixlab/repository-profile.json`, and
resolve the required readiness checks. Install only what that profile needs.
The CLI, optional plugin/MCP connection, browser setup, and application
authentication are separate.

## Simplified chat-first workflow

With FixLab and the selected runtime installed:

```powershell
fixlab chat C:\source\application --runtime copilot
```

Use `--runtime agency` for Agency. Omitting the path lets chat use the current
ready repository or ask for one. An incomplete repository opens guided
onboarding before the dashboard starts.

Review the connected repository before submitting a request. Terminal chat
and the browser dashboard share the job, runtime session, branch, evidence,
and pull-request state. Closing terminal chat does not stop the job.
Open the printed loopback dashboard URL, request `open dashboard`, or opt in
with `fixlab dashboard --open`; onboarding does not automatically open a tab.

On the dashboard, enter the request and select **Start job**. **Run options**
contains mode, environment, and evidence settings. The sidebar exposes saved
work, connections, settings, and run details. On small screens, select **Menu**;
**Back to chat** restores the unsent draft without starting work.

Keep the request about behavior and expected results, not profile-owned paths
and commands. For example:

```text
The search results contain duplicate rows after filtering.
Reproduce the issue, make the smallest fix, run the configured affected tests
and browser journey, capture non-sensitive evidence, and create a draft PR.
```

For an API-only repository:

```text
The create-request API returns the wrong status for invalid input.
Reproduce it with a focused API test, make the smallest fix, and verify the
HTTP behavior using this repository's configured validation policy.
```

## Onboard a repository

Use the [guided installation](installation.md#recommended-path-install-then-run)
or request an explicit setup plan:

```powershell
fixlab onboard C:\source\application --runtime copilot
```

Review the profile, real component directories, test/startup commands, allowed
environments, authentication, and pull-request settings before approving setup.
`fixlab init` preserves existing files; it does not make example paths correct
for an application. Run `fixlab doctor --runtime copilot` after configuration.

See the [onboarding reference](repository-onboarding.md) for new worktrees,
shared-checkout policy, API-only validation, and linked repositories. Linked
applications keep their own profiles, ownership, changes, and pull requests;
opening a linked workspace is not end-to-end integration evidence.

## Choose an intake path

**Enter manually** is the default. Describe a bug or choose **Small enhancement**
for bounded new behavior. Add screenshots only when they help explain it.
Up to five PNG, JPEG, or WebP images are allowed: 2 MiB each and 8 MiB total.
File selection, pasted images, and Azure DevOps images share these limits.

For Azure DevOps intake, enter up to 20 unique work-item IDs or URLs:

```text
https://dev.azure.com/your-organization/your-project/_workitems/edit/123
456
```

ID-only intake requires the profile's `azureDevOps.organization` and
`azureDevOps.project`. Sign in with `az login` using an authorized identity.
FixLab loads supported fields, recent comments, and bounded images; loading
items does not update their status or expand a Feature into its children.
See [intake contracts](architecture.md#intake-sources) for limits and retention.

## Recommended first workflow

Start with an existing change or PR in **Validate only** mode:

```text
Validate pull request 123 against its actual source commit using this
repository's required checks. Do not edit source, commit, push, or update the PR.
Report the evidence and every failed, blocked, skipped, or pending check.
```

Verify the checkout and required authentication, run the relevant configured
checks, and inspect the resulting evidence before enabling fix-and-validate.

| Mode | Use it for |
| --- | --- |
| Fix and validate | A scoped bug fix or small enhancement, with publication only when authorized |
| Validate only | Existing changes or PRs, without edits or publication |
| Playwright validation only | A focused browser/API result check without implementation or PR work |

Efficient delivery defaults to an authorized draft PR after focused regression
checks, diff review, and required pre-publication gates. Optional broad
tests/builds follow saved preferences. Strict delivery and explicitly required
checks retain their requirements. A draft PR, successful startup, or HTTP 200
is not proof that all validation passed.

### Review evidence and approvals

Inspect stages, configured gate results, scenario assertions, screenshots or
API proof, and any PR link. Synthetic/intercepted browser checks must be labeled;
they do not prove the real backend works. Temporary generated browser tests
are removed before publication unless permanent coverage is explicitly required.

Keep credentials and MFA in the normal authentication flow, not chat.
**Connect Playwright** runs the configured sign-in command; **Check status**
does not expose browser-state contents. If the persistent test browser is busy,
preserve unsaved work and close it yourself before retrying. Do not kill another
browser or copy its authentication state.

Runtime permissions and workflow approvals are distinct. Review the actual
command, path, or diff. An **Action needed** response is not a blanket grant,
and a workflow reply cannot approve an unrelated native permission request.
See [runtime permissions](commands.md#background-runtime-permissions).

Local jobs can warm the configured React frontend alongside diagnosis. Reuse
it only when it is healthy and serves the checkout being validated; a warm
baseline server does not validate an isolated fix. Startup is not a passed
live-test gate.

### Queue and recover work

| Action | Behavior |
| --- | --- |
| `new bug <details>` | Create a separate job; queue it when another job is active |
| Add comment to current job | Retain guidance for the same session and existing PR |
| Remove from queue | Cancel a waiting job without interrupting the executor |
| Hold / resume | Retain job context and release/resume execution through owned lifecycle controls |
| Restart | Create a new job/session while retaining the original result |
| `show status`, `show logs`, `show evidence`, `show pull request` | Inspect the connected job from terminal chat |
| `switch repository` | Select another repository without silently reassigning the current job |

There is one active executor and at most 20 pending jobs. Blocked or failed
jobs pause queue advancement; resolve the blocker, resume the same job, or
explicitly dismiss the failed job. History cleanup excludes active, waiting,
and held jobs.

For an interrupted task, ask:

```text
Continue the same job. Preserve the branch, changes, existing PR, and completed
evidence. Explain the current blocker and finish only the remaining required work.
```

Use session controls to reconnect to a verified owner. Stop/shutdown affects
only that owner's tracked processes. An unreachable dashboard or stale-looking
PID is not permission to clear an executor lease or take over another session.

For multiple bugs, the default is one combined PR; select separate PRs when
isolation is required. Optional manual localhost validation keeps the owned
frontend available until you record Passed or Failed. It remains separate from
Playwright evidence.

## Environment policy

Prefer local validation and select only profile-approved environments. Never
silently fall back to another environment or select production automatically.
Keep environment addresses, credentials, and sensitive test data out of public
documentation.

Use approved test data and intercept mutations where required. A synthetic
fallback must state what it could not verify. Missing authentication, unsafe
data access, or unavailable required validation remains a blocker.

For operational details, use the [command reference](commands.md),
[architecture reference](architecture.md), and [troubleshooting guide](troubleshooting.md).
