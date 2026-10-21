import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectBrowserProfileOwnership } from "../dashboard/browser-ownership.js";

test("browser ownership matches only declared profile directories and ignores subprocesses", () => {
  const root = mkdtempSync(join(tmpdir(), "fixlab-browser-owner-"));
  try {
    const profile = join(root, "profile with spaces");
    const other = join(root, "other-profile");
    mkdirSync(profile);
    mkdirSync(other);
    writeFileSync(join(root, "auth-state.json"), "{}");
    const configuration = { workingDirectory: root, statusPaths: ["profile with spaces", "auth-state.json"] };
    const blocker = inspectBrowserProfileOwnership(configuration, {
      query: () => [
        { pid: 111, commandLine: `msedge --user-data-dir="${profile}" --enable-automation` },
        { pid: 112, commandLine: `msedge --user-data-dir="${profile}" --type=renderer` },
        { pid: 113, commandLine: `msedge --user-data-dir="${other}"` }
      ]
    });
    assert.deepEqual(blocker.pids, [111]);
    assert.equal(blocker.kind, "browser-profile-busy");
    assert.match(blocker.message, /No process was stopped/);
    assert.doesNotMatch(JSON.stringify(blocker), /auth-state|profile with spaces|commandLine/);
    assert.equal(inspectBrowserProfileOwnership(configuration, { query: () => [] }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser ownership never reads authentication files and does not inspect processes without a declared profile", () => {
  const root = mkdtempSync(join(tmpdir(), "fixlab-browser-state-"));
  try {
    writeFileSync(join(root, "state.json"), "synthetic non-JSON sentinel, not authentication");
    assert.equal(inspectBrowserProfileOwnership({
      workingDirectory: root, statusPaths: ["state.json", "missing-directory"]
    }, { query() { throw new Error("Process inspection must not run"); } }), null);
    assert.throws(() => inspectBrowserProfileOwnership({
      workingDirectory: root, statusPaths: [".."]
    }), /within.*working directory/);
    mkdirSync(join(root, "profile"));
    assert.throws(() => inspectBrowserProfileOwnership({
      workingDirectory: root, statusPaths: ["profile"]
    }, { query() { throw new Error("Synthetic process inspection failure"); } }), /inspection failure/);
    assert.throws(() => inspectBrowserProfileOwnership({
      workingDirectory: root, statusPaths: ["profile"]
    }, { query: () => [{ pid: "invalid", commandLine: "" }] }), /invalid process metadata/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
