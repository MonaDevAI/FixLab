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
gate passes or repository policy records an explicitly accepted outcome.
