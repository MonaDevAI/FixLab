# FixLab validation evidence specification v1

## Status

Version 1 defines the minimum evidence required for a review-ready FixLab
outcome.

## Evidence record

Every completed run MUST identify:

- repository and commit;
- defect or pull-request identifier;
- affected component and changed files;
- root cause and measurable expected behavior;
- each executed command with outcome and duration;
- browser journey and assertion when applicable;
- failed, skipped, timed-out, and blocked gates;
- remaining risk and required human action.

Machine-generated CI summaries MUST conform to the schemas under `reports/`.
Secrets, authorization headers, browser state, customer records, private
endpoints, and unredacted screenshots MUST NOT be retained.

## Completion

A run is successful only when all required affected gates pass. A skipped or
timed-out gate is never success-shaped. A correction that cannot be verified
MUST remain blocked or incomplete.
