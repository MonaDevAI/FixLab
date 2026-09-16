import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";
import {
  createAzureDevOpsLoader,
  loadRepositoryProfile,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_TOTAL_BYTES,
  MAX_SCREENSHOTS,
  pruneArtifactDirectories,
  removeArtifactDirectory,
  storeScreenshots
} from "./intake.js";

export const DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 4317;
export const MAX_JOB_LOG_ENTRIES = 1000;
export const MAX_CACHE_ENTRIES = 20;
export const MAX_CACHE_BYTES = 64 * 1024;
export const MAX_METRICS_ENTRIES = 500;
export const MAX_QUEUED_JOBS = 20;
export const MAX_PLAYWRIGHT_ARTIFACTS = 20;
export const FIXLAB_RUNTIMES = ["agency", "copilot"];
export const FIXLAB_STAGES = [
  "intake",
  "diagnosis",
  "reproduce",
  "fix",
  "review",
  "local-stack",
  "live-test",
  "pr"
];

const terminalStatuses = new Set(["passed", "skipped", "blocked", "failed"]);
const allStatuses = new Set(["pending", "running", ...terminalStatuses]);
const bugOutcomeStatuses = new Set([
  "fixed",
  "already-fixed",
  "external",
  "no-change",
  "expected",
  "duplicate",
  "blocked",
  "failed"
]);
const profileRelativePath = join(
  ".github",
  "fixlab",
  "repository-profile.json"
);
const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"]
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

export function validatePort(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error("dashboard port must be an integer between 1 and 65535");
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("dashboard port must be an integer between 1 and 65535");
  }
  return port;
}

function publicQueue(jobs) {
  return jobs.map((job, index) => ({
    id: job.id,
    position: index + 1,
    request: safeSummary(job.request),
    requestType: job.requestType,
    intakeSource: job.intakeSource,
    mode: job.mode,
    status: job.status,
    bugCount: job.bugs.length,
    bugs: job.bugs,
    screenshotCount: job.screenshots.length,
    stages: job.stages,
    createdAt: job.createdAt
  }));
}

function publicHistory(jobs) {
  return jobs.map((job) => ({
    ...publicJob(job),
    logs: []
  }));
}

export function inspectRepository(repository) {
  const resolvedRepository = resolve(repository);
  pruneArtifactDirectories(resolvedRepository);
  if (
    !existsSync(resolvedRepository) ||
    !statSync(resolvedRepository).isDirectory()
  ) {
    return {
      repository: resolvedRepository,
      repositoryReady: false,
      profileReady: false,
      profilePath: join(resolvedRepository, profileRelativePath),
      profileName: null,
      error: "repository does not exist or is not a directory"
    };
  }

  const profilePath = join(resolvedRepository, profileRelativePath);
  if (!existsSync(profilePath)) {
    return {
      repository: resolvedRepository,
      repositoryReady: true,
      profileReady: false,
      profilePath,
      profileName: null,
      error: "repository profile is missing; run fixlab init"
    };
  }

  try {
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("profile root must be a JSON object");
    }
    return {
      repository: resolvedRepository,
      repositoryReady: true,
      profileReady: true,
      profilePath,
      profileName:
        typeof profile.name === "string" && profile.name.trim()
          ? profile.name.trim()
          : null,
      error: null
    };
  } catch (error) {
    return {
      repository: resolvedRepository,
      repositoryReady: true,
      profileReady: false,
      profilePath,
      profileName: null,
      error: `repository profile is invalid JSON: ${error.message}`
    };
  }
}

