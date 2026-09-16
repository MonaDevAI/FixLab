# Repository onboarding

FixLab must not assume that every React and .NET repository has the same layout.
The target repository owns a versioned profile.

## Required information

### Repository

- Default branch
- Allowed pull request target branches
- Developer user ID and branch prefix template
- Working directories
- Dependency restore commands
- Build and test commands

### Components

For each component, identify:

- Source paths
- Test paths
- Shared dependencies
- Maintainer or code owner
- User-visible validation requirements

### Applications

Declare:

- Startup command
- Health endpoint
- Owned local port
- Required environment variables
- Whether a deployed dependency or local dependency is required

### Browser journeys

Each journey should specify:

- Route or entry point
- Required role
- Safe test-data requirements
- User actions
- Exact observable assertion
- Cleanup behavior

The profile must also declare:

- `browserAutomation.testCommand`, which runs the repository-owned Playwright suite.
- `browserAutomation.testSynthesis`, which enables focused scenario generation,
  declares the default test-data source and mutation mode, and requires
  scenario evidence.
- `browserAutomation.authentication.required`, explicitly stating whether login is needed.
- An authentication command and status paths when authentication is required.
- `browserAutomation.dataSafety.policy`, describing mock, read-only, or intercepted-mutation behavior.
- `browserAutomation.dataSafety.productionAllowed: false`.

Use `defaultDataSource: "synthetic-intercepted"` with
`mutationMode: "intercepted"` when Playwright should fulfill reads locally and
capture mutation intent without changing an external record. Repositories may
instead declare `local-fixture`, `non-production-read-only`, or
`non-production-approved`; any approved write still requires the normal human
unsafe-data approval.

Do not place real credentials, tokens, user identities, customer records, or
internal service URLs in the profile.

Configure repository branch ownership explicitly:

```json
{
  "pullRequests": {
    "branchNaming": {
      "userId": "developer-alias",
      "prefixTemplate": "users/{userId}"
    }
  }
}
```

FixLab replaces `{userId}` with the configured value and instructs the agent to
create branches beneath the resolved prefix. It never substitutes `copilot`,
`fixlab`, or another runtime name for the repository user's ID.

## Profile review checklist

- Commands run non-interactively.
- Paths are repository-relative.
- Tests are focused and deterministic.
- Full builds have a bounded timeout.
- Local processes have explicit ownership markers.
- Production is excluded.
- Browser profiles are stored outside Git.
- Screenshots are sanitized before sharing.
- Pull request creation requires authorization.
- Deployment is a separate, explicitly approved capability.

`fixlab doctor` and the dashboard both block startup when the frontend startup
command, loopback health URL, Playwright command, authentication intent, or
data-safety policy is missing. This prevents a job from reaching the live-test
stage before the repository has a runnable, non-mutating browser-validation
contract. When authentication is required, every configured status path must
also exist; the authentication command should create its final status marker
only after sign-in succeeds.
