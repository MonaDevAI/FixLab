import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/fixlab.js", import.meta.url));

function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8"
  });
}

test("help lists supported commands", () => {
  const result = run(["--help"], process.cwd());

  assert.equal(result.status, 0);
  assert.match(result.stdout, /fixlab init/);
  assert.match(result.stdout, /fixlab validate/);
});

test("init creates a parseable repository profile", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    const result = run(["init", repository], repository);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );

    assert.equal(result.status, 0);
    assert.equal(existsSync(profilePath), true);
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    assert.equal(profile.browserAutomation.package, "@playwright/test");
    assert.equal(profile.browserAutomation.browser, "chromium");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("init refuses to overwrite an existing profile", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const second = run(["init", repository], repository);

    assert.equal(second.status, 1);
    assert.match(second.stderr, /already exists/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor blocks when Playwright is unavailable", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const result = run(["doctor", repository], repository);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Playwright package/);
    assert.match(result.stdout, /FAIL  Playwright browser/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor launches the configured Playwright browser", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const playwrightDirectory = join(
      repository,
      "frontend",
      "node_modules",
      "@playwright",
      "test"
    );
    mkdirSync(playwrightDirectory, { recursive: true });
    writeFileSync(
      join(playwrightDirectory, "index.js"),
      "exports.chromium = { launch: async () => ({ close: async () => {} }) };"
    );

    const result = run(["doctor", repository], repository);

    assert.match(result.stdout, /PASS  Playwright package/);
    assert.match(
      result.stdout,
      /PASS  Playwright browser \(chromium launched successfully\)/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("validate requires a numeric pull request", () => {
  const result = run(["validate", "--pr", "invalid"], process.cwd());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /only digits/);
});
