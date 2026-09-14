import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dayMilliseconds = 24 * 60 * 60 * 1000;

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function selectExpiredArtifacts(
  artifacts,
  { olderThanDays, maxItems, now = Date.now() }
) {
  const cutoff = now - olderThanDays * dayMilliseconds;
  return artifacts
    .filter((artifact) => Date.parse(artifact.created_at) < cutoff)
    .sort(
      (left, right) =>
        Date.parse(left.created_at) - Date.parse(right.created_at)
    )
    .slice(0, maxItems);
}

export async function cleanupGitHubArtifacts({
  repository,
  token,
  olderThanDays,
  maxItems,
  apply,
  fetchImpl = fetch,
  now = Date.now()
}) {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error("repository must use owner/name format");
  }
  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const artifacts = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/actions/artifacts?per_page=100&page=${page}`,
      { headers }
    );
    if (!response.ok) {
      throw new Error(
        `GitHub artifact listing failed: ${response.status} ${response.statusText}`
      );
    }
    const payload = await response.json();
    artifacts.push(...payload.artifacts);
    if (payload.artifacts.length < 100) {
      break;
    }
  }

  const candidates = selectExpiredArtifacts(artifacts, {
    olderThanDays,
    maxItems,
    now
  });
  const deleted = [];
  if (apply) {
    for (const artifact of candidates) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}`,
        { method: "DELETE", headers }
      );
      if (!response.ok) {
        throw new Error(
          `GitHub artifact deletion failed for ${artifact.id}: ${response.status} ${response.statusText}`
        );
      }
      deleted.push(artifact.id);
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    repository,
    olderThanDays,
    maxItems,
    scanned: artifacts.length,
    candidates: candidates.map(({ id, name, created_at }) => ({
      id,
      name,
      createdAt: created_at
    })),
    deleted
  };
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await cleanupGitHubArtifacts({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
    olderThanDays: positiveInteger(
      argument("--older-than-days", "30"),
      "--older-than-days"
    ),
    maxItems: positiveInteger(argument("--max-items", "20"), "--max-items"),
    apply: process.argv.includes("--apply")
  });
  const reportPath = argument("--report");
  if (reportPath) {
    const resolvedReport = resolve(reportPath);
    mkdirSync(dirname(resolvedReport), { recursive: true });
    writeFileSync(resolvedReport, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report));
}
