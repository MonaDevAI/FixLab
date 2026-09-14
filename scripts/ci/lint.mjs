import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const sourceRoots = ["bin", "dashboard", "scripts", "test"];
const supportedExtensions = new Set([".js", ".mjs"]);
const failures = [];

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(path);
    }
    return supportedExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

for (const directory of sourceRoots.map((name) => join(root, name))) {
  for (const file of collectFiles(directory)) {
    const displayPath = relative(root, file);
    const syntax = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8"
    });
    if (syntax.status !== 0) {
      failures.push(
        `${displayPath}: ${syntax.stderr.trim() || "syntax check failed"}`
      );
    }

    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/[ \t]+$/.test(line)) {
        failures.push(`${displayPath}:${index + 1}: trailing whitespace`);
      }
    });
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Lint passed.");
