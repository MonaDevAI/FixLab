import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyWorktreeSetup, browserConfigurationErrors, planWorktreeSetup, SETUP_PROFILE_PATH } from "../dashboard/repository-setup.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fixlab-worktree-setup-"));
  const source = join(root, "source");
  const repository = join(root, "worktree");
  mkdirSync(source);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet");
  writeFileSync(join(source, "tracked.txt"), "fixture");
  git("add", "tracked.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture");
  git("worktree", "add", "--quiet", "--detach", repository);
  mkdirSync(join(source, ".github", "fixlab"), { recursive: true });
  mkdirSync(join(source, "frontend"));
  const profile = {
    browserAutomation: { workingDirectory: "frontend", testCommand: "playwright test --config=playwright.local.ts" },
    worktreeSetup: { files: ["frontend/playwright.local.ts"] }
  };
  writeFileSync(join(source, SETUP_PROFILE_PATH), JSON.stringify(profile));
  writeFileSync(join(source, "frontend", "playwright.local.ts"), "export default {};");
  return { root, source, repository, profile };
}

test("worktree setup is plan-first, explicit, idempotent and configuration-only", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, "frontend", "unrelated.txt"), "preserve");
    const plan = planWorktreeSetup(f);
    assert.equal(existsSync(join(f.repository, SETUP_PROFILE_PATH)), false);
    applyWorktreeSetup(plan);
    assert.deepEqual(JSON.parse(readFileSync(join(f.repository, SETUP_PROFILE_PATH))), f.profile);
    assert.equal(readFileSync(join(f.repository, "frontend", "playwright.local.ts"), "utf8"), "export default {};");
    assert.equal(existsSync(join(f.repository, "frontend", "unrelated.txt")), false);
    assert.deepEqual(browserConfigurationErrors(f.profile, f.repository), []);
    applyWorktreeSetup(planWorktreeSetup(f));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worktree setup preserves customized configuration and checks every file before writing", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.repository, "frontend"));
    writeFileSync(join(f.repository, "frontend", "playwright.local.ts"), "customized");
    assert.throws(() => planWorktreeSetup(f), /merge it manually/);
    assert.equal(existsSync(join(f.repository, SETUP_PROFILE_PATH)), false);
    assert.equal(readFileSync(join(f.repository, "frontend", "playwright.local.ts"), "utf8"), "customized");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worktree setup can replace only an unchanged generated template", () => {
  const f = fixture();
  try {
    const templatePath = join(f.root, "template.json");
    writeFileSync(templatePath, '{"example":true}');
    mkdirSync(join(f.repository, ".github", "fixlab"), { recursive: true });
    writeFileSync(join(f.repository, SETUP_PROFILE_PATH), '{"example":true}');
    applyWorktreeSetup(planWorktreeSetup({ ...f, templatePath }));
    assert.deepEqual(JSON.parse(readFileSync(join(f.repository, SETUP_PROFILE_PATH))), f.profile);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worktree setup refuses changed plans, unrelated repositories and sensitive paths", () => {
  const f = fixture();
  try {
    const plan = planWorktreeSetup(f);
    writeFileSync(join(f.source, "frontend", "playwright.local.ts"), "changed");
    assert.throws(() => applyWorktreeSetup(plan), /changed after planning/);
    assert.equal(existsSync(join(f.repository, SETUP_PROFILE_PATH)), false);
    assert.throws(() => planWorktreeSetup({ ...f, repository: f.root }), /same Git repository/);
    for (const name of ["../outside.ts", "C:\\outside.ts", ".env", ".npmrc", "frontend/.auth/user.json", "frontend/.edge-profile/Default/Cookies", "frontend/node_modules/tool.js", "certificate.pem"]) {
      writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify({ worktreeSetup: { files: [name] } }));
      assert.throws(() => planWorktreeSetup(f), /must not copy|repository-relative/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worktree setup and browser configuration refuse symlink escapes", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "config.ts"), "outside");
    symlinkSync(outside, join(f.source, "escape"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify({ worktreeSetup: { files: ["escape/config.ts"] } }));
    assert.throws(() => planWorktreeSetup(f), /symbolic links/);
    assert.match(browserConfigurationErrors({
      browserAutomation: { workingDirectory: ".", testCommand: "playwright test --config=escape/config.ts" }
    }, f.source)[0], /symbolic links/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("browser configuration preflight names the missing prerequisite instead of skipping it", () => {
  const root = mkdtempSync(join(tmpdir(), "fixlab-browser-config-"));
  try {
    const profile = { browserAutomation: { workingDirectory: ".", testCommand: 'playwright test --config "missing config.ts"' } };
    assert.match(browserConfigurationErrors(profile, root)[0], /missing config.ts.*worktreeSetup.files/);
    assert.deepEqual(browserConfigurationErrors({ browserAutomation: { testCommand: "npm run test:e2e" } }, root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree planning blocks omitted browser configuration and invalid file declarations", () => {
  const f = fixture();
  try {
    delete f.profile.worktreeSetup;
    writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify(f.profile));
    assert.throws(() => planWorktreeSetup(f), /configuration is missing.*worktreeSetup.files/);
    assert.equal(existsSync(join(f.repository, SETUP_PROFILE_PATH)), false);
    for (const worktreeSetup of [null, [], { files: null }, { files: "config.ts" }, { files: [1] }]) {
      writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify({ worktreeSetup }));
      assert.throws(() => planWorktreeSetup(f), /worktreeSetup/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
