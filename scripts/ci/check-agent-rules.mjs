import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkAgentRules(root) {
  const failures = [];
  const configPath = resolve(root, ".github", "copilot-code-review.yml");
  if (!existsSync(configPath)) {
    return [".github/copilot-code-review.yml is missing"];
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const corpusPath = resolve(root, config.corpus ?? "");
  if (!existsSync(corpusPath)) {
    failures.push(`learned-rule corpus is missing: ${config.corpus ?? ""}`);
    return failures;
  }

  const corpus = readFileSync(corpusPath, "utf8");
  for (const heading of [
    "# Active learned rules",
    "# Candidate rules",
    "# Retired rules"
  ]) {
    if (!corpus.includes(heading)) {
      failures.push(`learned-rule corpus is missing section: ${heading}`);
    }
  }

  const activeSection =
    corpus.split("# Active learned rules")[1]?.split("# Candidate rules")[0] ??
    "";
  const activeRules = [...activeSection.matchAll(/^## /gmu)].length;
  const maximumActiveRules = config.promotion?.maximumActiveRules;
  if (
    !Number.isInteger(maximumActiveRules) ||
    maximumActiveRules < 1 ||
    activeRules > maximumActiveRules
  ) {
    failures.push(
      `active learned rules (${activeRules}) exceed or lack a valid configured cap`
    );
  }
  if ((config.promotion?.minimumDistinctRuns ?? 0) < 2) {
    failures.push("rule promotion must require at least two distinct runs");
  }
  return failures;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkAgentRules(process.cwd());
  const reportPath = argument("--report");
  if (reportPath) {
    const resolvedReport = resolve(process.cwd(), reportPath);
    mkdirSync(dirname(resolvedReport), { recursive: true });
    writeFileSync(
      resolvedReport,
      `${JSON.stringify({ failures }, null, 2)}\n`
    );
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Agent learned-rule governance check passed.");
}
