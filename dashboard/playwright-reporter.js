import { basename } from "node:path";

export function browserFailure(test, error) {
  const message = String(error?.message ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "");
  const assertionTimeout = message.match(/Timed out (\d+)ms waiting for expect/u);
  const actionTimeout = message.match(/Timeout (\d+)ms exceeded/u);
  const location = message.match(/\.(?:spec|test)\.[cm]?[jt]sx?:(\d+):\d+/u);
  return {
    kind: assertionTimeout ? "assertion-timeout"
      : /browserType\.launch/u.test(message) ? "browser-launch"
        : actionTimeout ? "action-timeout" : "test-failure",
    file: test?.location?.file ? basename(test.location.file) : null,
    line: location ? Number(location[1]) : (test?.location?.line ?? null),
    timeoutMs: Number(assertionTimeout?.[1] ?? actionTimeout?.[1] ?? 0) || null
  };
}

export default class PlaywrightProgressReporter {
  constructor() {
    this.tests = [];
  }

  onBegin(_configuration, suite) {
    this.tests = suite.allTests();
    console.log(`Playwright discovered ${this.tests.length} test(s).`);
  }

  onTestBegin() {
    console.log("Playwright test starting.");
  }

  onStepBegin(_test, _result, step) {
    const action = step.title.match(/\b(?:locator|page|browser|expect)\.[A-Za-z]+/u)?.[0];
    console.log(`Browser step: ${action ?? step.category}`);
  }

  onTestEnd(test, result) {
    console.log(`Playwright test finished: ${result.status}.`);
    if (!["passed", "skipped"].includes(result.status)) {
      console.log(`FIXLAB_BROWSER_FAILURE|${JSON.stringify(
        browserFailure(test, result.errors?.[0] ?? result.error)
      )}`);
    }
  }

  onError() {
    console.log("Playwright reported an execution error; inspect the local report.");
  }

  onEnd(result) {
    const counts = { total: this.tests.length, passed: 0, failed: 0, skipped: 0 };
    for (const test of this.tests) {
      const outcome = test.outcome();
      const field = outcome === "skipped"
        ? "skipped"
        : ["expected", "flaky"].includes(outcome)
          ? "passed"
          : "failed";
      counts[field] += 1;
    }
    console.log(`Playwright suite finished: ${result.status}.`);
    console.log(`FIXLAB_BROWSER_RESULT|${JSON.stringify(counts)}`);
  }
}
