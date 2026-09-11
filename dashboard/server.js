import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

export const DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 4317;
export const MAX_JOB_LOG_ENTRIES = 1000;
export const MAX_CACHE_ENTRIES = 20;
export const MAX_CACHE_BYTES = 64 * 1024;
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

const terminalStatuses = new Set(["passed", "skipped", "failed"]);
const allStatuses = new Set(["pending", "running", ...terminalStatuses]);
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

export function inspectRepository(repository) {
  const resolvedRepository = resolve(repository);
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
  cacheSummary = null
}) {
  const validateOnly = mode === "validate-only";
  const smallEnhancement = requestType === "small-enhancement";
  const requestGuidance = smallEnhancement
    ? `- Generate a concise acceptance contract before changing code.
- Check the affected surface and bound the file scope before editing.
- Do not manufacture a failing defect reproduction. Use the smallest existing focused test that proves the acceptance contract.
- Skip broad test suites and full builds unless the repository profile requires them or user-visible/risk evidence makes them necessary.
- Preserve review, live-test, and pull-request evidence, and make no unrelated changes.`
    : `- Generate a concise fix contract from the reported behavior and expected outcome.
- Diagnose and reproduce with repository evidence. Do not claim a cause or reproduction without evidence.
- Use the smallest focused reproduction that demonstrates the reported defect.`;
  return `Run a FixLab ${validateOnly ? "validate-only" : "fix-and-validate"} job.
Request type: ${requestType}
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
- ${validateOnly ? "Do not edit files, create commits, push branches, create pull requests, or update pull requests." : "Make the smallest complete change that resolves the request. Make no code change when the evidence shows none is required."}
- Autonomously complete the lifecycle without asking the user to direct routine engineering steps.
- Inspect the affected surface, implement the smallest required code when edits are allowed, and self-review the effective diff for correctness, scope, and unrelated changes.
- Run the focused repository-owned tests, type-checks, and builds needed for the affected surface and risk. Preserve exact results.
- Start only the applications defined by the repository profile, then execute the repository-defined live test against the allowed required system or environment from that profile. Do not invent or hardcode environment choices.
- Collect evidence for diagnosis or surface inspection, the effective diff, review, local validation, application startup, live testing, skipped gates, and remaining risks.
- ${validateOnly ? "Report the pull-request outcome without creating or updating a pull request." : "Create or update the pull request only after all required gates pass, and include the collected evidence."}
- Human interaction is limited to authentication, unsafe-data approval, deployment or pull-request approval, and genuine blockers that cannot be resolved from repository evidence.
- Keep stage messages and retained logs concise. Summarize relevant command evidence and preserve exact errors, but do not feed unbounded raw output back into prompts.
- Keep all execution local unless the repository profile and existing authorization explicitly require an allowed external action.
- Emit exactly one or more progress lines in this format:
  FIXLAB_STAGE|stage|status|message
- stage must be one of: ${FIXLAB_STAGES.join(", ")}.
- status must be pending, running, passed, skipped, or failed.
- Before finishing, emit a terminal passed, skipped, or failed marker for every stage. Never imply an unmarked stage passed.
- Preserve exact command errors in the stage message or adjacent output.
${validateOnly ? "- The fix and pr stages must be explicitly skipped unless they fail for another reason." : ""}

Request:
${request}`;
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
    /(?:password|passwd|secret|token|authorization|bearer|cookie|connection.?string|private.?key|client.?secret)/i.test(
      text
    )
  ) {
    return "[omitted potentially sensitive summary]";
  }
  return text;
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

export function createAgencyExecutor({ packageRoot }) {
  return ({ repository, prompt, onOutput }) => {
    const lookup = spawnSync(
      process.platform === "win32" ? "where.exe" : "which",
      ["agency"],
      { encoding: "utf8", shell: false }
    );
    const candidates = lookup.stdout
      ?.split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const executable =
      process.platform === "win32"
        ? candidates?.find((value) => /\.exe$/i.test(value))
        : candidates?.[0];
    if (!executable) {
      throw new Error(
        "Agency executable is unavailable or is not a directly executable binary"
      );
    }
    const child = spawn(
      executable,
      [
        "copilot",
        "--plugin",
        `local:${packageRoot}`,
        "--agent",
        "FixLab:fixlab",
        "--interactive",
        prompt
      ],
      {
        cwd: repository,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    child.stdout.on("data", (chunk) => onOutput("stdout", chunk.toString()));
    child.stderr.on("data", (chunk) => onOutput("stderr", chunk.toString()));

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
    mode: job.mode,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    stages: job.stages,
    logs: job.logs,
    droppedLogs: job.droppedLogs
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      throw new Error("request body exceeds 64 KiB");
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
  const marker = line.match(
    /^FIXLAB_STAGE\|([^|]+)\|([^|]+)\|(.*)$/
  );
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

  job.status =
    result?.code === 0 && missing.length === 0 && failed.length === 0
      ? "passed"
      : "failed";
  job.finishedAt = new Date().toISOString();
  writeCacheSummary(job.cacheContext, job);
}

export function createDashboardServer({
  repository,
  packageRoot,
  publicDirectory = join(packageRoot, "dashboard", "public"),
  executor = createAgencyExecutor({ packageRoot })
}) {
  const resolvedRepository = resolve(repository);
  let currentJob = null;
  let activeHandle = null;

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(
      request.url,
      `http://${request.headers.host ?? DASHBOARD_HOST}`
    );

    if (request.method === "GET" && requestUrl.pathname === "/api/status") {
      sendJson(response, 200, {
        readiness: inspectRepository(resolvedRepository),
        job: publicJob(currentJob)
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/job") {
      sendJson(response, 200, { job: publicJob(currentJob) });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/jobs") {
      if (currentJob?.status === "running") {
        sendJson(response, 409, {
          error: "a FixLab job is already running"
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

      const requestText =
        typeof body.request === "string" ? body.request.trim() : "";
      if (!requestText || requestText.length > 10000) {
        sendJson(response, 400, {
          error: "request must be a non-empty string of at most 10000 characters"
        });
        return;
      }
      if (!["fix-and-validate", "validate-only"].includes(body.mode)) {
        sendJson(response, 400, {
          error: "mode must be fix-and-validate or validate-only"
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

      const readiness = inspectRepository(resolvedRepository);
      if (!readiness.repositoryReady || !readiness.profileReady) {
        sendJson(response, 400, { error: readiness.error, readiness });
        return;
      }

      currentJob = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        request: requestText,
        requestType,
        mode: body.mode,
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        stages: Object.fromEntries(
          FIXLAB_STAGES.map((stage) => [
            stage,
            { status: "pending", message: "" }
          ])
        ),
        logs: [],
        droppedLogs: 0,
        nextLogIndex: 0,
        cacheContext: createCacheContext(resolvedRepository),
        partial: { stdout: "", stderr: "" }
      };

      try {
        activeHandle = executor({
          repository: resolvedRepository,
          prompt: buildJobPrompt({
            request: requestText,
            mode: body.mode,
            requestType,
            cacheSummary: loadCacheSummary(currentJob.cacheContext)
          }),
          onOutput(stream, text) {
            appendOutput(currentJob, stream, text);
          }
        });
        Promise.resolve(activeHandle.completion)
          .then((result) => finishJob(currentJob, result))
          .catch((error) => finishJob(currentJob, { code: null, error }))
          .finally(() => {
            activeHandle = null;
          });
      } catch (error) {
        finishJob(currentJob, { code: null, error });
        activeHandle = null;
      }

      sendJson(response, 202, { job: publicJob(currentJob) });
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
