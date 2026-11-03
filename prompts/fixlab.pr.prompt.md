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

Reusable PR learning: within the existing pr stage, only when source edits and
PR publication are authorized, inspect task-relevant existing repository skills
for verified, non-obvious, reusable knowledge from this change. Prefer to update
a matching skill; otherwise create `.github/skills/<topic>/SKILL.md` with YAML name
and description; the name must match the lowercase-hyphenated topic directory.
Capture when to use it, the verified solution, repository file/test references,
exact working directories and validation commands, and pitfalls. Skills are for
future developers and relevant agent tasks, not a diary of the current run.
Include the skill in the same reviewed PR before committing/pushing; self-review
its instructions and run applicable documentation/skill checks. In the concise
PR body, link the added/updated skill or state no new reusable learning when none
qualifies; do not create empty, speculative or duplicate skills. Use no separate
roadmap stage. Read-only jobs must not write skills, commit or publish. Respect
repository instruction governance and existing approval boundaries. Do not add
allowed-tools or broaden permissions. Never include credentials, personal/customer
data, private endpoints or raw transcripts.

Keep the description short, normally at most 120 words unless required template
fields or material risks need more. Preserve required headings, a brief
problem/change summary, compact actual validation outcomes and material
risks/blockers. Keep failed, skipped, pending and not-run checks explicit.
Link evidence instead of pasting logs, command transcripts or stage narration.
Exclude token/cache counts, AI-credit totals and model-cost summaries from PR
descriptions.

After required local validation and approval gates pass or have an explicitly
accepted outcome, publish the authorized PR by marking it ready for review.
Do not wait for remote PR CI or build completion before publication; publication
can trigger those checks. Verify the PR is no longer draft before reporting the
PR stage passed. Report remote checks as pending, not passed, and leave merge
policies intact. Use `gh pr ready <number>` for GitHub or
`az repos pr update --id <id> --draft false` for Azure DevOps, then read back
`isDraft` from the provider to confirm it is false. If publication or state
verification fails, report the PR stage blocked or failed, not passed.
