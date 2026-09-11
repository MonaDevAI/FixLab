# FixLab commands

`fixlab init` installs these prompt files under `.github/prompts` without
overwriting repository-owned versions.

| Command | Purpose | Completion gate |
|---|---|---|
| `/fixlab.intake` | Capture the defect, expected behavior, scope, and safe data | The request is measurable and missing inputs are explicit |
| `/fixlab.diagnose` | Trace the affected code and establish the root cause | The cause is supported by repository evidence |
| `/fixlab.reproduce` | Create or run the smallest failing check | The original symptom is reproduced or a blocker is recorded |
| `/fixlab.fix` | Implement the smallest complete correction | Only required production and test files are changed |
| `/fixlab.validate` | Run focused tests, lint, type-check, and builds | Every required check passes or is explicitly skipped with risk |
| `/fixlab.live-test` | Start owned applications and run the browser journey | The running application proves the expected behavior |
| `/fixlab.pr` | Prepare the evidence-backed pull-request outcome | The PR contains the exact change, evidence, and remaining risks |

The commands read `.github/fixlab/repository-profile.json` and repository
instructions before acting. They never replace repository-owned commands,
environment controls, or approval requirements.