export function buildJobPrompt({
  request,
  mode,
  requestType = "bug-fix",
  cacheSummary = null,
  intakeSource = "manual",
  workItem = null,
  workItems = [],
  screenshotPaths = []
}) {
  const validateOnly = mode === "validate-only";
  const playwrightOnly = mode === "playwright-only";
  const readOnly = validateOnly || playwrightOnly;
  const smallEnhancement = requestType === "small-enhancement";
  const intakeWorkItems =
    workItems.length > 0 ? workItems : workItem ? [workItem] : [];
  const intakeSummary = intakeWorkItems.map(
    ({
      id,
      title,
      state,
      workItemType,
      webUrl,
      comments,
      commentsWarning
    }) => ({
      id,
      title,
      state,
      workItemType,
      webUrl,
      commentCount: comments.length,
      commentsWarning
    })
  );
  const bugResults = extractBugResults(request, intakeWorkItems);
  const requestGuidance = playwrightOnly
    ? `- Use the request only to select the relevant repository-defined Playwright journey and expected behavior.
- Perform only the minimum setup required by the repository profile: verify browser authentication, start required applications, and run the focused Playwright journey.
- Do not diagnose source code, reproduce through separate non-browser checks, review a diff, run unrelated tests, type-checks, or builds, or inspect implementation files unless the Playwright journey cannot be selected or started without that bounded information.
- Preserve exact browser results, screenshots, traces, skipped gates, blockers, and remaining risks.`
    : smallEnhancement
    ? `- Generate a concise acceptance contract before changing code.
- Check the affected surface and bound the file scope before editing.
- Do not manufacture a failing defect reproduction. Use the smallest existing focused test that proves the acceptance contract.
- Skip broad test suites and full builds unless the repository profile requires them or user-visible/risk evidence makes them necessary.
- Preserve review, live-test, and pull-request evidence, and make no unrelated changes.`
    : `- Generate a concise fix contract from the reported behavior and expected outcome.
- Diagnose and reproduce with repository evidence. Do not claim a cause or reproduction without evidence.
- Use the smallest focused reproduction that demonstrates the reported defect.`;
  return `Run a FixLab ${mode} job.
Request type: ${requestType}
Intake source: ${intakeSource}
${intakeSummary.length > 0 ? `Loaded Azure DevOps selection:
${JSON.stringify(intakeSummary, null, 2)}
The bounded bug evidence is included in the request below.
` : ""}
${screenshotPaths.length > 0 ? `User-provided screenshots stored locally for this job:
${screenshotPaths.map((path) => `- ${path}`).join("\n")}
Inspect only these local files. Do not search for or download additional Azure DevOps attachments.
` : ""}
${cacheSummary ? `
Verified same-repository cache summary for the current HEAD and profile:
${JSON.stringify(cacheSummary, null, 2)}
Use this concise metadata only to avoid repeated discovery. Verify task-specific facts against the current diff and relevant files; do not treat it as source evidence.
` : ""}

Repository requirements:
- Read .github/fixlab/repository-profile.json and all repository-owned instructions before acting.
- For repeat work, inspect the current git status and effective diff first, then search task-relevant symbols and files instead of rescanning the whole repository.
- Do not perform a whole-repository rescan when the current diff, cached metadata, and focused symbol/path searches are sufficient.
- Reuse this job/session context. Do not reread unchanged files, repeat completed diagnosis, reinstall available dependencies, or rerun broad checks without new evidence.
- Treat commit changes and repository-profile or instruction changes as invalidation boundaries: reread affected context when they change.
${requestGuidance}
- ${readOnly ? "Do not edit files, create commits, push branches, create pull requests, or update pull requests." : "Make the smallest complete change that resolves the request. Make no code change when the evidence shows none is required."}
- Autonomously complete the lifecycle without asking the user to direct routine engineering steps.
- ${playwrightOnly ? "Skip source diagnosis, separate reproduction, implementation, diff review, and non-browser validation. Mark diagnosis, reproduce, fix, and review skipped with the reason Playwright-only mode was selected." : "Inspect the affected surface, implement the smallest required code when edits are allowed, and self-review the effective diff for correctness, scope, and unrelated changes."}
- ${playwrightOnly ? "Run only setup commands strictly required to launch the profile-defined applications and focused Playwright journey. Do not reinstall dependencies that are already available." : "Run the focused repository-owned tests, type-checks, and builds needed for the affected surface and risk. Preserve exact results."}
- Start only the applications defined by the repository profile, then execute the repository-defined live test against the allowed required system or environment from that profile. Do not invent or hardcode environment choices.
- For every Playwright live test, save at least one non-sensitive screenshot under the test's repository-owned test-results directory so the dashboard can display the browser evidence.
- ${playwrightOnly ? "Collect evidence for required setup, authentication readiness, application startup, the focused Playwright result, skipped gates, blockers, and remaining risks." : "Collect evidence for diagnosis or surface inspection, the effective diff, review, local validation, application startup, live testing, skipped gates, and remaining risks."}
- ${readOnly ? "Report the pull-request outcome without creating or updating a pull request." : "Create or update the pull request only after all required gates pass, and include the collected evidence."}
- Human interaction is limited to authentication, unsafe-data approval, deployment or pull-request approval, and genuine blockers that cannot be resolved from repository evidence.
- When one of those human actions is required, emit FIXLAB_STAGE|stage|blocked|exact action needed, emit blocked outcomes for affected bugs when applicable, mark later stages skipped because of the blocker, and exit. The dashboard will collect user input and resume this same session.
- Keep stage messages and retained logs concise. Summarize relevant command evidence and preserve exact errors, but do not feed unbounded raw output back into prompts.
- Keep all execution local unless the repository profile and existing authorization explicitly require an allowed external action.
- For every Azure DevOps bug listed below, emit one terminal outcome line before finishing:
  FIXLAB_BUG|id|outcome|owner|summary
- These bug lines are required machine-readable output, not optional narrative. Emit each line as soon as its diagnosis is final and before the terminal pr stage.
- outcome must be one of: ${[...bugOutcomeStatuses].join(", ")}.
- owner must identify the responsible boundary, such as FMDM, MDG, data, deployment, or unknown.
- Use outcome external with owner MDG when FMDM correctly surfaces an error returned by MDG and no FMDM code correction is required.
- Do not create an empty pull request. When every bug is external, no-change, expected, duplicate, or already-fixed, explicitly skip the fix and pr stages and explain the per-bug outcomes.
- The expected bug IDs for this request are: ${bugResults.length > 0 ? bugResults.map((bug) => bug.id).join(", ") : "none detected; no FIXLAB_BUG marker is required"}.
- Emit exactly one or more progress lines in this format:
  FIXLAB_STAGE|stage|status|message
- Write every FIXLAB_STAGE and FIXLAB_BUG marker as a literal plain-text assistant response line. Never generate markers through shell, Write-Output, echo, files, tools, code blocks, or tables because runtime rendering may hide them from the dashboard.
- stage must be one of: ${FIXLAB_STAGES.join(", ")}.
- status must be pending, running, passed, skipped, blocked, or failed.
- Before finishing, emit a terminal passed, skipped, blocked, or failed marker for every stage. Never imply an unmarked stage passed.
- Do not call task_complete or return the final response until every expected FIXLAB_BUG line and every terminal FIXLAB_STAGE line has been emitted.
- Preserve exact command errors in the stage message or adjacent output.
${validateOnly ? "- The fix and pr stages must be explicitly skipped unless they fail for another reason." : ""}
${playwrightOnly ? "- The diagnosis, reproduce, fix, review, and pr stages must be explicitly skipped unless a required setup or browser-validation blocker makes the applicable stage blocked or failed." : ""}

Request:
${request}`;
}

function extractBugResults(request, workItems = []) {
  const bugs = new Map();
  const lines = String(request ?? "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^Azure DevOps Bug (\d+):\s*(.+)$/i);
    if (!match) {
      continue;
    }
    const nextLine = lines[index + 1]?.trim() ?? "";
    const url = nextLine.match(/^URL:\s*(https:\/\/dev\.azure\.com\/\S+)$/i);
    bugs.set(match[1], {
      id: match[1],
      title: safeSummary(match[2]),
      url: url?.[1] ?? "",
      outcome: "pending",
      owner: "",
      summary: ""
    });
  }
  for (const workItem of workItems) {
    if (workItem?.id && !bugs.has(String(workItem.id))) {
      bugs.set(String(workItem.id), {
        id: String(workItem.id),
        title: safeSummary(workItem.title),
        url: workItem.webUrl ?? "",
        outcome: "pending",
        owner: "",
        summary: ""
      });
    }
  }
  return [...bugs.values()];
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function safeSummary(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (
    /(?:password|passwd|secret|token|authorization|bearer|cookie|connection.?string|private.?key|client.?secret|dashboard[-\\/]+artifacts)/i.test(
      text
    )
  ) {
    return "[omitted potentially sensitive summary]";
  }
  return text;
}

function parseTokenCount(value) {
  const match = String(value).trim().match(/^([\d.]+)\s*([kmb]?)$/i);
  if (!match) {
    return null;
  }
  const multiplier = {
    "": 1,
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000
  }[match[2].toLowerCase()];
  const count = Number(match[1]) * multiplier;
  return Number.isFinite(count) ? Math.round(count) : null;
}

function parseUsageLine(line) {
  const match = line.match(
    /Tokens\s+↑\s*([\d.]+\s*[kmb]?)\s+\(([\d.]+\s*[kmb]?)\s+cached,\s*([\d.]+\s*[kmb]?)\s+written\)\s+•\s+↓\s*([\d.]+\s*[kmb]?)/i
  );
  if (!match) {
    return null;
  }
  const values = match.slice(1).map(parseTokenCount);
  if (values.some((value) => value === null)) {
    return null;
  }
  const [inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens] =
    values;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    cacheReusePercent:
      inputTokens > 0
        ? Math.round((cachedInputTokens / inputTokens) * 1000) / 10
        : 0
  };
}

function readMetrics(path) {
  if (!path || !existsSync(path)) {
    return { records: [], warning: null };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value?.jobs)) {
      throw new Error("metrics history has an invalid shape");
    }
    return {
      records: value.jobs.slice(-MAX_METRICS_ENTRIES),
      warning: null
    };
  } catch {
    return {
      records: [],
      warning:
        "The existing dashboard metrics history could not be read and was ignored."
    };
  }
}

