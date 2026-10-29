import assert from "node:assert/strict";
import test from "node:test";
import {
  automaticValidationPolicy, affectedApplications, componentRetrievalGuidance, requiresFullValidation
} from "../dashboard/affected-surface.js";

function profile() {
  return {
    components: [
      { name: "frontend", paths: ["web/src"], testPatterns: ["web/tests/**/*.test.ts"] },
      { name: "backend", paths: ["api/src"], testPatterns: ["api/tests/**/*.cs"] }
    ],
    pullRequests: { defaultTargetBranch: "develop" },
    applications: { frontend: { workingDirectory: "web" }, backend: { workingDirectory: "api/src" } },
    browserAutomation: { workingDirectory: "web", testSynthesis: { requireScenarioEvidence: false } }
  };
}

const gates = [
  { id: "ui", workingDirectory: "web" },
  { id: "api", workingDirectory: "api" },
  { id: "global", workingDirectory: "." },
  { id: "mandatory", workingDirectory: "web", required: true }
];

test("automatic policy derives component and test roots while retaining global and mandatory gates", () => {
  const policy = automaticValidationPolicy(profile(), gates);
  assert.equal(policy.automatic, true);
  assert.equal(policy.baseRef, "origin/develop");
  assert.deepEqual(policy.scopes[1].paths, ["api/src", "api/tests"]);
  assert.deepEqual(policy.scopes[1].gateIds, ["global", "mandatory", "api"]);
  assert.deepEqual(affectedApplications(profile(), ["backend"]), {
    applications: ["backend"], browserApplicable: false
  });
  assert.deepEqual(affectedApplications(profile(), ["backend", "frontend"]), {
    applications: ["frontend", "backend"], browserApplicable: true
  });
  const requiredLive = profile();
  requiredLive.validation = { liveTestsRequired: true };
  assert.equal(affectedApplications(requiredLive, ["backend"]).browserApplicable, true);
  assert.deepEqual(affectedApplications(requiredLive, ["backend"]).applications, ["frontend", "backend"]);
  delete requiredLive.validation;
  delete requiredLive.browserAutomation.testSynthesis;
  assert.equal(affectedApplications(requiredLive, ["backend"]).browserApplicable, true);
  requiredLive.validation = { liveTestsRequired: false };
  assert.equal(affectedApplications(requiredLive, ["backend"]).browserApplicable, false);
});

test("automatic policy fails closed for missing, ambiguous or unsafe metadata and strict workflows", () => {
  for (const changed of [
    {}, { ...profile(), workflow: { mode: "strict" } },
    { ...profile(), pullRequests: {} },
    { ...profile(), components: [{ name: "backend", paths: ["../api"] }] },
    { ...profile(), components: [{ name: "backend", paths: ["api/**"] }] },
    { ...profile(), components: [{ name: "backend", paths: ["api"], testPatterns: [null] }] },
    { ...profile(), components: [{ name: "backend", paths: ["api"], testPatterns: ["../other/**/*.cs"] }] },
    { ...profile(), components: [{ name: "backend", paths: ["other"] }] }
  ]) {
    assert.equal(automaticValidationPolicy(changed, gates), null);
  }
  assert.equal(automaticValidationPolicy(profile(), null), null);
  const rootPattern = profile();
  rootPattern.components[1].testPatterns = ["Service*.cs"];
  assert.deepEqual(automaticValidationPolicy(rootPattern, gates).scopes[1].paths, ["api/src"]);
});

test("contract, shared, startup, dependency and instruction changes retain broader validation", () => {
  for (const path of [
    "api/src/Contracts/Request.cs", "api/src/App.PublicContract/Request.cs",
    "api/src/Shared/Helper.cs", "api/src/Common/Helper.cs",
    "api/Directory.Build.props", "api/Project.csproj", "api/appsettings.dev.json",
    "api/src/Program.cs", "web/package.json", "web/pnpm-lock.yaml", "web/tsconfig.json", "api/AGENTS.md"
  ]) {
    assert.equal(requiresFullValidation(path), true, path);
  }
  assert.equal(requiresFullValidation("api/src/Services/RequestService.cs"), false);
});

test("retrieval hints prefer reported component paths and never reproduce request text or source content", () => {
  const hints = componentRetrievalGuidance(profile(), "Failure at api\\src\\Services\\RequestService.cs:172 secret-value");
  assert.match(hints, /"component":"backend"/);
  assert.doesNotMatch(hints, /"component":"frontend"|secret-value|RequestService\.cs/);
  assert.match(hints, /advisory metadata, not source evidence or a gate waiver/);
  assert.match(hints, /complete verified Git diff, not report keywords/);
  assert.match(hints, /nearest existing regression/);
  assert.ok(componentRetrievalGuidance(profile(), "").length < 6000);
  const oversized = profile();
  oversized.components = Array.from({ length: 50 }, (_, index) => ({
    name: `part-${index}`, paths: [`${"a".repeat(450)}/${index}`], testPatterns: []
  }));
  assert.ok(componentRetrievalGuidance(oversized).length < 6000);
});
