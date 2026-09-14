# FixLab agent instructions

## Repository purpose

FixLab is a reusable Agency Copilot workflow for turning defects and small
enhancements into evidence-backed pull requests. Keep the core product-neutral:
repository-specific paths, commands, ports, environments, and browser journeys
belong in repository profiles and examples.

## Required workflow

1. Read `README.md`, `docs/architecture.md`, the nearest `AGENTS.md`, and any
   matching `.github/instructions/*.instructions.md` learned rules.
2. Inspect `git status` and preserve unrelated worktree changes.
3. Reproduce behavioral defects or define a measurable acceptance check for
   small enhancements.
4. Make the smallest complete change.
5. Add focused regression coverage in the existing test suite.
6. Run `npm run validate`.
7. Report every failed, skipped, timed-out, or blocked gate explicitly.

## Safety invariants

- Never commit credentials, tokens, cookies, browser state, customer data, or
  private endpoints.
- Bind local services to loopback unless a reviewed design explicitly requires
  another interface.
- Stop only processes started and tracked by the current FixLab job.
- Never select production automatically or bypass authentication, deployment,
  review, or data-safety controls.
- Do not use destructive Git operations without explicit approval.
- Do not report a skipped check as successful.

## Change boundaries

- CLI behavior belongs in `bin/`.
- Dashboard HTTP and job orchestration belong in `dashboard/`.
- Reusable agent behavior belongs in `agents/` and `prompts/`.
- Repository onboarding examples belong in `examples/` and `templates/`.
- Operational and security contracts must be reflected in `docs/`.

Use dependency-free Node.js APIs unless a dependency provides material,
reviewable value. Keep commands cross-platform where practical and use
repository-owned scripts instead of undocumented shell snippets.
