# Copilot instructions for FixLab

FixLab is a product-neutral Agency Copilot plugin and CLI for evidence-backed
defect validation across React frontends and .NET backends. FMDM is an example
consumer, not a dependency or hard-coded product boundary.

Before editing, read `AGENTS.md`, the nearest module-level `AGENTS.md`,
`docs/architecture.md`, and the affected tests. Preserve unrelated worktree
changes. Prefer focused changes and existing helpers over new dependencies.

Every implementation must preserve these invariants:

- local listeners bind to `127.0.0.1`;
- only FixLab-owned processes and artifact directories may be removed;
- credentials, private data, browser state, and authorization headers never
  enter source, prompts, logs, responses, or durable caches;
- required validation gates pass or are explicitly reported as blocked,
  failed, timed out, or skipped with risk;
- repository-specific behavior remains in profiles, templates, or examples.

Use `npm run validate` as the repository-wide completion gate. Add focused
`node:test` coverage for behavioral changes and update directly related
documentation. Pull requests must use the repository template and identify
validation evidence, skipped gates, and security or compatibility risks.
