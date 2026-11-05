---
name: fixlab-job-scoped-post-approval
description: Preserve explicit, revision-bound write consent when changing scoped POST or broad DEV approval, native tools, or job lifecycle.
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
- Scoped POST approval retains endpoint/test-record checks. Separate broad DEV
  or PPE consent selects `mode: dev-origin` or `ppe-origin` on the same memory-only
  grant and worker protocol; it permits POST/PUT/PATCH/DELETE on exact reviewed
  `dataSafety.devWrite` or `dataSafety.ppeWrite` HTTPS origins without a record
  marker. Require fresh explicit consent for that environment; never inherit
  origins or grants across environments. Require its explicit hostname label
  and reject conflicting labels. Require separate consent,
  never generic Allow all tools or a recovered capability preference.
- Both scopes retain existing authentication. Never disable browser guards or
  substitute a browser write. API-only/unit-only and explicit read-only contracts
  cannot be overridden.
- Stop job-scoped approval after failed or ambiguous attempts. Approval is not
  evidence that a scenario passed.

Implementation: `dashboard/dev-post.js`, `dashboard/copilot-session.js`,
`dashboard/server.js`, and `dashboard/public/app.js`.

Verify actual HTTP, SDK, worker, and browser behavior, not prompt text alone:

```powershell
node --test test\dashboard-dev-post.test.js
node --test --test-name-pattern="POST checkbox write consent|DEV write checkbox|native executor forwards" test\dashboard-server.test.js
npm run test:e2e -- dashboard-readiness --grep "POST checkbox|DEV write checkbox"
```
