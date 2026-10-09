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

  onTestEnd(_test, result) {
    console.log(`Playwright test finished: ${result.status}.`);
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
