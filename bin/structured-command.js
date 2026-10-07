import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_CAPTURE_BYTES_PER_STREAM = 50 * 1024 * 1024;
const MAX_DIAGNOSTICS = 20;
const MAX_TAIL_LINES = 20;
const MAX_EVIDENCE_SHOW_LINES = 500;
const DEFAULT_EVIDENCE_SHOW_LINES = 120;
const MAX_EVIDENCE_DIRECTORIES = 100;
const EVIDENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_SECONDS = 2_147_483;
const HEADER_SECRET_PATTERN =
  /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*).+$/gimu;
const SECRET_PATTERN =
  /((?:"|')?(?:password|passwd|secret|token|authorization|bearer|cookie|client[-_]?secret|api[-_]?key)(?:"|')?\s*(?:=|:)\s*)(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const SECRET_ARGUMENT_PATTERN =
  /(--(?:password|passwd|secret|token|authorization|bearer|cookie|client-secret|api-key)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/giu;
const AUTH_SCHEME_PATTERN = /(\b(?:bearer|basic)\s+)[^\s"',;]+/giu;
const CREDENTIAL_URL_PATTERN = /(https?:\/\/[^:\s/]+:)[^@\s]+@/giu;

function sanitize(value) {
  return String(value)
    .replace(HEADER_SECRET_PATTERN, "$1[REDACTED]")
    .replace(SECRET_PATTERN, "$1[REDACTED]")
    .replace(SECRET_ARGUMENT_PATTERN, "$1[REDACTED]")
    .replace(AUTH_SCHEME_PATTERN, "$1[REDACTED]")
    .replace(CREDENTIAL_URL_PATTERN, "$1[REDACTED]@");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(repository, args) {
  return spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
}

function isContained(root, candidate) {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child))
  );
}

function resolveEvidenceRoot(repository) {
  const result = git(repository, [
    "rev-parse",
    "--git-path",
    "fixlab/command-evidence"
  ]);
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("fixlab exec requires a Git repository");
  }
  const path = result.stdout.trim();
  return resolve(repository, path);
}

function repositoryState(repository) {
  const head = git(repository, ["rev-parse", "HEAD"]);
  if (head.status !== 0) {
    throw new Error("fixlab exec could not resolve the repository HEAD");
  }
  const status = git(repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ]);
  if (status.status !== 0) {
    throw new Error("fixlab exec could not inspect the repository worktree");
  }
  const files = git(repository, [
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z"
  ]);
  if (files.status !== 0) {
    throw new Error("fixlab exec could not enumerate repository files");
  }
  const paths = files.stdout.split("\0").filter(Boolean);
  const regularPaths = paths.filter((path) => !/[\r\n]/u.test(path));
  const exceptionalPaths = paths.filter((path) => /[\r\n]/u.test(path));
  const contentHashes = [];
  if (regularPaths.length > 0) {
    const hashes = spawnSync(
      "git",
      ["hash-object", "--no-filters", "--stdin-paths"],
      {
        cwd: repository,
        encoding: "utf8",
        input: `${regularPaths.join("\n")}\n`,
        maxBuffer: 100 * 1024 * 1024,
        shell: false,
        windowsHide: true
      }
    );
    if (hashes.status !== 0) {
      throw new Error("fixlab exec could not fingerprint repository contents");
    }
    const values = hashes.stdout.trim().split(/\r?\n/u);
    if (values.length !== regularPaths.length) {
      throw new Error("fixlab exec received an incomplete content fingerprint");
    }
    for (const [index, path] of regularPaths.entries()) {
      contentHashes.push(`${path}\0${values[index]}`);
    }
  }
  for (const path of exceptionalPaths) {
    const hash = git(repository, ["hash-object", "--no-filters", "--", path]);
    if (hash.status !== 0) {
      throw new Error("fixlab exec could not fingerprint repository contents");
    }
    contentHashes.push(`${path}\0${hash.stdout.trim()}`);
  }
  contentHashes.sort();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  const profileHash = existsSync(profilePath)
    ? sha256(readFileSync(profilePath))
    : "";
  return {
    head: head.stdout.trim(),
    worktreeHash: sha256(`${status.stdout}\0${contentHashes.join("\0")}`),
    profileHash
  };
}

