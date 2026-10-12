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

Optionally, declare `trustedDependencyRoots`, a list of absolute directories, when a
working directory's `node_modules` is a link to a shared install outside the
repository. Non-interactive agents cannot answer path-permission prompts, so FixLab
passes `--add-dir` only for `node_modules` links under these roots, in the profile's
working directories. Without this field, no external path is granted. Filesystem roots
are ignored.
Synthesized scenario source is transient by default. The agent must remove
generated test files and validation-only configuration changes before the
product pull request. A repository can require a permanent generated browser
test through its instructions, or the user can request one explicitly;
otherwise newly created authenticated `*.auth.spec.ts` files are validation
artifacts rather than product changes.

Use `defaultDataSource: "synthetic-intercepted"` with
`mutationMode: "intercepted"` when Playwright should fulfill reads locally and
capture mutation intent without changing an external record. Repositories may
instead declare `local-fixture`, `non-production-read-only`, or
`non-production-approved`; any approved write still requires the normal human
unsafe-data approval.

With `non-production-read-only`, an explicitly selected DEV or SIT environment
is tried first. If that backend is unavailable or cannot provide a safe record
required for the assertion, FixLab may fall back to
`synthetic-intercepted`/`intercepted` and must report that the backend was not
validated. Expected empty-state scenarios must remain against the selected
backend and must not be replaced by synthetic results.

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

## Optional private adapters

Some organizations keep data-handling or policy helpers (for example, validation
of security work-item data) in a private package. Public FixLab does not name,
bundle, or install such packages. The owning team makes them discoverable:

- Publish a short onboarding page in the private repository or internal wiki
  that states the package name, the feed that hosts it, how to request access,
  and who approves its use.
- Authenticate to that feed with the owner's supported credential provider
  before running `fixlab prepare`. FixLab never creates, copies, or persists
  feed credentials.
- Link the onboarding page from the repository's own `README` or contributor
  guide so a first-time developer finds it without asking.
- Keep the adapter's name, feed URL, and access instructions out of public
  FixLab files and out of the profile's shared defaults; they belong in the
  private repository.

An adapter must not bypass approval gates. Publication approval, unsafe-data
approval, and the no-automatic-closure rules for findings still apply.

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
