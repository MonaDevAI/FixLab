# Validation reports

FixLab CI produces machine-readable evidence rather than committing generated
run output:

- `docs-drift.json` records repository-wide documentation validation.
- `test-results-attempt-1.xml` contains the primary JUnit test result.
- `test-results-attempt-2.xml` is present only after a failed first attempt.
- `test-signal.json` distinguishes passed, failed, and contained-flaky outcomes.
- `validation-workflow-run.json` records the chained CI completion result.
- `cleanup-report.json` records bounded deletion of expired GitHub Actions
  artifacts.
- `self-healing-signal.json` records fail-closed CI containment and links the
  preserved evidence to the affected pull request or issue queue.
- `self-healing-proof.json` records executable proof-of-bug and proof-of-fix
  pairs for flaky-test containment and failed-push rollback.

Generated files are uploaded as GitHub Actions artifacts and remain excluded
from source control through `.gitignore`.
