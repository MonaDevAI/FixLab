import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requiredMarkdownFiles = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/commands.md",
  "docs/getting-started.md",
  "docs/installation.md",
  "docs/releasing.md",
  "docs/repository-onboarding.md",
  "docs/security.md",
  "docs/team-rollout.md"
];

function findMarkdownFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", ".fixlab", "artifacts", "node_modules"].includes(entry.name)) {
      return [];
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return findMarkdownFiles(root, path);
    }
    return entry.name.endsWith(".md") ? [relative(root, path)] : [];
  });
}

export function checkDocumentation(root) {
  const failures = [];
  for (const relativePath of requiredMarkdownFiles) {
    const file = join(root, relativePath);
    if (!existsSync(file)) {
      failures.push(`${relativePath}: required documentation is missing`);
    }
  }

  for (const relativePath of findMarkdownFiles(root)) {
    const file = join(root, relativePath);
    const content = readFileSync(file, "utf8");
    const targets = [
      ...[...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map(
        (match) => match[1]
      ),
      ...[
        ...content.matchAll(
          /<(?:a|img)\s+[^>]*(?:href|src)="([^"]+)"[^>]*>/giu
        )
      ].map((match) => match[1])
    ];
    for (const rawTarget of targets) {
      const target = rawTarget.trim().split("#", 1)[0];
      if (
        !target ||
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:")
      ) {
        continue;
      }
      const resolved = isAbsolute(target)
        ? target
        : resolve(dirname(file), target);
      if (!existsSync(resolved)) {
        failures.push(
          `${relativePath}: linked path does not exist: ${target}`
        );
      }
    }
  }

  const contributing = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
  if (!contributing.includes("npm run validate")) {
    failures.push(
      "CONTRIBUTING.md: must document the npm run validate completion gate"
    );
  }

  return failures;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const failures = checkDocumentation(root);
  const filesChecked = findMarkdownFiles(root).length;
  const reportPath = readArgument("--report");
  if (reportPath) {
    const resolvedReport = resolve(root, reportPath);
    mkdirSync(dirname(resolvedReport), { recursive: true });
    writeFileSync(
      resolvedReport,
      `${JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          filesChecked,
          failures
        },
        null,
        2
      )}\n`
    );
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(
    `Documentation drift check passed (${filesChecked} files).`
  );
}