function updateJobMetrics(records, job) {
  const record = {
    id: job.id,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    status: job.status,
    bugCount: job.bugs.length,
    durationMs: job.finishedAt
      ? Math.max(
          0,
          Date.parse(job.finishedAt) -
            Date.parse(job.startedAt ?? job.createdAt)
        )
      : null,
    queueWaitMs: job.startedAt
      ? Math.max(0, Date.parse(job.startedAt) - Date.parse(job.createdAt))
      : null,
    ...job.usage
  };
  const next = [
    ...records.filter((candidate) => candidate.id !== job.id),
    record
  ].slice(-MAX_METRICS_ENTRIES);
  return next;
}

function writeMetrics(path, records) {
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({ version: 1, jobs: records }),
    { mode: 0o600 }
  );
  renameSync(temporaryPath, path);
}

function summarizeMetrics(records, period) {
  const durations = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000
  };
  const cutoff = durations[period] ? Date.now() - durations[period] : 0;
  const selected = records.filter(
    (record) => Date.parse(record.createdAt) >= cutoff
  );
  const completed = selected.filter((record) => record.finishedAt);
  const usageJobs = completed.filter(
    (record) => Number.isFinite(record.inputTokens) && record.inputTokens > 0
  );
  const totalInputTokens = usageJobs.reduce(
    (total, record) => total + record.inputTokens,
    0
  );
  const totalCachedInputTokens = usageJobs.reduce(
    (total, record) => total + record.cachedInputTokens,
    0
  );
  return {
    period,
    queued: selected.length,
    completed: completed.length,
    passed: completed.filter((record) => record.status === "passed").length,
    failed: completed.filter((record) => record.status === "failed").length,
    blocked: completed.filter((record) => record.status === "blocked").length,
    bugs: selected.reduce((total, record) => total + record.bugCount, 0),
    averageDurationMs:
      completed.length > 0
        ? Math.round(
            completed.reduce(
              (total, record) => total + (record.durationMs ?? 0),
              0
            ) / completed.length
          )
        : null,
    usageJobs: usageJobs.length,
    totalInputTokens,
    totalCachedInputTokens,
    totalCacheWriteTokens: usageJobs.reduce(
      (total, record) => total + record.cacheWriteTokens,
      0
    ),
    totalOutputTokens: usageJobs.reduce(
      (total, record) => total + record.outputTokens,
      0
    ),
    cacheReusePercent:
      totalInputTokens > 0
        ? Math.round((totalCachedInputTokens / totalInputTokens) * 1000) / 10
        : null
  };
}

export function createCacheContext(repository) {
  try {
    const profilePath = join(repository, profileRelativePath);
    if (!existsSync(profilePath)) {
      return null;
    }
    const commonGitDirectory = runGit(repository, [
      "rev-parse",
      "--git-common-dir"
    ]);
    const head = runGit(repository, ["rev-parse", "HEAD"]);
    if (!commonGitDirectory || !head) {
      return null;
    }

    const gitDirectoryPath = isAbsolute(commonGitDirectory)
      ? commonGitDirectory
      : resolve(repository, commonGitDirectory);
    const repositoryIdentity = realpathSync.native(gitDirectoryPath);
    const profileContent = readFileSync(profilePath);
    const profile = JSON.parse(profileContent.toString("utf8"));
    const profileSummary = {
      name: safeSummary(profile.name ?? ""),
      sections: Object.keys(profile).sort().slice(0, 30),
      applications: Object.keys(profile.applications ?? {})
        .sort()
        .slice(0, 30)
    };
    const profileHash = hash(profileContent);
    return {
      key: hash(`${repositoryIdentity}\0${head}\0${profileHash}`),
      repositoryIdentityHash: hash(repositoryIdentity),
      head,
      profileHash,
      profileSummary,
      cachePath: join(gitDirectoryPath, "fixlab", "dashboard-cache.json")
    };
  } catch {
    return null;
  }
}

function readCache(cachePath) {
  if (!existsSync(cachePath)) {
    return { version: 1, entries: [] };
  }
  try {
    const content = readFileSync(cachePath);
    if (content.length > MAX_CACHE_BYTES) {
      return { version: 1, entries: [] };
    }
    const cache = JSON.parse(content.toString("utf8"));
    if (cache?.version !== 1 || !Array.isArray(cache.entries)) {
      return { version: 1, entries: [] };
    }
    return cache;
  } catch {
    return { version: 1, entries: [] };
  }
}

export function loadCacheSummary(context) {
  if (!context) {
    return null;
  }
  const cache = readCache(context.cachePath);
  const entry = cache.entries.find((candidate) => candidate.key === context.key);
  if (!entry) {
    return null;
  }
  return {
    profile: entry.profile,
    priorJob: entry.priorJob
  };
}

function writeCacheSummary(context, job) {
  if (!context) {
    return;
  }
  try {
    const cache = readCache(context.cachePath);
    const entry = {
      key: context.key,
      repositoryIdentityHash: context.repositoryIdentityHash,
      head: context.head,
      profileHash: context.profileHash,
      updatedAt: new Date().toISOString(),
      profile: context.profileSummary,
      priorJob: {
        result: job.status,
        mode: job.mode,
        requestType: job.requestType,
        stages: Object.fromEntries(
          FIXLAB_STAGES.map((stage) => [
            stage,
            {
              status: job.stages[stage].status,
              summary: safeSummary(job.stages[stage].message)
            }
          ])
        )
      }
    };
    cache.entries = [
      entry,
      ...cache.entries.filter((candidate) => candidate.key !== context.key)
    ].slice(0, MAX_CACHE_ENTRIES);

    mkdirSync(dirname(context.cachePath), { recursive: true });
    let content = JSON.stringify(cache);
    while (
      Buffer.byteLength(content) > MAX_CACHE_BYTES &&
      cache.entries.length > 1
    ) {
      cache.entries.pop();
      content = JSON.stringify(cache);
    }
    if (Buffer.byteLength(content) > MAX_CACHE_BYTES) {
      return;
    }
    writeFileSync(context.cachePath, content, { mode: 0o600 });
  } catch {
    // Cache reuse is an optimization and must never change the job outcome.
  }
}

export function buildAgencyInvocation({
  packageRoot,
  prompt,
  sessionId,
  resume = false
}) {
  if (!sessionId) {
    throw new Error("Agency invocation requires a session ID");
  }
  return {
    args: [
      "copilot",
      "--plugin-dir",
      packageRoot,
      "--agent",
      "fixlab:fixlab",
      "--allow-all-tools",
      "--no-ask-user",
      "--stream",
      "on",
      ...(resume ? [`--resume=${sessionId}`] : ["--session-id", sessionId])
    ],
    input: prompt
  };
}

export function buildCopilotInvocation({
  packageRoot,
  prompt,
  sessionId,
  resume = false
}) {
  if (!sessionId) {
    throw new Error("Copilot invocation requires a session ID");
  }
  return {
    args: [
      "--plugin-dir",
      packageRoot,
      "--agent",
      "fixlab:fixlab",
      "--allow-all-tools",
      "--no-ask-user",
      "--autopilot",
      "--stream",
      "on",
      ...(resume ? [`--resume=${sessionId}`] : ["--session-id", sessionId])
    ],
    input: prompt
  };
}

