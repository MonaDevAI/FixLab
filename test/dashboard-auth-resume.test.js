import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("the live test is retried only after successful authentication", () => {
  const start = appSource.indexOf("async function resumeAfterConnect");
  const body = appSource.slice(
    start,
    appSource.indexOf("async function refreshPlaywrightStatus")
  );
  assert.match(body, /status\.running/u);
  assert.match(body, /if \(!result\.ok\)/u);
  assert.match(body, /activeJob\?\.id === jobId/u);
  assert.match(body, /activeJob\.status === "blocked"/u);
  assert.ok(
    body.indexOf("if (!result.ok)") < body.indexOf("await retryLiveTest()")
  );
});
