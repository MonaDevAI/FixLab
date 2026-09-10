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

## Process isolation

- Use one worktree per job.
- Record every process identifier started by the runner.
- Stop only verified descendants of the job's runner process.
- Never terminate a process by name or broad wildcard.
- Use fixed, documented local ports and report conflicts safely.

## Data handling

- Use synthetic or approved non-production test data.
- Avoid production unless a separately governed workflow explicitly allows it.
- Sanitize screenshots and API evidence.
- Apply retention limits to logs, screenshots, and temporary worktrees.

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

