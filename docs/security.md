# Security model

FixLab can execute source-control, build, test, browser, and pull request
operations. Treat every runner as privileged engineering infrastructure.

## Identity and authorization

- Authenticate users with the organization's identity provider.
- Authorize by repository, environment, operation, and runner.
- Separate permission to validate from permission to modify code.
- Require explicit permission for pull request creation and deployment.
- Use short-lived credentials and workload identities where possible.

## Secrets

- Never store secrets in repository profiles, prompts, screenshots, or logs.
- Retrieve secrets at runtime from an approved secret store.
- Redact authorization headers, cookies, tokens, and connection strings.
- Keep browser profiles and authentication state outside Git.
- Azure DevOps intake uses the locally authenticated Azure CLI identity. The
  resource token exists only during the outbound HTTPS request and is excluded
  from browser responses, errors, logs, job state, prompts, and caches.
- Work-item response bodies are not included in authentication errors, and
  private Azure DevOps attachments are not downloaded automatically.

## Process isolation

- The reusable dashboard binds only to `127.0.0.1`; it is not a team service or
  public network endpoint.
- Installation never starts a listener. `fixlab dashboard` is an explicit,
  foreground local command.
- The dashboard accepts one job at a time and executes the selected runtime with the
  repository as its working directory.
- Validate-only dashboard jobs prohibit edits, commits, pushes, and pull
  request creation or updates.
- Use one worktree per job.
- Record every process identifier started by the runner.
- Stop only verified descendants of the job's runner process.
- Never terminate a process by name or broad wildcard.
- Use documented local ports and report conflicts safely. The dashboard
  defaults to port 4317 but accepts an explicit alternate port.
- The CI failure-containment workflow runs from `workflow_run` with no source
  checkout and never executes pull-request code with its write-capable token.
  It may preserve artifacts and post a fixed diagnostic link only.
- The separate rollback workflow is limited to failed `push` runs on `main`.
  It checks out the trusted default branch, creates a single `git revert`
  commit on a new branch, and opens a pull request. It never runs the failed
  source, pushes to `main`, or bypasses required review and status checks.
- Scheduled learned-rule review grants Copilot request and read-only contents
  permissions. The direct review disables shell, write, and built-in MCP tools;
  its response is retained as an artifact and cannot modify the repository.

## Data handling

- Use synthetic or approved non-production test data.
- Avoid production unless a separately governed workflow explicitly allows it.
- Sanitize screenshots and API evidence.
- Apply retention limits to logs, screenshots, and temporary worktrees.
- Dashboard screenshots are restricted to five PNG/JPEG/WebP files, 2 MiB each
  and 8 MiB total. Names, extensions, MIME types, base64, and file signatures
  are validated before generated files are written outside tracked source.
- Screenshot artifacts are removed when replaced or on clean shutdown.
  Directories older than seven days are pruned at startup; an abrupt process
  termination may retain files until the next pruning pass.
- The local dashboard's Git cache stores only bounded profile shape, result
  metadata, and sanitized stage summaries under `.git\fixlab`. It excludes
  request text, raw logs, credentials, screenshots, screenshot paths, and
  source contents.
- Cache reuse is keyed by repository identity, `HEAD`, and profile-content
  hash. Current diffs and repository instructions remain authoritative.
- Structured command evidence is written under the repository's Git-private
  `fixlab/command-evidence` path. Credential-like values and credential-bearing
  URLs are redacted before stdout, stderr, summaries, or metadata are written.
- Each structured stdout/stderr stream is capped at 50 MiB. Evidence and
  successful-result cache records are retained for at most seven days and 100
  entries. Failed commands are never reusable.
- Structured-result reuse is opt-in and limited to deterministic local
  validation. Its fingerprint includes command, arguments, stage, working
  directory, platform, Git `HEAD`, tracked/untracked content and status, and
  profile content. Startup, authentication, network/live-browser checks, installation,
  deployment, and mutating commands are excluded.

## Supply chain

- Pin and review package dependencies.
- Scan release artifacts.
- Sign distributed binaries or packages.
- Publish checksums and release notes.
- Protect release workflows with code owners and environment approvals.

## Prompt and tool safety

- Treat issue text, repository content, and web content as untrusted input.
- Allowlist tools, paths, domains, repositories, and commands.
- Require confirmation for destructive or externally visible operations.
- Preserve an audit trail of decisions and tool execution.

## Background permission review

The dashboard's workflow and PR approvals are not runtime permission grants.
Direct Copilot jobs use the official SDK's permission and user-input callbacks.
Human responses are scoped to the current live instance, job and one-use request.
The endpoint requires the exact loopback Host and browser Origin, JSON and
explicit confirmation. It is not exposed as an agent/MCP self-approval operation.
No permanent grant is offered, and managed organization policies
are not overridden. The dashboard offers an explicit **Allow all tool commands
for this run** opt-in, off by default, and **Allow all for this run** on eligible
live Copilot permission requests. These authorize reviewable tool requests without
individual prompts for the current executor only. This is privileged execution:
commands can modify files and contact services; it is not a sandbox or a guarantee
that arbitrary shell commands are safe. Authentication, repository instructions,
read-only/data-safety restrictions, publication consent, required checks and
deployment approvals remain authoritative.

Native Allow all excludes sensitive/unsupported requests, managed human approval,
sandbox escalation, warnings, and the recognized publication-checkpoint commands.
Those requests retain their existing separate review. Questions are never answered
automatically. Choosing Allow all requires explicit confirmation and the exact
dashboard origin. It expires on executor termination, stop, hold, failure or
completion; snapshots, retries, recovered queues and restarted jobs default back
to individual approval. Fresh queued jobs retain only their explicitly selected
choice while the current dashboard stays alive.

