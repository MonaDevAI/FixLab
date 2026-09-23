---
applyTo: "**/*"
---

# Active learned rules

## Keep browser event registration outside request helpers

Request helpers must perform one request, validate its response, and return the
response body. Browser event registration and reusable UI helpers must remain
at module scope. This prevents repeated handler registration and avoids
helpers becoming inaccessible to later UI flows.

**Origin:** ESLint exposed nested dashboard helpers during the 2026 AI-readiness
transformation. The correction moved handlers and helper functions out of
`fetchJson` and added enforced lint coverage.

## Mirror cross-runtime guidance in every execution entry point

When new behavioral or validation guidance is intended to apply across FixLab
runtimes, update every applicable entry point in the same change:
`dashboard/server.js`, `bin/fixlab.js`, packaged agents under `agents/` and
`com.github.copilot/agents/`, and initialized agent sources under `templates/`
and `.github/agents/`. Add regression coverage that asserts parity of the new
guidance across those surfaces.

Scope this rule only to cross-runtime behavioral and validation contracts, not
general wording or stylistic changes.

**Origin:** Independent reviews of PRs #12 and #14 found that backend-first
validation and transient Playwright cleanup guidance had been added to the
dashboard without reaching the CLI or initialized agent workflow. PR #10
provided corroborating runtime-specific documentation evidence.

**Retirement condition:** Retire only after 10 qualifying pull requests add or
change cross-runtime guidance without another omitted execution entry point,
and complete retirement through a reviewed pull request.

# Candidate rules

No candidates are awaiting promotion.

# Retired rules

No rules are currently retired.
