import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const mode = process.argv[2];
if (!["--check", "--write"].includes(mode)) {
  throw new Error("usage: node scripts/ci/format.mjs --check|--write");
}

const root = process.cwd();
const roots = [
  ".github",
  "agents",
  "bin",
  "dashboard",
  "docs",
  "e2e",
  "examples",
  "mcp",
  "prompts",
  "reports",
  "scripts",
  "templates",
  "test"
];
const rootFiles = [
  ".editorconfig",
  ".env.example",
  ".gitignore",
  ".node-version",
  ".nvmrc",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "agency.json",
  "eslint.config.js",
  "tsconfig.json",
  "package-lock.json",
  "package.json",
  "playwright.config.js",
  "plugin.json",
  "skills-lock.json"
];
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".ts",
  ".yml",
  ".yaml"
]);

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(path);
    }
    return textExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

function normalize(content) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  return `${content
    .split(/\r?\n/u)
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join(newline)
    .replace(/(?:\r?\n)*$/u, "")}${newline}`;
}

const files = [
  ...rootFiles.map((name) => join(root, name)),
  ...roots.flatMap((name) => collectFiles(join(root, name)))
];
const changed = [];

for (const file of files) {
  const content = readFileSync(file, "utf8");
  const normalized = normalize(content);
  if (content === normalized) {
    continue;
  }
  changed.push(relative(root, file));
  if (mode === "--write") {
    writeFileSync(file, normalized);
  }
}

if (mode === "--check" && changed.length > 0) {
  console.error(`Formatting required:\n${changed.join("\n")}`);
  process.exit(1);
}

console.log(
  changed.length === 0
    ? "Formatting check passed."
    : `Formatted ${changed.length} file(s).`
);