Agency's background CLI receives `--allow-all-tools` only after this explicit
opt-in; its CLI, not the SDK bridge, mediates requests. Without opt-in, unsupported
interactive tool approvals can block a background Agency job. Use direct Copilot
for native dashboard permission review. Do not use Allow all where organization
policy prohibits broad tool authorization.

Native creation and resume enable the SDK's managed-policy
enforcement using the runtime's signed-in authentication. Before sending the
job prompt, the host checks the session's resolved policy and blocks execution
if policy is unresolved or the runtime cannot report it. Policy-loading errors
are not retried without enforcement. Credentials and policy documents are not
forwarded through the dashboard.
Sandbox bypass/permissive requests are explicitly displayed
for review. Sensitive, oversized and unsupported request details disable approval.
Passwords, tokens and MFA must stay in the normal authentication browser.
Pending prompts and answers are memory-only, are omitted from dashboard history,
and are invalidated by stop, hold, shutdown or runtime disconnect. A job retains
its executor lease while a human is answering. This local interface, like other
dashboard controls, is not an authorization boundary against another process
running as the same OS user.

Blocked native requests explain unsupported input, size limits, credential-like
text, credential paths and control characters without exposing original details.
Eligible requests offer **Deny and request safe recovery**. This sends a rejection
with fixed guidance to reuse existing reviewed tests/helpers in the same stage;
it never approves, hides or replays the rejected operation. Managed escalation
and sensitive-path requests do not offer recovery. Existing evidence and failed
checks remain authoritative; a missing safe prerequisite still blocks the stage.

### Individually confirmed non-production POST

Native Copilot dashboard jobs expose `fixlab_nonproduction_post` for DEV, SIT and
UAT. The **Allow POST requests in the selected environment** start checkbox is
selected by default for those environments, unless an explicit read-only or
intercepted mode was selected. Unchecking it defers the exact-action request
until POST is needed; it never waives later confirmation. The checkbox is a
capability preference, not business-write approval. Ordinary validation retains
its default read-only/intercepted behavior until an exact action is approved.
API-only, explicit read-only/intercepted, unit-test-only, production-backed and
other-environment contracts are unchanged.
Agency and interactive CLI sessions do not expose this tool and must block such
actions rather than substituting a shell or browser write.

Configure each environment separately under
`browserAutomation.dataSafety.post.dev`, `.sit` or `.uat`. Missing setup explicitly
blocks the action, not unrelated work. The configuration names an existing
reviewed `.mjs` `sessionHelper` exporting
`withApiToken({ scope, interactive }, callback)`, the approved API `scope`, and
1-16 `actions`. Each action binds an exact credential-free HTTPS `url` and a
`testRecord` containing a top-level payload `field` and exact approved synthetic
test-record `value`. No wildcard URLs, queries, production-named hosts or
credential-like/oversized payloads qualify. For example, inside `dataSafety`:

```json
{
  "productionAllowed": false,
  "post": {
    "dev": {
      "sessionHelper": "tools/dev-session.mjs",
      "scope": "api://example-service/access",
      "actions": [
        {
          "url": "https://api.dev.example.test/items",
          "testRecord": { "field": "name", "value": "FIXLAB_TEST_001" }
        }
      ]
    }
  }
}
```

Add separately approved `sit` and `uat` entries with their own destinations,
test records and authentication configuration; no environment inherits another's
allowlist. The profile must also declare the selected environment. Legacy
`dataSafety.devPost` and `fixlab_dev_post` remain supported for DEV. Old snapshots
do not gain POST capability automatically, and their existing approved-write
requirements are preserved.

An endpoint being labeled non-production in configuration is an operator assertion, not
proof of its deployment identity. Review the real destination and test data.
The helper must already exist and use legitimate authentication; the tool never
collects credentials or starts interactive sign-in. Credentials stay in memory.
Credential-sensitive debug logging must be disabled.
Every exact URL and complete JSON payload receives a separate human review,
including while Allow all is active. These requests are excluded from batch
approval and expire after five minutes. Profile/helper revisions are checked
again before dispatch. One approval permits one attempt: redirects are not
followed, ambiguous outcomes and failures are not retried, and repeating an
action requires fresh confirmation after inspecting its effects. Response bodies
and credentials never enter results or job history; only status metadata returns.
An HTTP success is not a passed scenario assertion. Existing arbitrary tool
execution remains privileged: this constrained helper is not an OS network
sandbox and cannot enforce the contract against an unrelated same-user process.

A reported text-only non-interactive denial pauses the owned executor without automatic
retries; approval remains unavailable until its termination is verified.

Folder review requires the exact loopback Host, a matching browser Origin when
present, JSON, the current job and request nonce, and a separate explicit
confirmation of the resolved scope. A reviewed folder becomes a job-local
`--add-dir` grant, including read/write access and trusted agent configuration.
Network/device paths, broad roots and known credential/configuration folders
are rejected, and substituted directory targets require another review.
Users must not select folders containing secrets or browser state.

Grants are not persisted or copied to restarted jobs. Tool, URL, sandbox and
organization-policy restrictions are not overridden by folder approval. Text
denials without a structured scope remain explicitly unclassified; this panel
is not a native runtime permission bridge or an
authorization boundary against other processes running as the same user.
