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
- The dashboard accepts one job at a time and executes Agency with the selected
  repository as its working directory.
- Validate-only dashboard jobs prohibit edits, commits, pushes, and pull
  request creation or updates.
- Use one worktree per job.
- Record every process identifier started by the runner.
- Stop only verified descendants of the job's runner process.
- Never terminate a process by name or broad wildcard.
- Use documented local ports and report conflicts safely. The dashboard
  defaults to port 4317 but accepts an explicit alternate port.

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
