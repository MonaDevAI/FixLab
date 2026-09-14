---
on:
  schedule:
    - cron: "37 5 * * 3"
  workflow_dispatch:

permissions:
  actions: read
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write

network: defaults

tools:
  github:
    toolsets: [actions, issues, pull_requests]

safe-outputs:
  create-issue:

---

# Review FixLab learned-rule candidates

Review the latest successful `Agent Rule Review` workflow artifact, recent
FixLab pull requests, and open issues for repeated engineering-loop failures.
Read `.github/copilot-code-review.yml` and
`.github/instructions/learned-rules.instructions.md`.

Create one concise issue only when at least one candidate rule is supported by
the configured minimum number of distinct runs. Include:

- the repeated failure pattern and links to the independent evidence;
- the proposed candidate rule;
- why existing active rules do not cover it;
- the validation or retirement condition;
- any security or compatibility risk.

Do not propose repository-specific credentials, private data, production
endpoints, broad stylistic preferences, or rules supported by only one run.
Do not modify source or promote a rule directly. Human review through a pull
request remains required for promotion or retirement.
