# Repository onboarding

FixLab must not assume that every React and .NET repository has the same layout.
The target repository owns a versioned profile.

## Required information

### Repository

- Default branch
- Allowed pull request target branches
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

Do not place real credentials, tokens, user identities, customer records, or
internal service URLs in the profile.

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
