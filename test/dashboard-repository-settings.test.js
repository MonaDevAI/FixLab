import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyRepositorySettings, inspectRepositorySettings, localRepository, planRepositorySettings } from "../dashboard/repository-settings.js";
import { canonicalExecutionRepository, createExecutorLease } from "../dashboard/executor-lease.js";
import { SETUP_PROFILE_PATH } from "../dashboard/repository-setup.js";
import { validateLiveTestProfile } from "../dashboard/server.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
function fixture() {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-settings-"));
  const initialized = spawnSync("git", ["init", "--quiet"], {
    cwd: repository, windowsHide: true, encoding: "utf8"
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  return repository;
}
function plan(repository, overrides = {}, install = true) {
  const inspected = inspectRepositorySettings(repository);
  return planRepositorySettings({ repository, revision: inspected.revision,
    values: { ...inspected.values, branchUserId: "synthetic-user", ...overrides },
    install, packageRoot, validate: validateLiveTestProfile });
}

test("repository onboarding previews without writes and creates only missing reviewed scaffolding", () => {
  const repository = fixture();
  try {
    assert.equal(localRepository(repository), repository);
    const preview = plan(repository);
    assert.equal(existsSync(join(repository, ".github")), false);
    assert.equal(preview.files.length, 10);
    const applied = applyRepositorySettings(preview, "synthetic-settings-owner");
    assert.equal(applied.saved, true);
    const profile = JSON.parse(readFileSync(join(repository, SETUP_PROFILE_PATH), "utf8"));
    assert.equal(profile.pullRequests.branchNaming.userId, "synthetic-user");
    assert.deepEqual(profile.workflow, {
      mode: "efficient", publication: "draft", unitTestsAfterPr: false, optionalBuilds: false
    });
    assert.equal(profile.browserAutomation.dataSafety.productionAllowed, false);
    assert.equal(validateLiveTestProfile(profile).ok, true);
    assert.equal(existsSync(join(repository, ".github", "agents", "fixlab-autofix.agent.md")), true);
    assert.equal(existsSync(canonicalExecutionRepository(repository).directory), false);
    assert.equal(plan(repository).assets.length, 0);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("repository settings preserve undisplayed configuration and never expose environment values", () => {
  const repository = fixture();
  try {
    applyRepositorySettings(plan(repository), "synthetic-settings-owner");
    const path = join(repository, SETUP_PROFILE_PATH);
    const profile = JSON.parse(readFileSync(path, "utf8"));
    profile.browserAutomation.authentication.environment = { SYNTHETIC_PRIVATE: "noncredential-private-sentinel" };
    profile.pullRequests.requireConfirmation = false;
    profile.workflow.publication = "ready";
    profile.customContract = { retained: true };
    profile.environments = { dev: { syntheticContract: "preserved" } };
    writeFileSync(path, JSON.stringify(profile));
    const inspected = inspectRepositorySettings(repository);
    assert.doesNotMatch(JSON.stringify(inspected), /noncredential-private-sentinel|SYNTHETIC_PRIVATE/);
    const preview = plan(repository, { name: "Updated synthetic repository",
      efficientWorkflow: false, optionalBuilds: true, unitTestsAfterPr: false }, false);
    assert.deepEqual(preview.files, [SETUP_PROFILE_PATH]);
    applyRepositorySettings(preview, "synthetic-settings-owner");
    const updated = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(updated.name, "Updated synthetic repository");
    assert.deepEqual(updated.workflow, {
      mode: "strict", publication: "ready", unitTestsAfterPr: false, optionalBuilds: true
    });
    assert.deepEqual(updated.customContract, { retained: true });
    assert.equal(updated.pullRequests.requireConfirmation, false);
    assert.deepEqual(updated.environments, profile.environments);
    assert.deepEqual(updated.browserAutomation.authentication.environment, profile.browserAutomation.authentication.environment);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("repository settings reject stale plans and never replace an active executor lease", () => {
  const repository = fixture();
  try {
    const reviewed = plan(repository);
    const lease = createExecutorLease(repository, "synthetic-active-owner").acquire("synthetic-live-job");
    try {
      assert.throws(() => applyRepositorySettings(reviewed, "synthetic-settings-owner"), /lease is reserved/);
      assert.equal(existsSync(join(repository, SETUP_PROFILE_PATH)), false);
    } finally {
      lease.release();
    }
    mkdirSync(join(repository, ".github", "fixlab"), { recursive: true });
    writeFileSync(join(repository, SETUP_PROFILE_PATH), '{"name":"Concurrent edit"}');
    assert.throws(() => applyRepositorySettings(reviewed, "synthetic-settings-owner"), /changed after review/);
    assert.equal(readFileSync(join(repository, SETUP_PROFILE_PATH), "utf8"), '{"name":"Concurrent edit"}');
    assert.equal(existsSync(canonicalExecutionRepository(repository).directory), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("repository configuration rejects traversal, credential commands and unsafe health or environment settings", () => {
  const repository = fixture();
  try {
    for (const override of [
      { frontendDirectory: ".." },
      { frontendHealthUrl: "https://example.com/health" },
      { frontendHealthUrl: "http://user:password@127.0.0.1:3000" },
      { frontendCommand: "npm --token synthetic-value" },
      { environments: "local,production" },
      { branchPrefix: "../outside" },
      { unexpected: "Not an editable field" },
      { authenticationRequired: true, authenticationCommand: "npm run auth", authenticationPaths: "../outside" }
    ]) {
      assert.throws(() => plan(repository, override), undefined, JSON.stringify(override));
    }
    const inspected = inspectRepositorySettings(repository);
    assert.throws(() => planRepositorySettings({ repository, revision: "stale",
      values: inspected.values, install: false, packageRoot, validate: validateLiveTestProfile }), /changed/);
    const subdirectory = join(repository, "subdirectory");
    mkdirSync(subdirectory);
    assert.throws(() => localRepository(subdirectory), /root of an existing Git/);
    assert.equal(existsSync(join(repository, SETUP_PROFILE_PATH)), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("repository settings refuse symlinked scaffolding instead of writing outside the selected repository", () => {
  const repository = fixture();
  const outside = mkdtempSync(join(tmpdir(), "fixlab-settings-outside-"));
  try {
    symlinkSync(outside, join(repository, ".github"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => inspectRepositorySettings(repository), /symbolic links/);
    assert.equal(existsSync(join(outside, "fixlab")), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