function findDirectExecutable(command) {
  const lookup = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [command],
    { encoding: "utf8", shell: false }
  );
  const candidates = lookup.stdout
    ?.split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  return process.platform === "win32"
    ? candidates?.find((value) => /\.exe$/i.test(value))
    : candidates?.[0];
}

function createExecutor({ command, packageRoot, buildInvocation }) {
  return ({ repository, prompt, sessionId, resume, onOutput }) => {
    const executable = findDirectExecutable(command);
    if (!executable) {
      throw new Error(
        `${command} executable is unavailable or is not a directly executable binary`
      );
    }
    const invocation = buildInvocation({
      packageRoot,
      prompt,
      sessionId,
      resume
    });
    const child = spawn(executable, invocation.args, {
      cwd: repository,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => onOutput("stdout", chunk.toString()));
    child.stderr.on("data", (chunk) => onOutput("stderr", chunk.toString()));
    child.stdin.on("error", (error) =>
      onOutput("stderr", `Could not send the FixLab prompt: ${error.message}\n`)
    );
    child.stdin.end(invocation.input);

    const completion = new Promise((resolveCompletion) => {
      child.once("error", (error) => {
        onOutput("stderr", `${error.message}\n`);
        resolveCompletion({ code: null, error });
      });
      child.once("close", (code, signal) => {
        resolveCompletion({ code, signal });
      });
    });

    return {
      completion,
      terminate() {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }
    };
  };
}

export function createAgencyExecutor({ packageRoot }) {
  return createExecutor({
    command: "agency",
    packageRoot,
    buildInvocation: buildAgencyInvocation
  });
}

export function createCopilotExecutor({ packageRoot }) {
  return createExecutor({
    command: "copilot",
    packageRoot,
    buildInvocation: buildCopilotInvocation
  });
}

export function createRuntimeExecutor({ packageRoot, runtime = "agency" }) {
  if (!FIXLAB_RUNTIMES.includes(runtime)) {
    throw new Error(
      `FixLab runtime must be one of: ${FIXLAB_RUNTIMES.join(", ")}`
    );
  }
  return runtime === "copilot"
    ? createCopilotExecutor({ packageRoot })
    : createAgencyExecutor({ packageRoot });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function publicJob(job) {
  if (!job) {
    return null;
  }
  return {
    id: job.id,
    request: job.request,
    requestType: job.requestType,
    intakeSource: job.intakeSource,
    workItem: publicWorkItem(job.workItem),
    workItems: job.workItems.map(publicWorkItem),
    screenshots: job.screenshots.map(({ name, mimeType, bytes }) => ({
      name,
      mimeType,
      bytes
    })),
    mode: job.mode,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    canResume: ["blocked", "failed", "passed"].includes(job.status),
    canComment: job.status === "running",
    inputCount: job.inputs.length,
    pendingInputCount: job.pendingInputs.length,
    durationMs: Math.max(
      0,
      job.startedAt
        ? Date.parse(job.finishedAt ?? new Date().toISOString()) -
            Date.parse(job.startedAt)
        : 0
    ),
    usage: job.usage,
    stages: job.stages,
    bugs: job.bugs,
    logs: job.logs,
    droppedLogs: job.droppedLogs
  };
}

function publicWorkItem(workItem) {
  if (!workItem) {
    return null;
  }
  const {
    id,
    title,
    state,
    workItemType,
    webUrl,
    comments,
    commentsWarning
  } = workItem;
  return {
    id,
    title,
    state,
    workItemType,
    webUrl,
    commentCount: comments.length,
    commentsWarning
  };
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw new Error("request body is required");
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be a JSON object");
  }
  return body;
}

function validateWorkItemSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Azure DevOps intake requires a loaded work item");
  }
  const textFields = [
    "title",
    "description",
    "reproduction",
    "acceptanceCriteria",
    "state",
    "workItemType",
    "webUrl"
  ];
  const result = {};
  if (!Number.isSafeInteger(value.id) || value.id < 1) {
    throw new Error("loaded work item ID is invalid");
  }
  result.id = value.id;
  for (const field of textFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`loaded work item ${field} must be a string`);
    }
    const maximum = [
      "description",
      "reproduction",
      "acceptanceCriteria"
    ].includes(field)
      ? 20000
      : 1000;
    result[field] = (value[field] ?? "").trim().slice(0, maximum);
  }
  if (value.comments !== undefined && !Array.isArray(value.comments)) {
    throw new Error("loaded work item comments must be an array");
  }
  result.comments = (value.comments ?? []).slice(0, 20).map((comment) => {
    if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
      throw new Error("loaded work item comments must be objects");
    }
    for (const field of ["author", "createdAt", "text"]) {
      if (comment[field] !== undefined && typeof comment[field] !== "string") {
        throw new Error(`loaded work item comment ${field} must be a string`);
      }
    }
    return {
      author: (comment.author ?? "").trim().slice(0, 200),
      createdAt: (comment.createdAt ?? "").trim().slice(0, 100),
      text: (comment.text ?? "").trim().slice(0, 2000)
    };
  });
  if (
    value.commentsWarning !== undefined &&
    typeof value.commentsWarning !== "string"
  ) {
    throw new Error("loaded work item comments warning must be a string");
  }
  result.commentsWarning = (value.commentsWarning ?? "")
    .trim()
    .slice(0, 500);
  if (
    result.webUrl &&
    !/^https:\/\/dev\.azure\.com\//i.test(result.webUrl)
  ) {
    throw new Error("loaded work item URL must use https://dev.azure.com");
  }
  return result;
}

function validateLoadedScreenshots(value, state) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("loaded Azure DevOps screenshots must be an array");
  }
  const result = [];
  for (const screenshot of value) {
    if (state.count >= MAX_SCREENSHOTS) {
      throw new Error(
        `loaded Azure DevOps screenshots exceed the ${MAX_SCREENSHOTS}-image limit`
      );
    }
    if (!screenshot || typeof screenshot !== "object") {
      throw new Error("loaded Azure DevOps screenshots must be objects");
    }
    const name =
      typeof screenshot.name === "string" ? screenshot.name.trim() : "";
    const mimeType =
      typeof screenshot.mimeType === "string"
        ? screenshot.mimeType.toLowerCase()
        : "";
    const base64 =
      typeof screenshot.base64 === "string" ? screenshot.base64 : "";
    if (
      !name ||
      name !== basename(name) ||
      name.includes("..") ||
      !["image/png", "image/jpeg", "image/webp"].includes(mimeType) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        base64
      )
    ) {
      throw new Error("loaded Azure DevOps screenshot metadata is invalid");
    }
    const bytes = Buffer.from(base64, "base64").length;
    if (bytes > MAX_SCREENSHOT_BYTES) {
      throw new Error("loaded Azure DevOps screenshot exceeds 2 MiB");
    }
    state.totalBytes += bytes;
    if (state.totalBytes > MAX_SCREENSHOT_TOTAL_BYTES) {
      throw new Error("loaded Azure DevOps screenshots exceed 8 MiB total");
    }
    state.count += 1;
    result.push({ name, mimeType, base64 });
  }
  return result;
}

