import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function classifyAttempts(firstStatus, secondStatus = null) {
  if (firstStatus === 0) {
    return { status: "passed", attempts: 1, exitCode: 0 };
  }
  if (secondStatus === 0) {
    return { status: "flaky-contained", attempts: 2, exitCode: 1 };
  }
  return { status: "failed", attempts: 2, exitCode: 1 };
}

function runTests(reportPath) {
  return spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=junit",
      `--test-reporter-destination=${reportPath}`
    ],
    {
      encoding: "utf8"
    }
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifactDirectory = join(process.cwd(), "artifacts");
  mkdirSync(artifactDirectory, { recursive: true });

  const first = runTests(join(artifactDirectory, "test-results-attempt-1.xml"));
  let second = null;
  if (first.status !== 0) {
    console.error("Initial test run failed; running one bounded confirmation.");
    second = runTests(
      join(artifactDirectory, "test-results-attempt-2.xml")
    );
  }

  const result = classifyAttempts(first.status, second?.status);
  writeFileSync(
    join(artifactDirectory, "test-signal.json"),
    `${JSON.stringify(
      {
        ...result,
        firstError: first.error?.message ?? null,
        secondError: second?.error?.message ?? null
      },
      null,
      2
    )}\n`
  );

  if (result.status === "flaky-contained") {
    console.error(
      "The confirmation passed, but CI remains failed so a flaky test cannot be hidden."
    );
  } else if (result.status === "failed") {
    console.error("Tests failed in both bounded attempts.");
  } else {
    console.log("Tests passed on the initial attempt.");
  }

  process.exit(result.exitCode);
}
