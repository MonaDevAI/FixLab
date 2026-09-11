---
mode: agent
description: Validate a fix or existing pull request with repository-owned checks.
---

Inspect the effective diff and use `.github/fixlab/repository-profile.json` to
run the smallest complete set of focused tests, changed-file linting,
type-checking, and required builds. Report each result independently. Never
convert a failure, timeout, or skipped gate into a pass, and do not make source
changes when the request is validation-only.