function appendOutput(job, stream, text) {
  const normalized = text.replace(/\r\n/g, "\n");
  job.partial[stream] += normalized;
  const lines = job.partial[stream].split("\n");
  job.partial[stream] = lines.pop();
  for (const line of lines) {
    appendLine(job, stream, line);
  }
}

function appendLine(job, stream, line) {
  pushLog(job, {
    index: job.nextLogIndex,
    timestamp: new Date().toISOString(),
    stream,
    message: line
  });
  const usage = parseUsageLine(line);
  if (usage) {
    job.usage = usage;
  }
  const bugMarker = line.match(
    /^FIXLAB_BUG\|(\d+)\|([^|]+)\|([^|]+)\|(.*)$/
  );
  if (bugMarker) {
    const [, id, outcome, owner, summary] = bugMarker;
    const bug = job.bugs.find((candidate) => candidate.id === id);
    if (!bug || !bugOutcomeStatuses.has(outcome)) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `Ignored invalid bug outcome marker: ${line}`
      });
      return;
    }
    bug.outcome = outcome;
    bug.owner = safeSummary(owner);
    bug.summary = safeSummary(summary);
    return;
  }

  const marker =
    line.match(/^FIXLAB_STAGE\|([^|]+)\|([^|]+)\|(.*)$/) ??
    line.match(/^FIXLAB_STAGE\s+(\S+)\s+(\S+)\s+-\s+(.*)$/);
  if (!marker) {
    return;
  }
  const [, stage, status, message] = marker;
  if (!FIXLAB_STAGES.includes(stage) || !allStatuses.has(status)) {
    pushLog(job, {
      index: job.nextLogIndex,
      timestamp: new Date().toISOString(),
      stream: "dashboard",
      message: `Ignored invalid stage marker: ${line}`
    });
    return;
  }
  job.stages[stage] = { status, message: message.trim() };
  if (status === "failed" && !job.error) {
    job.error = message.trim() || `${stage} failed`;
  }
}

function pushLog(job, entry) {
  job.nextLogIndex += 1;
  job.logs.push(entry);
  if (job.logs.length > MAX_JOB_LOG_ENTRIES) {
    job.logs.shift();
    job.droppedLogs += 1;
  }
}

function finishJob(job, result) {
  for (const stream of ["stdout", "stderr"]) {
    if (job.partial[stream]) {
      appendLine(job, stream, job.partial[stream]);
      job.partial[stream] = "";
    }
  }

  const missing = FIXLAB_STAGES.filter(
    (stage) => !terminalStatuses.has(job.stages[stage].status)
  );
  const failed = FIXLAB_STAGES.filter(
    (stage) => job.stages[stage].status === "failed"
  );
  const blocked = FIXLAB_STAGES.filter(
    (stage) => job.stages[stage].status === "blocked"
  );
  const unresolvedBugs = job.bugs.filter(
    (bug) => bug.outcome === "pending"
  );
  if (result?.error && !job.error) {
    job.error = result.error.message;
  }
  if (result?.code !== 0 && !job.error) {
    job.error = `Agency exited with code ${result?.code ?? "unknown"}${
      result?.signal ? ` (${result.signal})` : ""
    }`;
  }
  if (missing.length > 0) {
    const incomplete = `Incomplete stage markers: ${missing.join(", ")}`;
    job.error = job.error ? `${job.error}; ${incomplete}` : incomplete;
  }
  if (failed.length > 0 && !job.error) {
    job.error = `Failed stages: ${failed.join(", ")}`;
  }
  if (unresolvedBugs.length > 0) {
    const incomplete = `Missing bug outcomes: ${unresolvedBugs
      .map((bug) => bug.id)
      .join(", ")}`;
    job.error = job.error ? `${job.error}; ${incomplete}` : incomplete;
  }
  job.status =
    result?.code === 0 &&
    missing.length === 0 &&
    failed.length === 0 &&
    unresolvedBugs.length === 0
      ? blocked.length > 0
        ? "blocked"
        : "passed"
      : "failed";
  job.finishedAt = new Date().toISOString();
  writeCacheSummary(job.cacheContext, job);
}

function buildResumePrompt(job, { action, details }) {
  const expectedBugs = job.bugs.map((bug) => bug.id).join(", ");
  return `Resume the existing FixLab dashboard session for job ${job.id}.
User action: ${action}
User input:
${details}

Resume requirements:
- Reuse the completed diagnosis, current worktree, validation evidence, branch, and pull request from this session.
- Re-read repository instructions and the effective diff only when the new input changes them.
- Continue from the blocked or failed stage, or treat this as a focused addition to the completed job.
- Do not repeat completed investigation, dependency installation, broad tests, or builds without new risk evidence.
- If the user selected skip, mark only the affected gate skipped, preserve the risk, and continue safe remaining work.
- Emit one updated FIXLAB_BUG line for every expected bug before finishing. Expected IDs: ${expectedBugs || "none"}.
- Emit terminal FIXLAB_STAGE lines for every stage before finishing.
- Do not create a duplicate or empty pull request. Reuse an existing pull request when one belongs to this session.
- Do not call task_complete or return the final response until all required machine-readable lines are emitted.`;
}

function buildFreshRetryPrompt(job, details) {
  return `${job.initialPrompt}

Retry context:
The previous runtime launch failed before FixLab completed any stage or created
a resumable session. Start this job again from intake.

User input:
${details}`;
}

function requiresFreshRetry(job, action) {
  return (
    action === "retry" &&
    FIXLAB_STAGES.every((stage) => job.stages[stage].status === "pending") &&
    job.usage.inputTokens === 0 &&
    job.usage.outputTokens === 0
  );
}

