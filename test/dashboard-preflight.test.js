import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPreflightFailure,
  probeTimeoutMs,
  resolveOnPath,
  runJobPreflight
} from "../dashboard/preflight.js";

const profile = {
  validation: {
    commands: {
      frontendRestore: "npm ci",
      backendRestore: "dotnet restore"
    }
  },
  applications: {
    frontend: { command: "npm run start:devConfig" }
  }
};

test("preflight reports each missing tool once", () => {
  const issues = runJobPreflight({ profile, resolve: () => false });
  assert.deepEqual(
    issues.map((issue) => issue.check),
    ["npm on PATH", "dotnet on PATH"]
  );
  assert.match(formatPreflightFailure(issues), /^Preflight failed: npm on PATH/);
});

test("preflight passes when every required tool resolves", () => {
  assert.deepEqual(runJobPreflight({ profile, resolve: () => true }), []);
});

test("preflight ignores commands it does not recognise and missing profiles", () => {
  const unknown = { validation: { commands: { frontendRestore: "make deps" } } };
  assert.deepEqual(runJobPreflight({ profile: unknown, resolve: () => false }), []);
  assert.deepEqual(runJobPreflight({ resolve: () => false }), []);
});

test("preflight recognises cmd and exe suffixes", () => {
  const issues = runJobPreflight({
    profile: { validation: { commands: { frontendRestore: "npm.cmd ci" } } },
    resolve: () => false
  });
  assert.equal(issues.length, 1);
});

test("PATH lookup uses where.exe on Windows and which elsewhere", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: "C:\\tool\\npm.cmd\n" };
  };
  assert.equal(resolveOnPath("npm", { platform: "win32", spawn }), true);
  assert.equal(resolveOnPath("npm", { platform: "linux", spawn }), true);
  assert.deepEqual(calls, [
    ["where.exe", ["npm"]],
    ["which", ["npm"]]
  ]);
  assert.equal(
    resolveOnPath("npm", { spawn: () => ({ status: 1, stdout: "" }) }),
    false
  );
});

test("probe timeout defaults to 30 seconds and accepts a bounded override", () => {
  assert.equal(probeTimeoutMs({}), 30000);
  assert.equal(probeTimeoutMs({ FIXLAB_DOCTOR_TIMEOUT_MS: "90000" }), 90000);
  for (const value of ["abc", "999", "600001", "1.5", "-5", ""]) {
    assert.equal(probeTimeoutMs({ FIXLAB_DOCTOR_TIMEOUT_MS: value }), 30000);
  }
});
