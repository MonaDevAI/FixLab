import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import {
  newPermissionRequest,
  permissionRequest,
  reviewPermissionDirectory,
  runtimePermissionDenialLine,
  verifyPermissionDirectory
} from "../dashboard/runtime-permissions.js";

test("runtime denials are recognized without treating quoted code or workflow approval as permission requests", () => {
  for (const line of [
    "  Permission denied because no interactive user response was available. Retry in an interactive session.",
    "  \u2514 Permission denied because no interactive user response was available.",
    "\u001b[31mDenied, no one to approve\u001b[0m",
    "FIXLAB_STAGE|diagnosis|blocked|Execution remains denied: Permission denied because no interactive user response was available."
  ]) {
    assert.equal(runtimePermissionDenialLine(line), true, line);
  }
  for (const line of [
    'const message = "Permission denied because no interactive user response was available.";',
    "Explain how to handle Permission denied because no interactive user response was available.",
    "FIXLAB_STAGE|pr|blocked|User approval required before creating a PR.",
    "FIXLAB_STAGE|live-test|blocked|Manual localhost confirmation is pending."
  ]) {
    assert.equal(runtimePermissionDenialLine(line), false, line);
  }
  const first = newPermissionRequest();
  const second = newPermissionRequest();
  assert.notEqual(first.id, second.id);
  assert.equal(first.kind, "unclassified");
  assert.equal(first.scope, null);
  assert.equal(permissionRequest({ diagnosis: { status: "passed", message: "Execution remains denied" } }), null);
  assert.equal(permissionRequest({ diagnosis: { status: "blocked", message: "Execution remains denied" } }).scope, null);
});

test("folder scope review rejects broad, sensitive, missing and non-directory targets", () => {
  const base = mkdtempSync(join(tmpdir(), "fixlab-permission-"));
  try {
    const repository = join(base, "repository");
    const packageRoot = join(base, "installation", "cli");
    const external = join(base, "external");
    for (const directory of [repository, packageRoot, external]) {
      mkdirSync(directory, { recursive: true });
    }
    const context = { repository, packageRoot };
    const scope = reviewPermissionDirectory(external, context);
    assert.equal(scope.directory, realpathSync(external));
    assert.equal(verifyPermissionDirectory(scope, context), realpathSync(external));
    for (const value of [
      "", ".", "../external", "*", null, ["folder"], "https://example.invalid",
      "\\\\untrusted\\share\\folder",
      `${external}\n`, parse(base).root, homedir(), base, repository,
      join(base, "installation"), join(base, "missing")
    ]) {
      assert.throws(() => reviewPermissionDirectory(value, context), undefined, String(value));
    }
    const file = join(external, "file.txt");
    writeFileSync(file, "not a folder");
    assert.throws(() => reviewPermissionDirectory(file, context), /existing folder/);
    for (const name of [".git", ".ssh", ".azure", ".aws", ".copilot", ".auth", ".edge-profile"]) {
      const sensitive = join(external, name);
      mkdirSync(sensitive);
      assert.throws(() => reviewPermissionDirectory(sensitive, context), /cannot be granted/);
    }
    assert.equal(reviewPermissionDirectory(packageRoot, context).directory, realpathSync(packageRoot));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("reviewed symlink targets are revalidated instead of silently granting a substituted directory", () => {
  const base = mkdtempSync(join(tmpdir(), "fixlab-permission-link-"));
  try {
    const repository = join(base, "repository");
    const packageRoot = join(base, "cli");
    const first = join(base, "first");
    const second = join(base, "second");
    for (const directory of [repository, packageRoot, first, second]) {
      mkdirSync(directory);
    }
    const link = join(base, "link");
    symlinkSync(first, link, "junction");
    const context = { repository, packageRoot };
    const scope = reviewPermissionDirectory(link, context);
    assert.equal(scope.directory, realpathSync(first));
    rmSync(link);
    symlinkSync(second, link, "junction");
    assert.throws(() => verifyPermissionDirectory(scope, context), /target changed/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
