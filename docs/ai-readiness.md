# AI-readiness engineering

FixLab treats AI readiness as an engineering property, not a documentation
claim. The repository must make its operating constraints discoverable, expose
repeatable validation, retain machine-readable evidence, and keep humans on the
review loop.

## Baseline

The initial CodeBlend composite evaluation scored FixLab at **41.1/100**:

- Substrate: 49.4
- Operation: 34.2
- Verdict: not AI-ready

The baseline identified missing agent instructions, reproducible environment
configuration, dependency locking, validation tooling, review ownership,
machine-readable evidence, bounded cleanup automation, and deterministic
documentation drift controls.

## Implemented transformation

- `AGENTS.md`, scoped dashboard instructions, Copilot instructions, and a
  repository custom agent define operating and safety contracts.
- `.devcontainer/devcontainer.json`, `.nvmrc`, `.node-version`, and the
  committed npm lock file make setup reproducible.
- `npm run validate` combines lint, format, documentation drift, tests, and
  package-content checks.
- Pull-request CI uploads JUnit and documentation drift artifacts.
- CODEOWNERS and the pull-request template route changes through human review.
- The maintenance workflow runs bounded cleanup only against explicit
  FixLab-owned artifact roots and uploads its report.
- GitHub Actions are pinned to reviewed commit SHAs.
- The learned-rule corpus uses candidate, active, and retired states with
  promotion and size limits enforced by CI and scheduled review.
- Failed CI runs trigger evidence-preserving containment that emits a
  schema-defined signal and notifies the pull request or issue queue. The
  workflow never checks out or executes pull-request code.
- CI executes proof-of-bug and proof-of-fix scenarios for flaky-test
  containment and restoration of a multi-commit failed push to the last
  successful tree.
- A monthly and manually dispatchable self-healing drill runs the same proof
  independently and retains its machine-readable artifact.
- The versioned contracts under `specs/v1/` define autofix behavior and
  evidence requirements, while the repository policy checker keeps local
  branch-protection intent aligned with CI and rollback controls.
- The active `main` ruleset requires an approving code-owner review, dismisses
  stale approvals, and blocks merging until `test` and `analyze` succeed.
- The scheduled `agentic-rule-review` workflow reviews independent run
  evidence and may open a bounded candidate-rule issue; promotion remains a
  human-reviewed pull-request change.
- Its upstream `Agent Rule Review` workflow first enforces the deterministic
  lifecycle policy and records an independent, read-only Copilot review
  artifact. The downstream agent receives evidence rather than mutation
  permissions.
- Playwright exercises the running dashboard readiness endpoint, and
  TypeScript checks the repository automation and MCP implementation.

## Continuous improvement loop

1. Run the CodeBlend composite assessment after meaningful engineering-loop
   changes.
2. Preserve the generated report outside source control or as a CI artifact.
3. Select remediation by weighted score impact and actual product value.
4. Implement executable behavior and focused tests; do not add placeholder
   configuration solely to influence scoring.
5. Run `npm run validate` and review the machine-readable CI evidence.
6. Record durable architectural decisions under `docs/adr/`.
7. Reassess and compare the new score with the prior baseline.

Semantic review remains advisory. A control is considered complete only when a
deterministic repository-wide gate verifies it on affected pull requests.
