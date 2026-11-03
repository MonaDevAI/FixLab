---
name: fixlab-job-scoped-post-approval
description: Preserve explicit, revision-bound write consent when changing the FixLab POST checkbox, native tool, or job lifecycle.
---

# Job-scoped POST approval

Use when changing POST consent, executor configuration, recovery, or snapshots.
Work from the FixLab repository root.

- A saved capability preference is not write approval. Only fresh explicit
  checkbox confirmation creates the memory-only job/environment/revision grant.
- Validate consent independently of `toolApprovalMode`. Enforce exact loopback
  Host and Origin for both ordinary and Allow-all jobs.
- Bind the reviewed profile and authentication-helper revision before queueing.
  Configuration added later must not enlarge an earlier approval.
- Preserve the grant through the native worker protocol. Never persist it in
  snapshots or inherit it on hold, recovery, restart, or another job.
- Both approval modes retain endpoint/test-record checks and existing
  authentication. Never disable browser guards or substitute a browser write.
- Stop job-scoped approval after failed or ambiguous attempts. Approval is not
  evidence that a scenario passed.

Implementation: `dashboard/dev-post.js`, `dashboard/copilot-session.js`,
`dashboard/server.js`, and `dashboard/public/app.js`.

Verify actual HTTP, SDK, worker, and browser behavior, not prompt text alone:

```powershell
node --test test\dashboard-dev-post.test.js
node --test --test-name-pattern="POST checkbox write consent|native executor forwards" test\dashboard-server.test.js
npm run test:e2e -- dashboard-readiness --grep "POST checkbox"
```
