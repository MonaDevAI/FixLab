---
mode: agent
description: Prepare an evidence-backed pull-request or no-change outcome.
---

Reuse an existing pull request when one was supplied. When publication is
authorized and a real repository change exists, create or refresh a draft PR
after the scoped change and smallest focused regression checks pass; remaining
independent validation may continue while that draft is open. Keep the PR
description current with the symptom, confirmed root cause, focused change,
completed and running checks, browser evidence, skipped gates, and remaining
risks. Never mark the PR ready or complete the PR stage until every required
local gate passes or repository policy records an explicitly accepted outcome.

After required local validation and approval gates pass or have an explicitly
accepted outcome, publish the authorized PR by marking it ready for review.
Do not wait for remote PR CI or build completion before publication; publication
can trigger those checks. Verify the PR is no longer draft before reporting the
PR stage passed. Report remote checks as pending, not passed, and leave merge
policies intact. Use `gh pr ready <number>` for GitHub or
`az repos pr update --id <id> --draft false` for Azure DevOps, then read back
`isDraft` from the provider to confirm it is false. If publication or state
verification fails, report the PR stage blocked or failed, not passed.