function playwrightAuthenticationConfig(repository) {
  const profile = loadRepositoryProfile(repository);
  const browserAutomation = profile.browserAutomation ?? {};
  const authentication = browserAutomation.authentication ?? {};
  const workingDirectory = resolve(
    repository,
    browserAutomation.workingDirectory ??
      profile.applications?.frontend?.workingDirectory ??
      "."
  );
  const command =
    typeof authentication.command === "string"
      ? authentication.command.trim()
      : "";
  const statusPaths = Array.isArray(authentication.statusPaths)
    ? authentication.statusPaths
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
    : [];
  const environment = Object.fromEntries(
    Object.entries(authentication.environment ?? {}).filter(
      ([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        typeof value === "string"
    )
  );
  return {
    command,
    environment,
    statusPaths,
    workingDirectory
  };
}

function playwrightAuthenticationStatus(repository, connection) {
  let configuration;
  try {
    configuration = playwrightAuthenticationConfig(repository);
  } catch (error) {
    return {
      configured: false,
      ready: false,
      running: Boolean(connection.handle),
      error: error.message,
      lastResult: connection.lastResult,
      paths: []
    };
  }
  const paths = configuration.statusPaths.map((relativePath) => {
    const path = resolve(configuration.workingDirectory, relativePath);
    return {
      path: relativePath,
      ready: existsSync(path)
    };
  });
  return {
    configured: Boolean(
      configuration.command && configuration.statusPaths.length > 0
    ),
    ready: paths.length > 0 && paths.every((entry) => entry.ready),
    running: Boolean(connection.handle),
    error: "",
    lastResult: connection.lastResult,
    paths
  };
}

function playwrightArtifactRoots(repository) {
  const configuration = playwrightAuthenticationConfig(repository);
  return ["test-results", "playwright-report", "artifacts"]
    .map((directory) => resolve(configuration.workingDirectory, directory))
    .filter((directory) => existsSync(directory));
}

function collectPlaywrightArtifacts(root, directory = root, depth = 0) {
  if (depth > 6) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectPlaywrightArtifacts(root, path, depth + 1));
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
      continue;
    }
    const resolvedPath = realpathSync(path);
    const relativePath = relative(root, resolvedPath);
    if (
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    ) {
      continue;
    }
    const stats = statSync(resolvedPath);
    if (stats.size > MAX_SCREENSHOT_BYTES) {
      continue;
    }
    files.push({
      id: createHash("sha256").update(resolvedPath).digest("hex").slice(0, 24),
      path: resolvedPath,
      name: basename(resolvedPath),
      relativePath,
      bytes: stats.size,
      updatedAt: stats.mtime.toISOString(),
      mimeType:
        extension === ".png"
          ? "image/png"
          : extension === ".webp"
            ? "image/webp"
            : "image/jpeg"
    });
  }
  return files;
}

function listPlaywrightArtifacts(repository, { since = null } = {}) {
  return playwrightArtifactRoots(repository)
    .flatMap((root) =>
      collectPlaywrightArtifacts(root)
        .filter(
          (artifact) =>
            !artifact.relativePath.includes("\\") &&
            !artifact.relativePath.includes("/")
        )
        .map((artifact) => ({
          ...artifact,
          relativePath: join(basename(root), artifact.relativePath)
        }))
    )
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    )
    .filter(
      (artifact) =>
        !since || Date.parse(artifact.updatedAt) >= Date.parse(since)
    )
    .slice(0, MAX_PLAYWRIGHT_ARTIFACTS);
}

function resetJobForResume(job) {
  const restartIndex =
    job.status === "passed"
      ? FIXLAB_STAGES.indexOf("diagnosis")
      : Math.max(
          0,
          FIXLAB_STAGES.findIndex((stage) =>
            ["blocked", "failed"].includes(job.stages[stage].status)
          )
        );
  for (const stage of FIXLAB_STAGES.slice(restartIndex)) {
    job.stages[stage] = { status: "pending", message: "" };
  }
  for (const bug of job.bugs) {
    bug.outcome = "pending";
    bug.owner = "";
    bug.summary = "";
  }
  job.status = "running";
  job.finishedAt = null;
  job.error = null;
  job.partial = { stdout: "", stderr: "" };
}

