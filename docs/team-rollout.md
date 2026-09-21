# Team rollout

## Current product baseline

FixLab currently provides:

- A versioned GitHub repository and tagged release
- A packaged CLI with `init`, `prepare`, `doctor`, `setup-playwright`, `run`,
  `validate`, and `dashboard`
- Agency and direct GitHub Copilot CLI runtimes
- A single-user loopback dashboard with a bounded local queue
- Validation-only, Playwright-only, and controlled fix-and-validate workflows
- Repository-owned profiles, browser evidence, and explicit safety gates

The CLI is currently installed directly from GitHub. Public npm publication and
the official GitHub Copilot plugin marketplace listing remain pending. FixLab
does not currently provide a hosted multi-user broker or managed runner pool.

## Phase 1: Validation-only team pilot

- Select a small engineering pilot group.
- Onboard one representative React and .NET repository.
- Evaluate existing pull requests in validation-only mode.
- Measure completion time, blocker rate, evidence quality, false positives,
  and agreement with human reviewers.
- Require zero undisclosed skipped gates, unrelated changes, or sensitive-data
  retention.

## Phase 2: Controlled code changes

- Enable fix-and-validate only for approved repositories.
- Require passing regression and browser evidence before commits.
- Require human approval before pull request publication.
- Keep deployment disabled until separately reviewed.

## Phase 3: Distribution

- Submit FixLab to `github/copilot-plugins`.
- Enable npm trusted publishing only after the `@fixlab` scope and package are
  ready.
- Add release assets, signing, or checksums if the distribution model requires
  downloadable artifacts beyond GitHub source installation.
- Establish controlled update and version-pinning guidance.

## Phase 4: Optional shared service

- Host a durable broker behind organizational authentication.
- Register hosted and opt-in developer-machine runners.
- Route jobs based on repository, operating system, and required tools.
- Add centralized audit, retention, and health monitoring.

## Ownership

Recommended roles:

- Product owner
- CLI and broker maintainers
- Runner operations owner
- Security reviewer
- Repository onboarding owners
- Support and incident owner

Use `CODEOWNERS` to protect release, security, and runner code.