function reusableValidationCommand(command, args) {
  const executable = basename(command).toLowerCase().replace(/\.cmd|\.exe$/gu, "");
  const first = String(args[0] ?? "").toLowerCase();
  const second = String(args[1] ?? "").toLowerCase();

  if (executable === "dotnet") {
    return ["build", "test"].includes(first);
  }
  if (executable === "node") {
    return first === "--test";
  }
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    if (first === "test") {
      return true;
    }
    if (first !== "run") {
      return false;
    }
    return /^(?:build|check|format(?::check)?|lint|test(?::.+)?|type-?check|typecheck|validate)$/u.test(
      second
    );
  }
  if (executable === "npx") {
    return first === "playwright" && second === "test";
  }
  if (executable === "playwright") {
    return first === "test";
  }
  return false;
}

function describeTool(command, args) {
  const executable = basename(command)
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/gu, "");
  const first = String(args[0] ?? "").toLowerCase();
  const second = String(args[1] ?? "").toLowerCase();

  if (executable === "dotnet") {
    return first ? `dotnet ${first}` : "dotnet";
  }
  if (executable === "node") {
    return first === "--test" ? "Node.js test" : "Node.js";
  }
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    if (first === "run" && second) {
      return `${executable} run ${second}`;
    }
    return first ? `${executable} ${first}` : executable;
  }
  if (
    (executable === "npx" && first === "playwright") ||
    executable === "playwright"
  ) {
    return "Playwright";
  }
  if (executable === "npx" && ["eslint", "jest", "tsc", "vitest"].includes(first)) {
    return first === "tsc" ? "TypeScript" : first;
  }
  return executable || "command";
}

function summaryBudget(tool, status) {
  const value = String(tool).toLowerCase();
  if (/(?:typescript|eslint|dotnet build)/u.test(value)) {
    return { diagnostics: 30, tail: 12 };
  }
  if (/(?:test|jest|vitest|playwright)/u.test(value)) {
    return { diagnostics: 12, tail: 12 };
  }
  return {
    diagnostics: status === 0 ? 10 : MAX_DIAGNOSTICS,
    tail: MAX_TAIL_LINES
  };
}

function requiresWindowsCommandShell(command) {
  if (process.platform !== "win32") {
    return false;
  }
  const executable = basename(command).toLowerCase();
  return (
    /\.(?:bat|cmd)$/u.test(executable) ||
    ["npm", "npx", "pnpm", "yarn"].includes(executable)
  );
}

function quoteWindowsCommandArgument(value, commandPath = false) {
  const text = String(value);
  if (/[\r\n]/u.test(text)) {
    throw new Error("command arguments cannot contain newlines");
  }
  if (!commandPath && /[&|<>()^%!]/u.test(text)) {
    throw new Error(
      "Windows command-wrapper arguments cannot contain shell metacharacters"
    );
  }
  if (text.includes('"')) {
    throw new Error("Windows command-wrapper arguments cannot contain quotes");
  }
  return `"${text}"`;
}

function resolveWindowsNpmCommand(command, args) {
  if (
    process.platform !== "win32" ||
    basename(command).toLowerCase().replace(/\.cmd$/u, "") !== "npm"
  ) {
    return null;
  }
  const candidates = [
    process.env.npm_execpath,
    join(dirname(command), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  const npmCli = candidates.find(
    (candidate) =>
      basename(candidate).toLowerCase() === "npm-cli.js" &&
      existsSync(candidate)
  );
  return npmCli
    ? { command: process.execPath, args: [npmCli, ...args] }
    : null;
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > MAX_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `${name} must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`
    );
  }
  return number;
}

