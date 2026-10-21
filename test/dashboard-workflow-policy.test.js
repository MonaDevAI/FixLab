import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredWorkflow, efficientWorkflowGuidance } from "../dashboard/workflow-policy.js";
import { ValidationSession, selectedValidationGates, validationGates } from "../dashboard/validation-gates.js";
import { buildJobPrompt } from "../dashboard/server.js";

test("efficient workflow is a product default with saved preferences and strict opt-in", () => {
  assert.deepEqual(configuredWorkflow(), {
    mode: "efficient", unitTestsAfterPr: false, publication: "draft", optionalBuilds: false
  });
  assert.equal(configuredWorkflow({ workflow: { mode: "strict" } }).mode, "strict");
  for (const [publication, expected] of [["draft", true], ["ready", false], [undefined, false]]) {
    const workflow = configuredWorkflow({ workflow: { mode: "strict", publication } });
    assert.equal(workflow.publication, expected ? "draft" : "ready");
    const prompt = buildJobPrompt({ request: "Synthetic", mode: "fix-and-validate", workflow });
    assert.match(prompt, /all applicable configured gates remain required/);
    assert.match(prompt, expected ? /provider isDraft=true/ : /isDraft.*false/);
    if (expected) { assert.doesNotMatch(prompt, /publish the authorized PR by marking it ready/); }
    assert.match(buildJobPrompt({ request: "Synthetic", mode: "validate-only", workflow }),
      /Do not publish a pull request or change its draft status/);
  }
  const gates = validationGates({ validation: { gates: [
    { id: "unit", command: "npm", args: ["test"], workingDirectory: ".", timeoutSeconds: 10 },
    { id: "build", command: "npm", args: ["run", "build"], kind: "builds", stage: "local-stack", workingDirectory: ".", timeoutSeconds: 10 }
  ] } });
  for (const [selection, value, ids] of [
    ["all", undefined, ["unit", "build"]], ["tests", undefined, ["unit"]],
    ["builds", undefined, ["build"]], ["gate", "unit", ["unit"]],
    ["stage", "local-stack", ["build"]]
  ]) {
    assert.deepEqual(selectedValidationGates(gates, selection, value).map((gate) => gate.id), ids);
  }
  for (const [selection, value] of [["unknown"], ["gate", "unknown"], ["stage"]]) {
    assert.throws(() => selectedValidationGates(gates, selection, value), /Select configured|No configured/);
  }
  assert.deepEqual(configuredWorkflow({ workflow: {
    optionalBuilds: true, unitTestsAfterPr: false
  } }), { mode: "efficient", optionalBuilds: true, publication: "draft", unitTestsAfterPr: false });
  for (const workflow of ["efficient", [], { mode: "unknown" }, { publication: "unknown" }, { optionalBuilds: "true" }]) {
    assert.throws(() => configuredWorkflow({ workflow }), /workflow must/);
  }
});

test("efficient prompts publish before broad tests without weakening explicit requirements or read-only mode", () => {
  const workflow = configuredWorkflow();
  const guidance = efficientWorkflowGuidance(workflow);
  assert.match(guidance, /required: true/);
  assert.match(guidance, /DRAFT/);
  assert.match(guidance, /Broader local unit tests are optional/);
  const selected = efficientWorkflowGuidance(configuredWorkflow({
    workflow: { publication: "ready", unitTestsAfterPr: true }
  }));
  assert.match(selected, /READY-FOR-REVIEW/);
  assert.match(selected, /After creating the PR, run the broader local unit-test/);
  assert.match(guidance, /Keep Jest and Playwright discovery separate/);
  assert.match(guidance, /Reduce redundant regression cases, not correctness/);
  assert.match(guidance, /Optional builds are not automatically requested/);
  const prompt = buildJobPrompt({ request: "Fix synthetic regression", mode: "fix-and-validate", workflow });
  assert.match(prompt, /Saved delivery workflow: efficient/);
  assert.doesNotMatch(prompt, /create or update a draft pull request|PR readiness stays blocked/);
  const readOnly = buildJobPrompt({ request: "Check behavior", mode: "validate-only", workflow });
  assert.match(readOnly, /Do not edit files, create commits/);
  assert.doesNotMatch(readOnly, /Saved efficient delivery policy/);
});

test("browser-only reproduction is existing-application first without claiming deployed results prove a PR", () => {
  const prompt = buildJobPrompt({
    request: "Reproduce the existing application issue without fixing it",
    mode: "playwright-only", targetEnvironment: "dev"
  });
  assert.match(prompt, /Use normal Copilot reasoning and native tools/);
  assert.match(prompt, /Stage markers report work; they are not a recipe/);
  assert.match(prompt, /Existing-application fast path/);
  assert.match(prompt, /Mark unnecessary local-stack work skipped, not passed/);
  assert.match(prompt, /never copy browser state/);
  assert.match(prompt, /does not validate unpublished local changes or a PR/);
  assert.match(prompt, /Do not commit, push, create or update pull requests/);
  assert.match(prompt, /No Save, Submit, Approve, autosave/);
});
test("advisory validation retains actual failures and optional gates stay executable", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-workflow-"));
  const gate = (id, required) => ({
    id, command: process.execPath, args: ["-e", "process.exit(0)"],
    workingDirectory: ".", timeoutSeconds: 10, ...(required === undefined ? {} : { required })
  });
  try {
    const profile = { validation: { gates: [gate("unit-tests"), gate("build")] } };
    const session = new ValidationSession(repository, profile, "fix-and-validate", { advisory: true });
    assert.equal(session.summary().status, "advisory");
    assert.equal(session.summary().fullValidationPassed, false);
    assert.equal(session.required(session.gates[0], "all"), true);
    assert.equal(session.summary().gates[0].required, false);
    session.results.set("unit-tests", { status: "failed", exitCode: 1 });
    assert.equal(session.summary().status, "advisory");
    assert.equal(session.summary().gates[0].status, "failed");
    assert.equal(session.summary().fullValidationPassed, false);
    const strict = new ValidationSession(repository, profile, "fix-and-validate");
    assert.equal(strict.summary().status, "pending");
    assert.equal(strict.summary().gates[0].required, true);
    const enforced = new ValidationSession(repository,
      { ...profile, workflow: { mode: "strict" } }, "fix-and-validate", { advisory: true });
    assert.equal(enforced.summary().gates[0].required, true);
    const required = new ValidationSession(repository, {
      validation: { gates: [gate("required-tests", true), gate("build", false)] }
    }, "fix-and-validate", { advisory: true });
    assert.equal(required.summary().status, "pending");
    required.results.set("required-tests", { status: "failed", exitCode: 1 });
    assert.equal(required.summary().status, "blocked");
    required.results.set("required-tests", { status: "passed", exitCode: 0 });
    assert.equal(required.summary().status, "passed");
    assert.equal(required.summary().fullValidationPassed, false);
    assert.equal(required.summary().gates[1].status, "pending");
    session.results.set("unit-tests", { status: "passed", exitCode: 0 });
    session.results.set("build", { status: "passed", exitCode: 0 });
    assert.equal(session.summary().fullValidationPassed, true);
    session.error = "Could not verify current validation inputs.";
    assert.equal(session.summary().fullValidationPassed, false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
