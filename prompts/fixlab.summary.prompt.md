---
mode: agent
description: Optionally summarize an existing FixLab job without running checks or changing files.
---

Generate an engineering handoff for the FixLab job in this conversation using
existing session evidence only. This is an optional summary, not a new fix or
validation job. If the job is ambiguous or its evidence is unavailable, ask for
the job identifier and relevant sanitized results; do not infer them from a
different job.

Do not rerun tests, install tools, start applications, access live systems,
change files, commit, publish, or alter job status. Do not invoke the bug-fix
workflow. Return Markdown in the conversation only; a folder or ZIP requires
a separate explicit request and normal permissions.

Include these sections, marking missing evidence "Not verified":

1. Outcome: original bug, expected versus actual behavior, job identifier,
   repository/commit and PR references when safe, and whether the result is
   fixed and verified, fixed but unverified, workaround-only, external, or
   unresolved. For an active job, label the summary interim.
2. Diagnosis and changes: evidence-backed root cause, affected components,
   changed files and the rationale for the correction. Explain no-change
   outcomes honestly.
3. Test and regression report: a table of scenarios/assertions, exact safe
   commands and working directories, recorded outcomes/durations, and evidence
   references. Separate the original failing reproduction from subsequent
   verification, focused tests from broad regression, and runner-confirmed
   results from agent-reported claims. Preserve failed, skipped, timed-out,
   blocked, pending, stale, not-run and deferred checks; never mark them passed.
4. Findings and must-know: verified tradeoffs, compatibility concerns,
   maintenance traps and prerequisites. Separate pre-existing defects from
   confirmed fix-induced regressions; label suspected side effects as
   hypotheses, not findings.
5. Workarounds: only recorded workarounds, their validation, limitations,
   conditions for removal, and known ownership. Do not invent one.
6. Remaining risks and next actions: untested scenarios, missing data/access,
   evidence gaps and concrete follow-up. A complete summary does not imply
   complete regression coverage.

Distinguish local changed-code validation from deployed-system checks,
synthetic/intercepted tests from real integration, and draft publication from
ready-for-review or merge. Reference existing reviewed evidence instead of
pasting raw logs or transcripts. Exclude credentials, authorization headers,
cookies, browser state, private endpoints, personal/customer data, unreviewed
screenshots and model-cost/token metrics. Omit or redact sensitive references.
