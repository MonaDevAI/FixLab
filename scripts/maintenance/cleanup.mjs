import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cleanupRoots = [
  ".fixlab/artifacts",
  ".fixlab/logs",
  "artifacts",
  "playwright-report",
  "test-results"
];

function parsePositiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return number;
}

export function findCleanupCandidates(
  root,
  maxAgeDays,
  maxItems = 100,
  now = Date.now()
) {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const candidates = [];

  for (const relativeRoot of cleanupRoots) {
    const directory = resolve(root, relativeRoot);
    if (!existsSync(directory)) {
      continue;
    }
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const details = lstatSync(path);
      if (!details.isSymbolicLink() && details.mtimeMs < cutoff) {
        candidates.push({ path, mtimeMs: details.mtimeMs });
      }
    }
  }
  return candidates
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .slice(0, maxItems)
    .map((candidate) => candidate.path);
}

export function cleanup({
  root,
  maxAgeDays,
  maxItems = 100,
  apply = false,
  now = Date.now()
}) {
  const candidates = findCleanupCandidates(root, maxAgeDays, maxItems, now);
  if (apply) {
    for (const candidate of candidates) {
      rmSync(candidate, { recursive: true, force: true });
    }
  }
  return {
    mode: apply ? "apply" : "dry-run",
    maxAgeDays,
    maxItems,
    candidates: candidates.map((candidate) => relative(root, candidate))
  };
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(argument("--root", process.cwd()));
  const maxAgeDays = parsePositiveNumber(
    argument("--max-age-days", "14"),
    "--max-age-days"
  );
  const maxItems = parsePositiveNumber(
    argument("--max-items", "100"),
    "--max-items"
  );
  const report = cleanup({
    root,
    maxAgeDays,
    maxItems,
    apply: process.argv.includes("--apply")
  });
  const reportPath = argument("--report");
  if (reportPath) {
    const resolvedReport = resolve(root, reportPath);
    mkdirSync(dirname(resolvedReport), { recursive: true });
    writeFileSync(resolvedReport, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report));
}
