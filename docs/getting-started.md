# Getting started

Complete the [installation guide](installation.md) before onboarding a
repository.

## Prerequisites

A FixLab runner typically needs:

- Agency Copilot
- Git
- Node.js
- PowerShell 7
- .NET SDK
- Microsoft Edge or another approved Playwright browser
- Repository access
- Access to the selected non-production validation environment

Install only the tools required by the repository profile.

## Onboard a repository

1. Run `fixlab init` to create
   `.github/fixlab/repository-profile.json`.
2. Declare the frontend and backend paths.
3. Add deterministic restore, test, lint, build, and startup commands.
4. Define safe validation environments.
5. Add browser journeys that use non-sensitive test data.
6. Document the repository's process ownership and cleanup rules.
7. Validate the profile before enabling pull request creation.

Run `fixlab doctor` after editing the profile.

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
