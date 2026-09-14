import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { checkDocumentation } from "../scripts/ci/check-docs.mjs";

const requiredFiles = [
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

function createDocumentationTree() {
  const root = mkdtempSync(join(tmpdir(), "fixlab-docs-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  for (const file of requiredFiles) {
    writeFileSync(
      join(root, file),
      file === "CONTRIBUTING.md"
        ? "Run `npm run validate`.\n"
        : "# Documentation\n"
    );
  }
  return root;
}

test("documentation policy accepts complete internal links", () => {
  const root = createDocumentationTree();
  try {
    writeFileSync(
      join(root, "README.md"),
      "# Documentation\n\n[Architecture](docs/architecture.md)\n"
    );
    assert.deepEqual(checkDocumentation(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("documentation policy reports broken relative links", () => {
  const root = createDocumentationTree();
  try {
    writeFileSync(
      join(root, "README.md"),
      "# Documentation\n\n[Missing](docs/missing.md)\n"
    );
    assert.match(
      checkDocumentation(root).join("\n"),
      /linked path does not exist/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
