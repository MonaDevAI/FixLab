---
name: fixlab-bugfix
description: Run the complete FixLab reproduce, repair, and verification loop for one bug.
agent: fixlab-autofix
---

Fix one bug using the `fixlab-autofix` agent.

## Bug

- Description and expected versus actual behavior: `${input:bug}`
- Component or source file, if known: `${input:scope}`
- Reproduction details, work-item link, or evidence: `${input:evidence}`

Read the repository-owned FixLab profile and instructions before editing.
Reproduce or establish a measurable failure, trace the root cause, make the
smallest complete correction, add focused regression coverage, and run every
affected profile-defined validation gate. For a UI-visible defect, prove the
behavior with a real Playwright scenario rather than a skipped template.

Do not modify source when investigation shows no repository change is needed.
Report exact evidence and every blocked, failed, skipped, or timed-out check.