export function parseStructuredCommandArguments(
  args,
  defaultRepository = process.cwd()
) {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) {
    throw new Error(
      "usage: fixlab exec [repository] [--cwd <path>] [--stage <name>] [--reuse] [--timeout-seconds <seconds>] -- <command> [args...]"
    );
  }

  const options = args.slice(0, separator);
  const command = args[separator + 1];
  const commandArgs = args.slice(separator + 2);
  let repositoryArgument = "";
  let cwdArgument = ".";
  let stage = "validation";
  let reuse = false;
  let timeoutSeconds = 0;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--reuse") {
      reuse = true;
      continue;
    }
    if (["--cwd", "--stage", "--timeout-seconds"].includes(option)) {
      const value = options[index + 1];
      if (!value) {
        throw new Error(`${option} requires a value`);
      }
      if (option === "--cwd") {
        cwdArgument = value;
      } else if (option === "--stage") {
        stage = value.trim();
      } else {
        timeoutSeconds = parsePositiveInteger(value, option);
      }
      index += 1;
      continue;
    }
    if (option.startsWith("-")) {
      throw new Error(`unknown fixlab exec option: ${option}`);
    }
    if (repositoryArgument) {
      throw new Error("fixlab exec accepts at most one repository path");
    }
    repositoryArgument = option;
  }

  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(stage)) {
    throw new Error("--stage must be a lowercase name of up to 32 characters");
  }

  const repositoryCandidate = resolve(repositoryArgument || defaultRepository);
  if (
    !existsSync(repositoryCandidate) ||
    !statSync(repositoryCandidate).isDirectory()
  ) {
    throw new Error(
      `repository does not exist or is not a directory: ${repositoryCandidate}`
    );
  }
  const repository = realpathSync(repositoryCandidate);
  const cwdCandidate = resolve(repository, cwdArgument);
  if (!existsSync(cwdCandidate) || !statSync(cwdCandidate).isDirectory()) {
    throw new Error(`command working directory does not exist: ${cwdCandidate}`);
  }
  const cwd = realpathSync(cwdCandidate);
  if (!isContained(repository, cwd)) {
    throw new Error("--cwd must stay within the repository");
  }

  return {
    repository,
    cwd,
    stage,
    reuse,
    timeoutSeconds,
    command,
    commandArgs
  };
}

