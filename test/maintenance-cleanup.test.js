import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { cleanup } from "../scripts/maintenance/cleanup.mjs";
import {
  cleanupGitHubArtifacts,
  selectExpiredArtifacts
} from "../scripts/maintenance/cleanup-github-artifacts.mjs";

test("cleanup removes only expired entries from allowlisted roots", () => {
  const root = mkdtempSync(join(tmpdir(), "fixlab-cleanup-"));
  const artifactRoot = join(root, "artifacts");
  const oldDirectory = join(artifactRoot, "old-job");
  const recentDirectory = join(artifactRoot, "recent-job");

  try {
    mkdirSync(oldDirectory, { recursive: true });
    mkdirSync(recentDirectory, { recursive: true });
    writeFileSync(join(oldDirectory, "result.json"), "{}");
    writeFileSync(join(recentDirectory, "result.json"), "{}");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(oldDirectory, oldTime, oldTime);

    const preview = cleanup({ root, maxAgeDays: 14 });
    assert.deepEqual(preview.candidates, [join("artifacts", "old-job")]);
    assert.equal(existsSync(oldDirectory), true);

    const applied = cleanup({ root, maxAgeDays: 14, apply: true });
    assert.deepEqual(applied.candidates, [join("artifacts", "old-job")]);
    assert.equal(existsSync(oldDirectory), false);
    assert.equal(existsSync(recentDirectory), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup ignores similarly named paths outside allowlisted roots", () => {
  const root = mkdtempSync(join(tmpdir(), "fixlab-cleanup-"));
  const protectedDirectory = join(root, "source-artifacts", "old-job");

  try {
    mkdirSync(protectedDirectory, { recursive: true });
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(protectedDirectory, oldTime, oldTime);

    assert.deepEqual(cleanup({ root, maxAgeDays: 14 }).candidates, []);
    assert.equal(existsSync(protectedDirectory), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub artifact cleanup selects oldest expired items within its cap", () => {
  const now = Date.parse("2026-09-14T00:00:00Z");
  const selected = selectExpiredArtifacts(
    [
      { id: 3, name: "recent", created_at: "2026-09-10T00:00:00Z" },
      { id: 2, name: "older", created_at: "2026-07-01T00:00:00Z" },
      { id: 1, name: "oldest", created_at: "2026-06-01T00:00:00Z" }
    ],
    { olderThanDays: 30, maxItems: 1, now }
  );

  assert.deepEqual(selected.map((artifact) => artifact.id), [1]);
});

test("GitHub artifact cleanup deletes only selected artifact IDs", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method ?? "GET" });
    if (!options.method) {
      return {
        ok: true,
        async json() {
          return {
            artifacts: [
              { id: 11, name: "old", created_at: "2026-06-01T00:00:00Z" },
              { id: 12, name: "recent", created_at: "2026-09-10T00:00:00Z" }
            ]
          };
        }
      };
    }
    return { ok: true };
  };

  const report = await cleanupGitHubArtifacts({
    repository: "MonaDevAI/FixLab",
    token: "test-token",
    olderThanDays: 30,
    maxItems: 20,
    apply: true,
    fetchImpl,
    now: Date.parse("2026-09-14T00:00:00Z")
  });

  assert.deepEqual(report.deleted, [11]);
  assert.deepEqual(
    requests.filter((request) => request.method === "DELETE"),
    [
      {
        url: "https://api.github.com/repos/MonaDevAI/FixLab/actions/artifacts/11",
        method: "DELETE"
      }
    ]
  );
});
