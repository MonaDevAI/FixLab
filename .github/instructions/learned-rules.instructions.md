---
applyTo: "dashboard/public/**/*.js"
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

# Candidate rules

No candidates are awaiting promotion.

# Retired rules

No rules are currently retired.
