# FixLab autofix loop specification v1

## Status

Version 1 is the active contract for repository-installed FixLab bugfix agents.
Changes to required behavior are reviewed through pull requests and recorded in
the changelog.

## Inputs

An autofix run MUST receive one defect with expected and actual behavior. It
MAY receive an affected component, source file, work-item link, reproduction
steps, screenshots, logs, and approved non-production test data.

The run MUST load repository instructions and
`.github/fixlab/repository-profile.json` before editing. The profile defines
component boundaries, commands, applications, browser tooling, environments,
and pull-request policy.

## Required behavior

1. The run MUST classify the smallest affected component and preserve unrelated
   worktree changes.
2. It MUST reproduce the defect or record a measurable blocker before editing.
3. It MUST trace the relevant React or .NET data flow to a supported root cause.
4. It MUST make the smallest complete correction and MUST NOT create a source
   change when evidence shows none is required.
5. It MUST add or select focused regression coverage for the changed behavior.
6. A UI-visible correction MUST include an executable Playwright journey unless
   authentication, safe data, or environment access is explicitly blocked.
7. It MUST run every profile-defined gate affected by the change.
8. It MUST report passed, failed, skipped, timed-out, and blocked checks
   separately.

## Safety

The run MUST NOT select production automatically, bypass authentication or
review controls, expose credentials or private data, terminate unrelated
processes, or broaden the change to unrelated components. Commit, push,
deployment, and pull-request publication require the permissions and approval
defined by the repository profile.
