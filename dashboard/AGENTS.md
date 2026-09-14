# Dashboard agent instructions

Changes in this directory affect local HTTP handling, job execution, process
ownership, evidence retention, screenshots, and authenticated work-item intake.

- Preserve loopback-only binding and strict request-size limits.
- Validate untrusted input before filesystem, process, or network use.
- Keep credentials and authorization headers out of responses, logs, prompts,
  caches, and persisted job state.
- Resolve artifact paths beneath verified FixLab-owned roots and reject path
  traversal and symbolic-link escapes.
- Stop only child processes created and tracked by the current job.
- Keep raw logs bounded and preserve structured stage outcomes separately.
- Add focused tests in `test/dashboard-*.test.js` for every behavior change.

Run `npm run validate` after dashboard changes. If browser or external-service
validation cannot run, record the skipped gate and residual risk rather than
claiming success.