function pruneEvidence(root, now = Date.now()) {
  if (!existsSync(root)) {
    return;
  }
  const directories = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "cache" &&
        /^\d{8}T\d{6}-[a-f0-9-]+$/u.test(entry.name)
    )
    .map((entry) => {
      const path = join(root, entry.name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const entry of directories) {
    if (
      entry.mtimeMs < now - EVIDENCE_RETENTION_MS ||
      directories.indexOf(entry) >= MAX_EVIDENCE_DIRECTORIES
    ) {
      rmSync(entry.path, { recursive: true, force: true });
    }
  }
  const cacheDirectory = join(root, "cache");
  if (existsSync(cacheDirectory)) {
    const cacheFiles = readdirSync(cacheDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
      .map((entry) => {
        const path = join(cacheDirectory, entry.name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const [index, entry] of cacheFiles.entries()) {
      if (
        entry.mtimeMs < now - EVIDENCE_RETENTION_MS ||
        index >= MAX_EVIDENCE_DIRECTORIES
      ) {
        rmSync(entry.path, { force: true });
      }
    }
  }
}

function createCollector(path) {
  let capturedBytes = 0;
  let totalBytes = 0;
  let remainder = "";
  let truncated = false;
  const errors = [];
  const warnings = [];
  const errorSet = new Set();
  const warningSet = new Set();
  const tail = [];
  let lineCount = 0;
  let failed = null;
  let passed = null;
  let skipped = null;
  let cancelled = 0;
  let total = null;
  let suites = null;
  let durationMs = null;

  const appendSanitized = (value) => {
    if (capturedBytes >= MAX_CAPTURE_BYTES_PER_STREAM) {
      truncated = true;
      return;
    }
    const remaining = MAX_CAPTURE_BYTES_PER_STREAM - capturedBytes;
    const buffer = Buffer.from(value);
    const output = buffer.subarray(0, remaining);
    writeFileSync(path, output, { flag: "a", mode: 0o600 });
    capturedBytes += output.length;
    truncated = output.length < buffer.length;
  };

  const remember = (collection, seen, line) => {
    const key = line.toLowerCase();
    if (!seen.has(key) && collection.length < MAX_DIAGNOSTICS) {
      seen.add(key);
      collection.push(line);
    }
  };

  const inspectLine = (rawLine) => {
    const line = sanitize(rawLine).trim();
    lineCount += 1;
    if (!line) {
      return;
    }
    tail.push(line);
    if (tail.length > MAX_TAIL_LINES) {
      tail.shift();
    }
    if (
      /\b(?:error|exception|fatal|assertion failed|failed:)\b/iu.test(line) &&
      !/\b0\s+(?:error|errors|failed|failures)\b/iu.test(line)
    ) {
      remember(errors, errorSet, line);
    } else if (/\bwarning\b/iu.test(line)) {
      remember(warnings, warningSet, line);
    }

    const dotnet = line.match(
      /Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/iu
    );
    if (dotnet) {
      [, failed, passed, skipped, total] = dotnet.map(Number);
      return;
    }
    const jest = line.match(
      /Tests:\s*(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/iu
    );
    if (jest) {
      failed = Number(jest[1] ?? 0);
      skipped = Number(jest[2] ?? 0);
      passed = Number(jest[3] ?? 0);
      total = Number(jest[4]);
      return;
    }
    const playwright = line.match(
      /(?:(\d+)\s+failed(?:,\s*)?)?(?:(\d+)\s+skipped(?:,\s*)?)?(\d+)\s+passed/iu
    );
    if (playwright) {
      failed = Number(playwright[1] ?? 0);
      skipped = Number(playwright[2] ?? 0);
      passed = Number(playwright[3]);
      total = failed + skipped + passed;
      return;
    }
    const tap = line.match(
      /^(?:#|\u2139)?\s*(tests|suites|pass|fail|cancelled|skipped|duration_ms)\s+([\d.]+)$/iu
    );
    if (tap) {
      const value = Number(tap[2]);
      switch (tap[1].toLowerCase()) {
        case "tests":
          total = value;
          break;
        case "suites":
          suites = value;
          break;
        case "pass":
          passed = value;
          break;
        case "fail":
          failed = value;
          break;
        case "cancelled":
          cancelled = value;
          break;
        case "skipped":
          skipped = value;
          break;
        case "duration_ms":
          durationMs = value;
          break;
      }
    }
  };

  const write = (chunk) => {
    const text = chunk.toString();
    totalBytes += Buffer.byteLength(text);
    const lines = `${remainder}${text}`.split(/\r?\n/u);
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      const sanitizedLine = sanitize(line);
      appendSanitized(`${sanitizedLine}\n`);
      inspectLine(sanitizedLine);
    }
  };

  const finish = () => {
    if (remainder) {
      const sanitizedLine = sanitize(remainder);
      appendSanitized(sanitizedLine);
      inspectLine(sanitizedLine);
      remainder = "";
    }
    return {
      path,
      totalBytes,
      capturedBytes,
      truncated,
      lineCount,
      errors,
      warnings,
      tail,
      tests:
        total === null
          ? null
          : {
              failed: failed ?? 0,
              passed: passed ?? 0,
              skipped: skipped ?? 0,
              cancelled,
              total,
              suites,
              durationMs
            }
    };
  };

  return { write, finish };
}

function cacheFingerprint(options, state) {
  return sha256(
    JSON.stringify({
      version: 3,
      platform: process.platform,
      command: options.command,
      commandArgs: options.commandArgs,
      cwd: relative(options.repository, options.cwd),
      stage: options.stage,
      timeoutSeconds: options.timeoutSeconds,
      state
    })
  );
}

function diagnosticFingerprint(tool, line) {
  return sha256(
    `${String(tool).toLowerCase()}\0${String(line)
      .trim()
      .replace(/\s+/gu, " ")
      .toLowerCase()}`
  );
}

function resultErrors(result) {
  return [...result.stderr.errors, ...result.stdout.errors];
}

function previousDiagnostics(evidenceRoot, result) {
  const candidates = readdirSync(evidenceRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{8}T\d{6}-[a-f0-9-]+$/u.test(entry.name)
    )
    .map((entry) => {
      const directory = join(evidenceRoot, entry.name);
      return { directory, mtimeMs: statSync(directory).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 20);

  for (const candidate of candidates) {
    if (candidate.directory === result.evidenceDirectory) {
      continue;
    }
    const resultPath = join(candidate.directory, "result.json");
    if (!existsSync(resultPath)) {
      continue;
    }
    try {
      const previous = JSON.parse(readFileSync(resultPath, "utf8"));
      if (
        previous.displayCommand !== result.displayCommand ||
        previous.cwd !== result.cwd ||
        previous.stage !== result.stage
      ) {
        continue;
      }
      return {
        evidenceDirectory: candidate.directory,
        fingerprints: new Set(
          resultErrors(previous).map((line) =>
            diagnosticFingerprint(previous.tool, line)
          )
        )
      };
    } catch {
      // Ignore incomplete evidence from an interrupted command.
    }
  }
  return { evidenceDirectory: "", fingerprints: new Set() };
}

function summarizeDiagnostics(result, evidenceRoot) {
  const errors = resultErrors(result);
  const previous = previousDiagnostics(evidenceRoot, result);
  const newLines = [];
  const fingerprints = [];
  let repeatedCount = 0;
  for (const line of errors) {
    const fingerprint = diagnosticFingerprint(result.tool, line);
    fingerprints.push(fingerprint);
    if (previous.fingerprints.has(fingerprint)) {
      repeatedCount += 1;
    } else {
      newLines.push(line);
    }
  }
  return {
    fingerprints,
    newLines,
    newCount: newLines.length,
    repeatedCount,
    previousEvidenceDirectory: previous.evidenceDirectory
  };
}

function formatSummary(result, reused = false) {
  const lines = [
    `${reused ? "REUSED" : result.status === 0 ? "PASS" : "FAIL"} fixlab exec: ${result.displayCommand} (${(result.durationMs / 1000).toFixed(1)}s)`,
    `Tool: ${sanitize(result.tool ?? "command")}`
  ];
  const tests = result.stdout.tests ?? result.stderr.tests;
  if (tests) {
    lines.push(
      `Tests: ${tests.passed} passed, ${tests.failed} failed, ${tests.cancelled ?? 0} cancelled, ${tests.skipped} skipped, ${tests.total} total`
    );
  }
  const budget = summaryBudget(result.tool, result.status);
  const diagnosticSummary = result.diagnostics;
  const errors = (
    diagnosticSummary ? diagnosticSummary.newLines : resultErrors(result)
  ).slice(0, budget.diagnostics);
  if (errors.length > 0) {
    lines.push("Errors:");
    lines.push(...errors.map((line) => `- ${line}`));
    const omitted =
      (diagnosticSummary?.newCount ?? resultErrors(result).length) -
      errors.length;
    if (omitted > 0) {
      lines.push(`- ${omitted} additional new diagnostic(s) retained in evidence.`);
    }
  }
  if (diagnosticSummary?.repeatedCount > 0) {
    lines.push(
      `Diagnostics: ${diagnosticSummary.repeatedCount} unchanged from the previous matching command; omitted from this summary.`
    );
  }
  if (
    errors.length === 0 &&
    !diagnosticSummary?.repeatedCount &&
    result.status !== 0
  ) {
    const tail = [...result.stderr.tail, ...result.stdout.tail].slice(
      -budget.tail
    );
    if (tail.length > 0) {
      lines.push("Failure tail:");
      lines.push(...tail.map((line) => `- ${line}`));
    }
  }
  const warningCount =
    result.stderr.warnings.length + result.stdout.warnings.length;
  if (warningCount > 0) {
    lines.push(`Unique warnings retained: ${warningCount}`);
  }
  if (result.stdout.truncated || result.stderr.truncated) {
    lines.push(
      `Evidence capture reached the ${MAX_CAPTURE_BYTES_PER_STREAM / 1024 / 1024} MiB per-stream safety limit.`
    );
  }
  lines.push(`Evidence: ${result.evidenceDirectory}`);
  lines.push(
    `Inspect: fixlab evidence show ${basename(result.evidenceDirectory)} --stream stderr --lines ${DEFAULT_EVIDENCE_SHOW_LINES}`
  );
  const rawBytes = result.stdout.totalBytes + result.stderr.totalBytes;
  const rawLines = result.stdout.lineCount + result.stderr.lineCount;
  const structuredLines = lines.length + 1;
  let structuredBytes = Buffer.byteLength(`${lines.join("\n")}\n`);
  let text = "";
  let metrics = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reductionPercent =
      rawBytes > 0
        ? Math.max(0, 100 - (structuredBytes / rawBytes) * 100)
        : 0;
    metrics = {
      rawBytes,
      structuredBytes,
      estimatedRawTokens: Math.ceil(rawBytes / 4),
      estimatedStructuredTokens: Math.ceil(structuredBytes / 4),
      reductionPercent: Number(reductionPercent.toFixed(1)),
      rawLines,
      structuredLines,
      omittedLines: Math.max(0, rawLines - structuredLines)
    };
    const contextLine =
      `Context: ${metrics.rawLines} raw lines / ${metrics.rawBytes} bytes ` +
      `(~${metrics.estimatedRawTokens} tokens) -> ${metrics.structuredLines} summary lines / ` +
      `${metrics.structuredBytes} bytes (~${metrics.estimatedStructuredTokens} tokens), ` +
      `${metrics.reductionPercent.toFixed(1)}% reduction; ${metrics.omittedLines} lines omitted`;
    text = `${[...lines, contextLine].join("\n")}\n`;
    const nextStructuredBytes = Buffer.byteLength(text);
    if (nextStructuredBytes === structuredBytes) {
      metrics.structuredBytes = nextStructuredBytes;
      metrics.estimatedStructuredTokens = Math.ceil(nextStructuredBytes / 4);
      break;
    }
    structuredBytes = nextStructuredBytes;
  }
  return { text, metrics };
}

function readReusableResult(cachePath) {
  if (!existsSync(cachePath)) {
    return null;
  }
  try {
    const result = JSON.parse(readFileSync(cachePath, "utf8"));
    return result?.status === 0 && existsSync(result.evidenceDirectory)
      ? result
      : null;
  } catch {
    return null;
  }
}

export async function executeStructuredCommand(options, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const now = io.now ?? Date.now;
  const spawnProcess = io.spawn ?? spawn;
  const terminationGraceMs = io.terminationGraceMs ?? 5000;
  const evidenceRoot = resolveEvidenceRoot(options.repository);
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  pruneEvidence(evidenceRoot, now());

  const state = repositoryState(options.repository);
  const fingerprint = cacheFingerprint(options, state);
  const cacheDirectory = join(evidenceRoot, "cache");
  const cachePath = join(cacheDirectory, `${fingerprint}.json`);
  const reusable =
    options.reuse &&
    reusableValidationCommand(options.command, options.commandArgs);
  if (reusable) {
    const cached = readReusableResult(cachePath);
    if (cached) {
      stdout.write(formatSummary(cached, true).text);
      return 0;
    }
  } else if (options.reuse) {
    stderr.write(
      "Reuse ignored: this command is not an eligible deterministic local validation.\n"
    );
  }

  const timestamp = new Date(now())
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "");
  const evidenceDirectory = join(
    evidenceRoot,
    `${timestamp}-${randomUUID()}`
  );
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const stdoutCollector = createCollector(join(evidenceDirectory, "stdout.log"));
  const stderrCollector = createCollector(join(evidenceDirectory, "stderr.log"));
  const startedAt = now();
  const displayCommand = sanitize(
    [options.command, ...options.commandArgs].join(" ")
  );
  const windowsNpmCommand = resolveWindowsNpmCommand(
    options.command,
    options.commandArgs
  );
  const windowsCommandShell =
    !windowsNpmCommand && requiresWindowsCommandShell(options.command);
  const windowsBatchFile = /\.(?:bat|cmd)$/iu.test(options.command);
  const shellCommand = windowsCommandShell
    ? [
        /\s/u.test(options.command)
          ? quoteWindowsCommandArgument(options.command, true)
          : options.command,
        ...options.commandArgs.map((argument) =>
          quoteWindowsCommandArgument(argument)
        )
      ].join(" ")
    : options.command;
  const spawnedCommand =
    windowsCommandShell && windowsBatchFile
      ? `call ${shellCommand}`
      : shellCommand;
  const executable = windowsCommandShell
    ? process.env.ComSpec || "cmd.exe"
    : windowsNpmCommand?.command || spawnedCommand;
  const spawnedArguments = windowsCommandShell
    ? ["/d", "/v:off", "/c", spawnedCommand]
    : windowsNpmCommand?.args || options.commandArgs;

  const status = await new Promise((resolveStatus) => {
    let settled = false;
    let timedOut = false;
    let timeout = null;
    let forceTimeout = null;
    let abandonTimeout = null;
    const clearTimers = () => {
      for (const timer of [timeout, forceTimeout, abandonTimeout]) {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
    const child = spawnProcess(executable, spawnedArguments, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      windowsVerbatimArguments: windowsCommandShell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", stdoutCollector.write);
    child.stderr.on("data", stderrCollector.write);
    child.on("error", (error) => {
      stderrCollector.write(`${error.message}\n`);
      if (!settled) {
        settled = true;
        clearTimers();
        let exitCode = 1;
        if (timedOut) {
          exitCode = 124;
        } else if (error.code === "ENOENT") {
          exitCode = 127;
        }
        resolveStatus(exitCode);
      }
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimers();
        if (signal) {
          stderrCollector.write(`Command terminated by signal ${signal}.\n`);
        }
        let exitCode = 1;
        if (timedOut) {
          exitCode = 124;
        } else if (Number.isInteger(code)) {
          exitCode = code;
        }
        resolveStatus(exitCode);
      }
    });
    if (options.timeoutSeconds > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        stderrCollector.write(
          `Command exceeded ${options.timeoutSeconds} second(s) and was terminated.\n`
        );
        child.kill("SIGTERM");
        forceTimeout = setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
            abandonTimeout = setTimeout(() => {
              if (!settled) {
                settled = true;
                child.stdout.destroy();
                child.stderr.destroy();
                resolveStatus(124);
              }
            }, terminationGraceMs);
          }
        }, terminationGraceMs);
      }, options.timeoutSeconds * 1000);
    }
  });

  const result = {
    version: 3,
    status,
    stage: options.stage,
    displayCommand,
    tool: sanitize(describeTool(options.command, options.commandArgs)),
    cwd: relative(options.repository, options.cwd) || ".",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    durationMs: Math.max(0, now() - startedAt),
    repositoryState: state,
    fingerprint,
    evidenceDirectory,
    stdout: stdoutCollector.finish(),
    stderr: stderrCollector.finish()
  };
  result.diagnostics = summarizeDiagnostics(result, evidenceRoot);
  const summary = formatSummary(result);
  result.context = summary.metrics;
  writeFileSync(
    join(evidenceDirectory, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 }
  );
  if (reusable && status === 0) {
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(cachePath, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600
    });
  }
  (status === 0 ? stdout : stderr).write(summary.text);
  return status;
}

export function parseStructuredEvidenceArguments(
  args,
  defaultRepository = process.cwd()
) {
  let index = 0;
  let repositoryArgument = "";
  if (args[index] !== "show") {
    repositoryArgument = args[index] ?? "";
    index += 1;
  }
  if (args[index] !== "show" || !args[index + 1]) {
    throw new Error(
      "usage: fixlab evidence [repository] show <evidence-id> [--stream <summary|stdout|stderr>] [--lines <count>]"
    );
  }
  const evidenceId = args[index + 1];
  if (!/^\d{8}T\d{6}-[a-f0-9-]+$/u.test(evidenceId)) {
    throw new Error("evidence-id must be the identifier printed by fixlab exec");
  }
  index += 2;
  let stream = "summary";
  let lines = DEFAULT_EVIDENCE_SHOW_LINES;
  while (index < args.length) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--stream" && value) {
      if (!["summary", "stdout", "stderr"].includes(value)) {
        throw new Error("--stream must be summary, stdout, or stderr");
      }
      stream = value;
      index += 2;
      continue;
    }
    if (option === "--lines" && value) {
      lines = parsePositiveInteger(value, "--lines");
      if (lines > MAX_EVIDENCE_SHOW_LINES) {
        throw new Error(
          `--lines must be at most ${MAX_EVIDENCE_SHOW_LINES}`
        );
      }
      index += 2;
      continue;
    }
    throw new Error(`unknown fixlab evidence option: ${option}`);
  }

  const repositoryCandidate = resolve(repositoryArgument || defaultRepository);
  if (
    !existsSync(repositoryCandidate) ||
    !statSync(repositoryCandidate).isDirectory()
  ) {
    throw new Error(
      `repository does not exist or is not a directory: ${repositoryCandidate}`
    );
  }
  const repository = realpathSync(repositoryCandidate);
  const evidenceRoot = resolveEvidenceRoot(repository);
  const evidenceDirectory = resolve(evidenceRoot, evidenceId);
  if (
    !isContained(evidenceRoot, evidenceDirectory) ||
    !existsSync(evidenceDirectory) ||
    !statSync(evidenceDirectory).isDirectory()
  ) {
    throw new Error(`structured command evidence was not found: ${evidenceId}`);
  }
  return { repository, evidenceDirectory, evidenceId, stream, lines };
}

export function showStructuredEvidence(
  args,
  defaultRepository = process.cwd(),
  io = {}
) {
  const stdout = io.stdout ?? process.stdout;
  const options = parseStructuredEvidenceArguments(args, defaultRepository);
  const resultPath = join(options.evidenceDirectory, "result.json");
  if (!existsSync(resultPath)) {
    throw new Error(`structured command result is incomplete: ${options.evidenceId}`);
  }
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (options.stream === "summary") {
    stdout.write(formatSummary(result).text);
    return 0;
  }
  const streamPath = join(options.evidenceDirectory, `${options.stream}.log`);
  if (!existsSync(streamPath)) {
    stdout.write(`${options.stream} evidence is empty.\n`);
    return 0;
  }
  const content = readFileSync(streamPath, "utf8");
  const available = content.split(/\r?\n/u);
  while (available.at(-1) === "") {
    available.pop();
  }
  const selected = available.slice(-options.lines);
  stdout.write(`${selected.join("\n")}\n`);
  return 0;
}

export async function runStructuredCommand(
  args,
  defaultRepository = process.cwd(),
  io = {}
) {
  const options = parseStructuredCommandArguments(args, defaultRepository);
  return executeStructuredCommand(options, io);
}
