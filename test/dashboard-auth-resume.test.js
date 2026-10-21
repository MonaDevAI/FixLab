import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const appSource = readFileSync(
  new URL("../dashboard/public/app.js", import.meta.url),
  "utf8"
);

test("blocked live tests offer connect-then-retry", () => {
  assert.match(appSource, /connect-and-retry-live-test/u);
  assert.match(
    appSource,
    /connectRetryLiveTestButton\.hidden = !canRetryLiveTest/u
  );
});

test("connect-then-retry starts the profile authentication through the API", () => {
  const handler = appSource.slice(
    appSource.indexOf("connectRetryLiveTestButton.addEventListener")
  );
  assert.match(handler, /\/api\/playwright\/connect/u);
  assert.match(handler, /method: "POST"/u);
});

test("connecting Playwright starts the frontend first", () => {
  for (const marker of [
    'playwrightConnect.addEventListener("click"',
    'connectRetryLiveTestButton.addEventListener("click"'
  ]) {
    const handler = appSource.slice(appSource.indexOf(marker));
    assert.ok(
      handler.indexOf("await startFrontend()") <
        handler.indexOf("/api/playwright/connect"),
      marker
    );
  }
  assert.match(appSource, /\/api\/frontend\/start/u);
});

test("the live test is retried only after successful authentication", async () => {
  const start = appSource.indexOf("async function resumeAfterConnect");
  const body = appSource.slice(
    start,
    appSource.indexOf("\nfunction renderFrontendStatus", start)
  );
  assert.ok(start >= 0 && body.includes("await retryLiveTest()"));
  for (const scenario of [
    { running: true, ready: true, ok: true, expected: 0, pending: "job" },
    { ready: true, ok: false, expected: 0 },
    { ready: false, ok: true, expected: 0 },
    { ready: true, ok: true, jobId: "other", expected: 0 },
    { ready: true, ok: true, jobStatus: "completed", expected: 0 },
    { ready: true, ok: true, expected: 1 }
  ]) {
    let retries = 0;
    const context = {
      pendingRetryAfterConnectJobId: "job",
      activeJob: {
        id: scenario.jobId ?? "job",
        status: scenario.jobStatus ?? "blocked"
      },
      formError: { textContent: "" },
      retryLiveTest: async () => {
        retries += 1;
      }
    };
    const resume = runInNewContext(`(${body})`, context);
    await resume({
      running: scenario.running ?? false,
      ready: scenario.ready,
      lastResult: { ok: scenario.ok, message: "Authentication finished." }
    });
    assert.equal(retries, scenario.expected, JSON.stringify(scenario));
    assert.equal(
      context.pendingRetryAfterConnectJobId,
      scenario.pending ?? null
    );
    if (!scenario.ok || !scenario.ready) {
      assert.match(context.formError.textContent, /readiness is unverified/u);
    }
  }
});