export function createDashboardServer({
  repository,
  packageRoot,
  runtime = "agency",
  publicDirectory = join(packageRoot, "dashboard", "public"),
  executor = createRuntimeExecutor({ packageRoot, runtime }),
  workItemLoader = createAzureDevOpsLoader()
}) {
  const resolvedRepository = resolve(repository);
  let currentJob = null;
  let activeHandle = null;
  const queuedJobs = [];
  const completedJobs = [];
  const artifactDirectories = new Set();
  const playwrightConnection = { handle: null, lastResult: null };
  const playwrightArtifacts = new Map();
  const cacheContext = createCacheContext(resolvedRepository);
  const metricsPath = cacheContext
    ? join(dirname(cacheContext.cachePath), "dashboard-metrics.json")
    : null;
  const loadedMetrics = readMetrics(metricsPath);
  let metricsRecords = loadedMetrics.records;
  let metricsWarning = loadedMetrics.warning;

  function recordJobMetric(job) {
    metricsRecords = updateJobMetrics(metricsRecords, job);
    try {
      writeMetrics(metricsPath, metricsRecords);
      metricsWarning = null;
    } catch {
      metricsWarning =
        "Dashboard metrics were updated in memory but could not be persisted.";
    }
  }

  function archiveJob(job) {
    if (!job || completedJobs.some((entry) => entry.id === job.id)) {
      return;
    }
    completedJobs.unshift(job);
    completedJobs.splice(20);
  }

  function startJob(job, prompt, resume = false) {
    const handle = executor({
      repository: resolvedRepository,
      prompt,
      sessionId: job.id,
      resume,
      onOutput(stream, text) {
        appendOutput(job, stream, text);
      }
    });
    activeHandle = handle;
    Promise.resolve(handle.completion)
      .then((result) => {
        finishJob(job, result);
        recordJobMetric(job);
      })
      .catch((error) => {
        finishJob(job, { code: null, error });
        recordJobMetric(job);
      })
      .finally(() => {
        if (activeHandle === handle) {
          activeHandle = null;
        }
        if (job.pendingInputs.length > 0) {
          const pendingInputs = job.pendingInputs.splice(0);
          const details = pendingInputs
            .map(
              (input, index) =>
                `Comment ${index + 1} (${input.createdAt}):\n${input.details}`
            )
            .join("\n\n");
          const prompt = buildResumePrompt(job, {
            action: "continue",
            details
          });
          resetJobForResume(job);
          recordJobMetric(job);
          try {
            startJob(job, prompt, true);
          } catch (error) {
            finishJob(job, { code: null, error });
            recordJobMetric(job);
            activeHandle = null;
          }
          return;
        }
        startNextJob();
      });
  }

  function startNextJob() {
    if (
      activeHandle ||
      queuedJobs.length === 0 ||
      (currentJob && currentJob.status !== "passed")
    ) {
      return;
    }
    if (currentJob?.artifactDirectory) {
      removeArtifactDirectory(currentJob.artifactDirectory);
      artifactDirectories.delete(currentJob.artifactDirectory);
    }
    archiveJob(currentJob);
    currentJob = queuedJobs.shift();
    currentJob.status = "running";
    currentJob.startedAt = new Date().toISOString();
    recordJobMetric(currentJob);
    try {
      startJob(currentJob, currentJob.pendingPrompt);
      delete currentJob.pendingPrompt;
    } catch (error) {
      finishJob(currentJob, { code: null, error });
      recordJobMetric(currentJob);
      activeHandle = null;
    }
  }

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(
      request.url,
      `http://${request.headers.host ?? DASHBOARD_HOST}`
    );

    if (request.method === "GET" && requestUrl.pathname === "/api/status") {
      sendJson(response, 200, {
        readiness: inspectRepository(resolvedRepository),
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs),
        history: publicHistory(completedJobs)
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/job") {
      sendJson(response, 200, {
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs),
        history: publicHistory(completedJobs)
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/metrics") {
      const period = requestUrl.searchParams.get("period") ?? "7d";
      if (!["24h", "7d", "30d", "all"].includes(period)) {
        sendJson(response, 400, {
          error: "period must be 24h, 7d, 30d, or all"
        });
        return;
      }
      sendJson(response, 200, {
        metrics: summarizeMetrics(metricsRecords, period),
        warning: metricsWarning
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/azure-devops/load"
    ) {
      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
        const readiness = inspectRepository(resolvedRepository);
        if (!readiness.profileReady) {
          throw new Error(readiness.error);
        }
        const profile = loadRepositoryProfile(resolvedRepository);
        const inputs = Array.isArray(body.workItems)
          ? body.workItems
          : [body.workItem];
        const uniqueInputs = [
          ...new Set(
            inputs
              .map((value) => String(value ?? "").trim())
              .filter(Boolean)
          )
        ];
        if (uniqueInputs.length < 1 || uniqueInputs.length > 20) {
          throw new Error("provide between 1 and 20 unique work item IDs or URLs");
        }
        const loaded =
          typeof workItemLoader.loadMany === "function"
            ? await workItemLoader.loadMany({
                workItems: uniqueInputs,
                profile
              })
            : await Promise.all(
                uniqueInputs.map((workItem) =>
                  workItemLoader({ workItem, profile })
                )
              );
        const screenshotState = { count: 0, totalBytes: 0 };
        const workItems = loaded.map((item) => {
          const workItem = validateWorkItemSummary(item);
          workItem.screenshots = validateLoadedScreenshots(
            item.screenshots,
            screenshotState
          );
          workItem.imagesWarning =
            typeof item.imagesWarning === "string"
              ? item.imagesWarning.trim().slice(0, 500)
              : "";
          return workItem;
        });
        sendJson(response, 200, {
          workItem: workItems.length === 1 ? workItems[0] : null,
          workItems
        });
      } catch (error) {
        sendJson(response, 400, {
          error: String(error.message).replace(
            /Bearer\s+\S+/gi,
            "Bearer [REDACTED]"
          )
        });
      }
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/job/input"
    ) {
      if (!currentJob) {
        sendJson(response, 404, { error: "no FixLab job is available" });
        return;
      }
      const running = currentJob.status === "running" && Boolean(activeHandle);
      if (
        !running &&
        !["blocked", "failed", "passed"].includes(currentJob.status)
      ) {
        sendJson(response, 409, {
          error:
            "user input can be added only to a running, blocked, failed, or completed job"
        });
        return;
      }
      if (!running && activeHandle) {
        sendJson(response, 409, {
          error: "the current FixLab agent is still shutting down"
        });
        return;
      }

      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const details =
        typeof body.details === "string" ? body.details.trim() : "";
      if (!details || details.length > 10000) {
        sendJson(response, 400, {
          error: "details must be a non-empty string of at most 10000 characters"
        });
        return;
      }
      const action = body.action ?? "continue";
      if (!["comment", "continue", "retry", "skip"].includes(action)) {
        sendJson(response, 400, {
          error: "action must be comment, continue, retry, or skip"
        });
        return;
      }
      if (running && action !== "comment") {
        sendJson(response, 400, {
          error: "a running job accepts only comment input"
        });
        return;
      }

      const input = {
        action,
        details,
        createdAt: new Date().toISOString()
      };
      currentJob.inputs.push(input);
      if (running) {
        currentJob.pendingInputs.push(input);
        pushLog(currentJob, {
          index: currentJob.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: `Comment ${currentJob.inputs.length} queued for the same FixLab session after the current agent turn.`
        });
        sendJson(response, 202, {
          job: publicJob(currentJob),
          queued: true,
          queue: publicQueue(queuedJobs)
        });
        return;
      }
      pushLog(currentJob, {
        index: currentJob.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `User input ${currentJob.inputs.length} accepted; resuming the same FixLab session.`
      });
      const freshRetry = requiresFreshRetry(currentJob, action);
      const prompt = freshRetry
        ? buildFreshRetryPrompt(currentJob, details)
        : buildResumePrompt(currentJob, { action, details });
      resetJobForResume(currentJob);
      recordJobMetric(currentJob);
      try {
        startJob(currentJob, prompt, !freshRetry);
      } catch (error) {
        finishJob(currentJob, { code: null, error });
        recordJobMetric(currentJob);
        activeHandle = null;
      }
      sendJson(response, 202, {
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs)
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/jobs") {
      let shouldQueue =
        Boolean(activeHandle) ||
        ["running", "blocked", "failed"].includes(currentJob?.status) ||
        queuedJobs.length > 0;
      if (shouldQueue && queuedJobs.length >= MAX_QUEUED_JOBS) {
        sendJson(response, 409, {
          error: `the FixLab queue already contains ${MAX_QUEUED_JOBS} jobs`
        });
        return;
      }

      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request, 12 * 1024 * 1024);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      const requestText =
        typeof body.request === "string" ? body.request.trim() : "";
      if (!requestText || requestText.length > 10000) {
        sendJson(response, 400, {
          error: "request must be a non-empty string of at most 10000 characters"
        });
        return;
      }
      if (
        !["fix-and-validate", "validate-only", "playwright-only"].includes(
          body.mode
        )
      ) {
        sendJson(response, 400, {
          error:
            "mode must be fix-and-validate, validate-only, or playwright-only"
        });
        return;
      }
      const requestType = body.requestType ?? "bug-fix";
      if (!["bug-fix", "small-enhancement"].includes(requestType)) {
        sendJson(response, 400, {
          error: "requestType must be bug-fix or small-enhancement"
        });
        return;
      }
      const intakeSource = body.intakeSource ?? "manual";
      if (!["manual", "azure-devops"].includes(intakeSource)) {
        sendJson(response, 400, {
          error: "intakeSource must be manual or azure-devops"
        });
        return;
      }
      let workItem = null;
      let workItems = [];
      try {
        if (intakeSource === "azure-devops") {
          const values = Array.isArray(body.workItems)
            ? body.workItems
            : body.workItem
              ? [body.workItem]
              : [];
          workItems = values.map(validateWorkItemSummary);
          if (workItems.length < 1 || workItems.length > 20) {
            throw new Error(
              "Azure DevOps intake requires between 1 and 20 loaded work items"
            );
          }
          const ids = workItems.map((item) => item.id);
          if (new Set(ids).size !== ids.length) {
            throw new Error("loaded Azure DevOps work items must be unique");
          }
          workItem = workItems.length === 1 ? workItems[0] : null;
        }
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      const readiness = inspectRepository(resolvedRepository);
      if (!readiness.repositoryReady || !readiness.profileReady) {
        sendJson(response, 400, { error: readiness.error, readiness });
        return;
      }

      shouldQueue =
        Boolean(activeHandle) ||
        ["running", "blocked", "failed"].includes(currentJob?.status) ||
        queuedJobs.length > 0;
      if (shouldQueue && queuedJobs.length >= MAX_QUEUED_JOBS) {
        sendJson(response, 409, {
          error: `the FixLab queue already contains ${MAX_QUEUED_JOBS} jobs`
        });
        return;
      }
      if (!shouldQueue && currentJob?.artifactDirectory) {
        removeArtifactDirectory(currentJob.artifactDirectory);
        artifactDirectories.delete(currentJob.artifactDirectory);
      }
      if (!shouldQueue) {
        archiveJob(currentJob);
      }
      const jobId = randomUUID();
      let storedScreenshots;
      try {
        storedScreenshots = storeScreenshots({
          repository: resolvedRepository,
          jobId,
          screenshots: body.screenshots ?? []
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (storedScreenshots.directory) {
        artifactDirectories.add(storedScreenshots.directory);
      }

      const job = {
        id: jobId,
        createdAt: new Date().toISOString(),
        request: requestText,
        requestType,
        intakeSource,
        workItem,
        workItems,
        screenshots: storedScreenshots.files,
        artifactDirectory: storedScreenshots.directory,
        mode: body.mode,
        status: shouldQueue ? "queued" : "running",
        startedAt: shouldQueue ? null : new Date().toISOString(),
        finishedAt: null,
        error: null,
        inputs: [],
        pendingInputs: [],
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          cacheReusePercent: 0
        },
        stages: Object.fromEntries(
          FIXLAB_STAGES.map((stage) => [
            stage,
            { status: "pending", message: "" }
          ])
        ),
        bugs: extractBugResults(requestText, workItems),
        logs: [],
        droppedLogs: 0,
        nextLogIndex: 0,
        cacheContext: createCacheContext(resolvedRepository),
        partial: { stdout: "", stderr: "" }
      };
      job.initialPrompt = buildJobPrompt({
        request: requestText,
        mode: body.mode,
        requestType,
        intakeSource,
        workItem,
        workItems,
        screenshotPaths: storedScreenshots.files.map((file) => file.path),
        cacheSummary: loadCacheSummary(job.cacheContext)
      });
      job.pendingPrompt = job.initialPrompt;
      recordJobMetric(job);

      if (shouldQueue) {
        queuedJobs.push(job);
      } else {
        currentJob = job;
        try {
          startJob(currentJob, currentJob.pendingPrompt);
          delete currentJob.pendingPrompt;
        } catch (error) {
          finishJob(currentJob, { code: null, error });
          recordJobMetric(currentJob);
          activeHandle = null;
        }
      }

      sendJson(response, 202, {
        job: publicJob(currentJob),
        queued: shouldQueue,
        queuedJob: shouldQueue ? publicQueue([job])[0] : null,
        queue: publicQueue(queuedJobs)
      });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/playwright/status"
    ) {
      sendJson(
        response,
        200,
        playwrightAuthenticationStatus(
          resolvedRepository,
          playwrightConnection
        )
      );
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/playwright/artifacts"
    ) {
      const jobId = requestUrl.searchParams.get("jobId");
      const job = [
        currentJob,
        ...queuedJobs,
        ...completedJobs
      ].find((entry) => entry?.id === jobId);
      if (!jobId || !job) {
        sendJson(response, 404, {
          error: "FixLab job not found for Playwright evidence"
        });
        return;
      }
      let artifacts;
      try {
        artifacts = listPlaywrightArtifacts(resolvedRepository, {
          since: job.startedAt ?? job.createdAt
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      playwrightArtifacts.clear();
      for (const artifact of artifacts) {
        playwrightArtifacts.set(artifact.id, artifact);
      }
      sendJson(response, 200, {
        artifacts: artifacts.map(
          ({ id, name, relativePath, bytes, updatedAt }) => ({
            id,
            name,
            relativePath,
            bytes,
            updatedAt,
            url: `/api/playwright/artifacts/${id}`
          })
        )
      });
      return;
    }

    const artifactMatch = requestUrl.pathname.match(
      /^\/api\/playwright\/artifacts\/([a-f0-9]{24})$/
    );
    if (request.method === "GET" && artifactMatch) {
      const artifact = playwrightArtifacts.get(artifactMatch[1]);
      if (!artifact || !existsSync(artifact.path)) {
        sendJson(response, 404, { error: "Playwright artifact not found" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": artifact.mimeType,
        "Content-Length": artifact.bytes,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      createReadStream(artifact.path).pipe(response);
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/playwright/connect"
    ) {
      if (playwrightConnection.handle) {
        sendJson(response, 409, {
          error: "Playwright authentication is already running"
        });
        return;
      }
      let configuration;
      try {
        configuration = playwrightAuthenticationConfig(resolvedRepository);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (!configuration.command || configuration.statusPaths.length === 0) {
        sendJson(response, 400, {
          error:
            "repository profile must configure browserAutomation.authentication.command and statusPaths"
        });
        return;
      }
      if (!existsSync(configuration.workingDirectory)) {
        sendJson(response, 400, {
          error: "configured Playwright working directory does not exist"
        });
        return;
      }
      playwrightConnection.lastResult = null;
      const child = spawn(configuration.command, {
        cwd: configuration.workingDirectory,
        env: { ...process.env, ...configuration.environment },
        shell: true,
        stdio: "ignore",
        windowsHide: false
      });
      playwrightConnection.handle = child;
      child.once("error", (error) => {
        playwrightConnection.lastResult = {
          ok: false,
          message: error.message,
          finishedAt: new Date().toISOString()
        };
        playwrightConnection.handle = null;
      });
      child.once("close", (code, signal) => {
        playwrightConnection.lastResult = {
          ok: code === 0,
          message:
            code === 0
              ? "Playwright authentication completed."
              : `Playwright authentication exited with code ${code ?? "unknown"}${
                  signal ? ` (${signal})` : ""
                }.`,
          finishedAt: new Date().toISOString()
        };
        playwrightConnection.handle = null;
      });
      sendJson(response, 202, {
        ...playwrightAuthenticationStatus(
          resolvedRepository,
          playwrightConnection
        ),
        started: true
      });
      return;
    }

    if (request.method === "GET" && staticFiles.has(requestUrl.pathname)) {
      const fileName = staticFiles.get(requestUrl.pathname);
      const filePath = join(publicDirectory, fileName);
      if (!existsSync(filePath)) {
        sendJson(response, 404, { error: "dashboard asset not found" });
        return;
      }
      response.writeHead(200, {
        "Content-Type":
          contentTypes[extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
      });
      createReadStream(filePath).pipe(response);
      return;
    }

    sendJson(response, 404, { error: "not found" });
  });

  return {
    server,
    async listen({ port = DEFAULT_DASHBOARD_PORT } = {}) {
      const validatedPort = validatePort(port);
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(validatedPort, DASHBOARD_HOST, resolveListen);
      });
      const address = server.address();
      return {
        host: DASHBOARD_HOST,
        port: address.port,
        url: `http://${DASHBOARD_HOST}:${address.port}`
      };
    },
    async close() {
      if (activeHandle?.terminate) {
        activeHandle.terminate();
      }
      if (
        playwrightConnection.handle &&
        playwrightConnection.handle.exitCode === null &&
        playwrightConnection.handle.signalCode === null
      ) {
        playwrightConnection.handle.kill();
      }
      for (const directory of artifactDirectories) {
        removeArtifactDirectory(directory);
      }
      artifactDirectories.clear();
      server.closeIdleConnections?.();
      await new Promise((resolveClose, reject) => {
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    }
  };
}
