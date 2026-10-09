import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runPlaywrightTest, withPlaywrightProgress } from "../dashboard/playwright-runner.js";
import PlaywrightProgressReporter from "../dashboard/playwright-reporter.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "fixlab-playwright-runner-"));
  const packageDirectory = join(directory, "node_modules", "@playwright", "test");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "index.js"),
    "exports.chromium = { launch: async () => ({ close: async () => {} }) };"
  );
  return directory;
}

function options(directory, script, overrides = {}) {
  const commandPath = join(directory, "test-command.cjs");
  writeFileSync(commandPath, script);
  return {
    command: `"${process.execPath}" "${commandPath}"`,
    workingDirectory: directory,
    configuration: { package: "@playwright/test", browser: "chromium" },
    environment: {},
    timeoutMs: 5000,
    onOutput() {},
    onPhase() {},
    ...overrides
  };
}

test("background runner uses the actual workspace and captures output asynchronously", async () => {
  const directory = fixture();
  const output = [];
  const phases = [];
  try {
    const handle = runPlaywrightTest(options(directory, "console.log(process.cwd());", {
      onOutput: (stream, text) => output.push({ stream, text }),
      onPhase: (phase) => phases.push(phase)
    }));
    assert.equal(typeof handle.terminate, "function");
    const result = await handle.completion;
    assert.equal(result.status, "passed");
    assert.equal(result.code, 0);
    assert.deepEqual(phases, ["preflight", "test"]);
    assert.match(output.map((entry) => entry.text).join(""), /fixlab-playwright-runner-/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("background runner blocks missing Playwright and reports test failures", async () => {
  const directory = fixture();
  try {
    const missing = runPlaywrightTest(options(directory, "throw new Error('must not run');", {
      configuration: { package: "missing-playwright-package", browser: "chromium" }
    }));
    assert.equal((await missing.completion).status, "blocked");
    const failed = runPlaywrightTest(options(directory, "process.exit(3);"));
    const result = await failed.completion;
    assert.equal(result.status, "failed");
    assert.equal(result.code, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("background runner integrates with the installed Playwright CLI and progress reporter", async () => {
  const directory = fixture();
  const output = [];
  try {
    const testPackage = new URL("../node_modules/@playwright/test/index.mjs", import.meta.url).href;
    const cli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
    const reporter = fileURLToPath(new URL("../dashboard/playwright-reporter.js", import.meta.url));
    const configuration = join(directory, "playwright.config.mjs");
    writeFileSync(configuration, "export default { testDir: '.', testMatch: 'integration.spec.mjs' };");
    writeFileSync(join(directory, "integration.spec.mjs"),
      `import { test } from ${JSON.stringify(testPackage)};\n` +
      "test('local runner integration', async () => { await test.step('private input', async () => {}); });\n"
    );
    const handle = runPlaywrightTest(options(directory, "", {
      command: `"${process.execPath}" "${cli}" test --config="${configuration}" --reporter="${reporter}"`,
      timeoutMs: 15000,
      onOutput(_stream, text) { output.push(text); }
    }));
    const result = await handle.completion;
    assert.equal(result.status, "passed", output.join(""));
    assert.match(output.join(""), /FIXLAB_BROWSER_RESULT\|\{"total":1,"passed":1,"failed":0,"skipped":0\}/u);
    assert.doesNotMatch(output.join(""), /private input/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("background runner times out and stops its owned test process", async () => {
  const directory = fixture();
  let pid;
  try {
    const handle = runPlaywrightTest(options(directory,
      "console.log(process.pid); setInterval(() => {}, 1000);", {
        timeoutMs: 5000,
        onOutput(_stream, text) {
          const value = Number(text.trim());
          if (Number.isInteger(value) && value > 0) {
            pid = value;
          }
        }
      }
    ));
    const result = await handle.completion;
    assert.equal(result.status, "timed-out");
    assert.ok(pid);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("background runner cancellation is explicit and bounded", async () => {
  const directory = fixture();
  let handle;
  try {
    handle = runPlaywrightTest(options(directory,
      "console.log('ready'); setInterval(() => {}, 1000);", {
        onOutput(_stream, text) {
          if (text.includes("ready")) {
            handle.terminate();
          }
        }
      }
    ));
    assert.equal((await handle.completion).status, "cancelled");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("progress reporting omits input values and adds flags to standard profile commands", (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(line));
  const reporter = new PlaywrightProgressReporter();
  reporter.onBegin({}, { allTests: () => [{ outcome: () => "skipped" }] });
  reporter.onTestBegin();
  reporter.onStepBegin({}, {}, {
    title: 'locator.fill("private-value")', category: "pw:api"
  });
  reporter.onTestEnd({}, { status: "skipped" });
  reporter.onEnd({ status: "passed" });
  assert.doesNotMatch(logs.join("\n"), /private-value/u);
  assert.match(logs.join("\n"), /Browser step: locator.fill/u);
  assert.match(logs.join("\n"), /"skipped":1/u);
  assert.equal(withPlaywrightProgress("npm run test:e2e", "reporter.js"),
    'npm run test:e2e -- --reporter="reporter.js,html"');
  assert.equal(withPlaywrightProgress("npm run test:e2e -- --workers=1", "reporter.js"),
    'npm run test:e2e -- --workers=1 --reporter="reporter.js,html"');
  assert.equal(withPlaywrightProgress("node custom.cjs", "reporter.js"), "node custom.cjs");
});
