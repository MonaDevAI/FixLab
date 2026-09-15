import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fullCommit = /^[0-9a-f]{40}$/u;

function read(root, relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function usesReferences(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)].map(
    (match) => match[1]
  );
}

export function checkPolicy(root) {
  const failures = [];
  const policyPath = resolve(root, ".github", "branch-protection.yml");
  if (!existsSync(policyPath)) {
    return [".github/branch-protection.yml is missing"];
  }

  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    return [`.github/branch-protection.yml is not valid JSON-compatible YAML: ${error.message}`];
  }

  if (policy.targetBranch !== "main") {
    failures.push("branch policy must target main");
  }
  const checks = new Set(policy.requiredStatusChecks ?? []);
  for (const requiredCheck of ["test", "analyze"]) {
    if (!checks.has(requiredCheck)) {
      failures.push(`branch policy is missing required check: ${requiredCheck}`);
    }
  }
  if ((policy.pullRequest?.requiredApprovingReviews ?? 0) < 1) {
    failures.push("branch policy must require at least one approving review");
  }
  if (policy.pullRequest?.dismissStaleApprovals !== true) {
    failures.push("branch policy must dismiss stale approvals");
  }
  if (policy.pullRequest?.requireCodeOwnerReview !== true) {
    failures.push("branch policy must require code-owner review");
  }
  if (policy.pullRequest?.requireReviewThreadResolution !== true) {
    failures.push("branch policy must require review-thread resolution");
  }
  if (policy.history?.requireLinearHistory !== true) {
    failures.push("branch policy must require linear history");
  }
  if (
    policy.history?.blockDeletion !== true ||
    policy.history?.blockForcePush !== true
  ) {
    failures.push("branch policy must block deletion and force pushes");
  }

  const workflowRoot = resolve(root, ".github", "workflows");
  for (const entry of readdirSync(workflowRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) {
      continue;
    }
    const workflow = readFileSync(join(workflowRoot, entry.name), "utf8");
    for (const reference of usesReferences(workflow)) {
      if (reference.startsWith("./")) {
        continue;
      }
      const separator = reference.lastIndexOf("@");
      const revision = separator >= 0 ? reference.slice(separator + 1) : "";
      if (!fullCommit.test(revision)) {
        failures.push(`${entry.name} uses an unpinned action: ${reference}`);
      }
    }
  }

  const ci = read(root, ".github/workflows/ci.yml");
  if (!ci.includes("npm run policy:check")) {
    failures.push("CI must enforce npm run policy:check");
  }
  if (!ci.includes("npm run self-healing:verify")) {
    failures.push("CI must enforce npm run self-healing:verify");
  }

  const selfHealing = read(
    root,
    ".github/workflows/self-healing-rollback.yml"
  );
  for (const signal of [
    "propose-rollback",
    "git apply --reverse --index",
    "last_good_sha",
    "gh pr create",
    "github.event.workflow_run.event == 'push'"
  ]) {
    if (!selfHealing.includes(signal)) {
      failures.push(`self-healing workflow is missing rollback control: ${signal}`);
    }
  }

  const vscodeAgent = resolve(
    root,
    ".github",
    "agents",
    "fixlab-autofix.agent.md"
  );
  if (!existsSync(vscodeAgent)) {
    failures.push("the versioned VS Code autofix agent is missing");
  }

  return failures;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkPolicy(process.cwd());
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
  console.log("Repository policy check passed.");
}
