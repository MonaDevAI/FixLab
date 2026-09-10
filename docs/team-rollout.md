# Team rollout

## Phase 1: Documentation and validation-only pilot

- Publish this repository privately.
- Select a small engineering pilot group.
- Onboard one representative React and .NET repository.
- Enable validation-only workflows.
- Measure completion time, blocker rate, evidence quality, and false positives.

## Phase 2: Packaged CLI

- Publish a private versioned CLI package.
- Add `init`, `doctor`, `dashboard`, `validate`, and `status` commands.
- Add an automated release pipeline.
- Sign artifacts and publish checksums.
- Support controlled updates and version pinning.

## Phase 3: Shared broker and runner pool

- Host a durable broker behind organizational authentication.
- Register hosted and opt-in developer-machine runners.
- Route jobs based on repository, operating system, and required tools.
- Add centralized audit, retention, and health monitoring.

## Phase 4: Controlled code changes

- Enable fix-and-validate for approved repositories.
- Require passing regression evidence before commits.
- Require human review before pull request creation.
- Keep deployment disabled until separately reviewed.

## Ownership

Recommended roles:

- Product owner
- CLI and broker maintainers
- Runner operations owner
- Security reviewer
- Repository onboarding owners
- Support and incident owner

Use `CODEOWNERS` to protect release, security, and runner code.

