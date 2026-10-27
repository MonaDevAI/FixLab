export function configuredWorkflow(profile = {}) {
  const value = profile.workflow ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value.mode !== undefined && !["efficient", "strict"].includes(value.mode)) ||
      (value.publication !== undefined && !["draft", "ready"].includes(value.publication)) ||
      ["unitTestsAfterPr", "optionalBuilds"].some((key) =>
        value[key] !== undefined && typeof value[key] !== "boolean")) {
    throw new Error("workflow must declare efficient or strict mode, draft or ready publication, and boolean unitTestsAfterPr/optionalBuilds preferences.");
  }
  return {
    mode: value.mode ?? "efficient",
    unitTestsAfterPr: value.unitTestsAfterPr ?? false,
    publication: value.publication ?? (value.mode === "strict" ? "ready" : "draft"),
    optionalBuilds: value.optionalBuilds ?? false
  };
}

export const COPILOT_EXECUTION_GUIDANCE =
  "Use normal Copilot reasoning and native tools to choose the shortest evidence-backed investigation, reproduction and fix. Stage markers report work; they are not a recipe requiring extra commands. Start with the known symptom and nearest relevant test, reuse verified context, and adapt to evidence instead of rediscovering the repository. Do not ask the user to direct routine authorized engineering steps. Required instructions, permissions, human authentication and data-safety controls remain authoritative.";

export const UNIT_TEST_ONLY_GUIDANCE =
  "When validation.liveTestsRequired is false, this repository explicitly uses unit-test-only validation. This contract overrides live-test, browser and application-startup instructions: run the configured local unit tests and required offline checks, do not start applications, authenticate, send API requests or access remote databases. Mark local-stack and live-test skipped with validation.liveTestsDeferredReason; never mark live validation passed or claim integration coverage. Keep required local gates, PR approvals and CI/merge policies intact.";

export const API_ONLY_PLAYWRIGHT_GUIDANCE =
  "When browserAutomation.mode is api, use Playwright APIRequestContext without a frontend, browser binary, UI screenshot, video or browser-profile ownership probe. This explicit API-only contract overrides browser-specific setup and evidence wording, not safety or required gates. Start only the profile-defined backend when necessary and verify its health separately from authenticated business endpoints. Require fresh legitimate API authentication for the selected audience/environment; az login or a state file alone is not an API bearer token or proof. Restrict targets and redirects to the repository-approved allowlist and enforce its allowed read-only operations before sending requests; APIRequestContext does not inherit page.route interception. Production-backed data additionally requires the explicit local-API productionDatabaseReadOnly exception, a successful assertReadOnlyDatabase check proving database-enforced read-only access, and production-read-only evidence. This never permits deployed production URLs or writes. Never send a mutation merely because a UI mutation mode says intercepted. Missing API access, safe data or startup prerequisites block live testing; synthetic responses never prove a live API passed. Preserve sanitized method/path/status and response-schema assertions plus FIXLAB_TEST scenario evidence; never persist tokens, authorization headers, cookies, sensitive bodies or credential-bearing traces. Do not fabricate browser artifacts or waive authentication to make Doctor pass.";

export const CONCISE_PR_GUIDANCE =
  "Keep PR descriptions concise, normally at most 120 words unless the repository template or material risk requires more. Preserve every required template heading/field. Use a brief problem/change summary, compact actual validation outcomes, and only material risks or blockers. Keep failed, skipped, pending and not-run checks explicit. Link evidence rather than pasting logs; omit repeated stage narration, full command transcripts and redundant file lists. Exclude token/cache counts, AI-credit totals and model-cost summaries from PR descriptions. Keep the FLAB: title short and specific.";

export const EXISTING_APPLICATION_GUIDANCE =
  "Existing-application fast path: for explicit browser-only reproduction or deployed-result checks, use playwright-only mode and first check the approved existing application for the selected environment. Resolve its target from repository profile/browser configuration, not an arbitrary report URL. Reuse a healthy permitted application and an authorized validation browser connection when the repository supports it; never copy browser state, take over an unrelated browser, bypass a profile lock or treat a state file as proof of sign-in. Do not clone a checkout, restore dependencies, start another local stack, or run broad unit/build gates merely to repeat a deployed UI scenario. Mark unnecessary local-stack work skipped, not passed. Start only prerequisites actually required by that journey; if the requested existing deployment is unavailable, report it rather than silently changing environment or target. Record the tested target/version and exact assertions. A baseline or deployed result does not validate unpublished local changes or a PR: those require the matching source commit and correct application. Explicit manual-localhost requests retain their local requirements.";

export function efficientWorkflowGuidance(workflow, { dashboard = true } = {}) {
  return `Saved efficient delivery policy (applies without repeated job/stage questions):
- Inspect the effective diff, make the smallest fix, run the focused regression checks that cover it, and self-review the checkpoint.
- Explicitly required repository checks (validation.gates entries with required: true), repository instructions, human PR authorization, managed policy and branch/merge policies remain authoritative. Efficient mode never waives them.
- After that reviewed focused checkpoint and any explicitly required pre-publication checks, create or update the authorized ${workflow.publication === "ready" ? "READY-FOR-REVIEW" : "DRAFT"} pull request now. Do not wait for optional broad local tests or builds. Never create an empty PR or stage unrelated files.
- Verify provider isDraft is ${workflow.publication !== "ready"} before reporting the PR stage passed. Publication is not proof of completed validation or permission to mark ready, merge, deploy or force-push.
- ${workflow.unitTestsAfterPr ? `After creating the PR, run the broader local unit-test gates against the same checkout through ${dashboard ? "dashboard-owned execution" : "fixlab exec with compact structured evidence"}. Update the same PR with actual results; do not delay PR creation while those tests run.` : "Broader local unit tests are optional and are not automatically requested. Leave their status not run/pending and report required remote CI separately."}
- ${workflow.optionalBuilds ? "The saved repository preference requests optional builds after PR creation; run them and report their actual outcomes." : "Optional builds are not automatically requested. Offer the saved repository Settings preference once when needed, not a question for every job or stage. Never run a full build merely to decide whether a PR may be created."}
- Keep every pending, failed, stale, skipped or not-run check explicit in the PR and dashboard. Never convert an optional check into passed, reuse stale evidence, bypass an explicitly required gate, or disable a CI/merge policy.
- Continue independent safe work without repeating successful discovery or unchanged focused checks. Use the same branch and PR; never create duplicate PRs.
- Reduce redundant regression cases, not correctness: reuse fixtures and existing test files; move punctuation, length and duplicate-value matrices to pure units. Browser cases represent distinct flows. Preserve safety, permissions, lease/queue and real reproduction boundaries. Do not hide repeated expensive work inside one case. Measure comparable baseline/final elapsed time and report actual savings.
- Keep Jest and Playwright discovery separate: bare Jest may collect E2E specs and bare Playwright selects all projects. Inspect configuration, select exact unit paths with an explicit E2E exclusion, and select the focused browser journey and authenticated project explicitly. Do not silently edit consumer configuration.`;
}
