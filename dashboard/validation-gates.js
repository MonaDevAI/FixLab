import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  executeStructuredCommand,
  repositoryState,
  reusableValidationCommand
} from "../bin/structured-command.js";

function gitPath(repository, argument) {
  const result = spawnSync("git", ["rev-parse", argument], {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("Validation requires a Git repository with a committed HEAD.");
  }
  return realpathSync(resolve(repository, result.stdout.trim()));
}

function containedDirectory(repository, value) {
  const directory = realpathSync(resolve(repository, value));
  const child = relative(repository, directory);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Validation workingDirectory must stay inside the worktree.");
  }
  return directory;
}

function scopeGit(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error("Could not verify the complete Git change set; all configured gates are required.");
  }
  return result.stdout;
}

function scopePaths(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    throw new Error("validation.apiOnly path lists need between 1 and 100 repository-relative paths.");
  }
  return values.map((value) => {
    const path = typeof value === "string" ? value.replace(/\\/gu, "/").replace(/\/$/u, "") : "";
    if (!path || path.length > 500 || /[:*?[\]\0\r\n]/u.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("validation.apiOnly paths must be literal repository-relative files or directories.");
    }
    return path;
  });
}

function apiOnlyPolicy(profile, gates) {
  const policy = profile.validation?.apiOnly;
  if (policy === undefined) {
    return null;
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
      typeof policy.baseRef !== "string" || !policy.baseRef.trim() ||
      policy.baseRef.length > 200 || /[\s\0]/u.test(policy.baseRef) ||
      policy.baseRef.startsWith("-") ||
      !Array.isArray(policy.gateIds) || policy.gateIds.length < 1 ||
      new Set(policy.gateIds).size !== policy.gateIds.length ||
      policy.gateIds.some((id) => !gates?.some((gate) => gate.id === id))) {
    throw new Error("validation.apiOnly needs a baseRef and unique gateIds from validation.gates.");
  }
  return {
    baseRef: policy.baseRef,
    paths: scopePaths(policy.paths),
    fullValidationPaths: scopePaths(policy.fullValidationPaths),
    gateIds: [...policy.gateIds]
  };
}

function matchesScopePath(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function restoredValidationHistory(gates, history) {
  const results = new Map();
  if (history === null) {
    return { complete: false, results };
  }
  if (!history || typeof history.complete !== "boolean" ||
      !Array.isArray(history.gates) || history.gates.length > 20) {
    throw new Error("Saved validation history is invalid; start a new reviewed job.");
  }
  for (const entry of history.gates) {
    if (!entry || !gates?.some((gate) => gate.id === entry.id) ||
        results.has(entry.id) ||
        !["passed", "failed", "stale", "cancelled", "running"].includes(entry.status) ||
        (entry.exitCode !== undefined && !Number.isSafeInteger(entry.exitCode))) {
      throw new Error("Saved validation history is invalid; start a new reviewed job.");
    }
    const status = ["failed", "cancelled"].includes(entry.status) ? entry.status : "stale";
    results.set(entry.id, {
      status,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      reason: status === "stale"
        ? "Saved execution is not fresh evidence; rerun this required gate after recovery."
        : "Previous execution did not pass; this gate remains required after recovery."
    });
  }
  return { complete: history.complete, results };
}

export function validationGates(profile, mode) {
  if (mode === "playwright-only") {
    return [];
  }
  const gates = profile.validation?.gates;
  if (gates === undefined) {
    apiOnlyPolicy(profile, null);
    return null;
  }
  if (!Array.isArray(gates) || gates.length < 1 || gates.length > 20) {
    throw new Error("validation.gates must contain between 1 and 20 required gates.");
  }
  const ids = new Set();
  const normalized = gates.map((gate) => {
    if (
      !gate ||
      typeof gate.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/u.test(gate.id) ||
      ids.has(gate.id) ||
      typeof gate.command !== "string" ||
      !gate.command.trim() ||
      !Array.isArray(gate.args) ||
      gate.args.some((argument) => typeof argument !== "string") ||
      typeof gate.workingDirectory !== "string" ||
      (gate.reuse !== undefined && typeof gate.reuse !== "boolean") ||
      !Number.isInteger(gate.timeoutSeconds) ||
      gate.timeoutSeconds < 1 ||
      gate.timeoutSeconds > 7200
    ) {
      throw new Error("Each validation gate needs a unique id, command, string args, workingDirectory, and timeoutSeconds (1-7200).");
    }
    ids.add(gate.id);
    return {
      id: gate.id,
      command: gate.command,
      args: [...gate.args],
      workingDirectory: gate.workingDirectory,
      reuse: gate.reuse === true && reusableValidationCommand(gate.command, gate.args),
      timeoutSeconds: gate.timeoutSeconds
    };
  });
  apiOnlyPolicy(profile, normalized);
  return normalized;
}

export class ValidationSession {
  constructor(repository, profile, mode, {
    validationIntent = "full", baseCommit, history = { complete: true, gates: [] }
  } = {}) {
    this.repository = realpathSync(repository);
    this.gates = validationGates(profile, mode);
    this.policy = mode === "playwright-only" ? null : apiOnlyPolicy(profile, this.gates);
    this.validationIntent = validationIntent;
    this.baseCommit = null;
    this.scopeWarning = "";
    if (this.policy) {
      try {
        if (baseCommit === undefined) {
          const reference = scopeGit(this.repository, [
            "rev-parse", "--verify", "--end-of-options", `${this.policy.baseRef}^{commit}`
          ]).trim();
          this.baseCommit = scopeGit(this.repository, ["merge-base", "HEAD", reference]).trim();
        } else if (typeof baseCommit === "string" && /^[a-f0-9]{40,64}$/u.test(baseCommit)) {
          this.baseCommit = baseCommit;
        } else {
          this.scopeWarning = "No verified saved validation baseline; all configured gates are required.";
        }
      } catch (error) {
        this.scopeWarning = error.message;
      }
    }
    this.profile = JSON.stringify(profile);
    const restored = restoredValidationHistory(this.gates, history);
    this.results = restored.results;
    this.historyComplete = restored.complete;
    this.target = null;
    this.active = null;
    this.error = null;
    this.scopeResult = this.changeScope();
  }

  changeScope() {
    if (!this.policy || this.validationIntent !== "affected") {
      return { scope: "all", reason: "All configured gates are required by the selected validation policy." };
    }
    if (!this.historyComplete) {
      return { scope: "all", reason: "Saved executed-gate history is unavailable; all configured gates are required." };
    }
    if (!this.baseCommit) {
      return { scope: "all", reason: this.scopeWarning };
    }
    const repository = this.target ?? this.repository;
    try {
      scopeGit(repository, ["merge-base", "--is-ancestor", this.baseCommit, "HEAD"]);
      const changes = new Set([
        scopeGit(repository, ["diff", "--name-only", "--no-renames", "-z", this.baseCommit, "HEAD", "--"]),
        scopeGit(repository, ["diff", "--name-only", "--no-renames", "-z", this.baseCommit, "--"]),
        scopeGit(repository, ["diff", "--cached", "--name-only", "--no-renames", "-z", this.baseCommit, "--"]),
        scopeGit(repository, ["ls-files", "--others", "--exclude-standard", "-z"])
      ].flatMap((output) => output.split("\0").filter(Boolean)));
      if (changes.size === 0) {
        return { scope: "all", reason: "No changed files establish an API-only scope; all configured gates are required." };
      }
      for (const path of changes) {
        if (matchesScopePath(path, this.policy.fullValidationPaths) ||
            !matchesScopePath(path, this.policy.paths)) {
          return { scope: "all", reason: "Changes include contract, shared, frontend, or unclassified paths; all configured gates are required." };
        }
      }
      return { scope: "api-only", reason: "API-only changes match the reviewed repository policy; unexecuted gates outside the API gate set are not applicable. Previously executed gates remain required." };
    } catch (error) {
      return { scope: "all", reason: error.message };
    }
  }

  required(gate, scope) {
    return scope !== "api-only" || this.policy.gateIds.includes(gate.id) || this.results.has(gate.id);
  }

  executedGates() {
    return {
      complete: this.historyComplete,
      gates: [...this.results].map(([id, result]) => ({
        id,
        status: result.status,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode })
      }))
    };
  }

  summary() {
    // Refresh scope at validation checkpoints, not on every dashboard poll.
    const { scope, reason } = this.validationIntent === "affected"
      ? this.scopeResult
      : { scope: "all", reason: "All configured gates are required by the selected validation policy." };
    let status = "pending";
    if (this.error) {
      status = "blocked";
    } else if (this.gates === null) {
      status = "unconfigured";
    } else if (this.gates.every((gate) =>
      !this.required(gate, scope) || this.results.get(gate.id)?.status === "passed"
    )) {
      status = "passed";
    } else if (this.active) {
      status = "running";
    } else if ([...this.results.values()].some((result) =>
      ["failed", "cancelled", "stale"].includes(result.status)
    )) {
      status = "blocked";
    }
    return {
      status,
      scope,
      reason,
      message: this.error ?? (this.gates === null
        ? "Configure validation.gates for executor-backed readiness."
        : scope === "api-only"
          ? `${status === "passed" ? "API-scope validation passed." : "API-scope validation."} ${reason}`
          : `Required gates use dashboard-owned execution; agent markers are not evidence. ${reason}`),
      gates: (this.gates ?? []).map((gate) => ({
        id: gate.id,
        required: this.required(gate, scope),
        ...Object.fromEntries(Object.entries(
          this.results.get(gate.id) ?? (this.required(gate, scope)
            ? { status: "pending" }
            : { status: "not-applicable", reason })
        ).filter(([key]) => key !== "state"))
      }))
    };
  }

  cancel() {
    this.active?.abort();
  }

  verify() {
    this.scopeResult = this.changeScope();
    if (!this.gates?.length || !this.target) {
      return this.summary();
    }
    for (const repository of new Set([this.repository, this.target])) {
      const profile = JSON.parse(readFileSync(
        join(repository, ".github", "fixlab", "repository-profile.json"),
        "utf8"
      ));
      if (JSON.stringify(profile) !== this.profile) {
        this.error = "Repository profile changed; start a new job with reviewed gates.";
        return this.summary();
      }
    }
    const state = JSON.stringify(repositoryState(this.target));
    for (const [id, result] of this.results) {
      if (result.status === "passed" && result.state !== state) {
        this.results.set(id, { ...result, status: "stale" });
      }
    }
    return this.summary();
  }

  async run(id, target, profile, io = {}) {
    if (this.active) {
      throw new Error("A validation gate is already running for this job.");
    }
    const gate = this.gates?.find((candidate) => candidate.id === id);
    if (!gate) {
      throw new Error("Unknown required validation gate.");
    }
    if (JSON.stringify(profile) !== this.profile) {
      this.error = "Repository profile changed; start a new job with reviewed gates.";
      throw new Error(this.error);
    }
    const repository = realpathSync(target);
    if (
      gitPath(this.repository, "--git-common-dir") !== gitPath(repository, "--git-common-dir") ||
      gitPath(repository, "--show-toplevel") !== repository
    ) {
      throw new Error("Validation target must be this repository or one of its Git worktrees.");
    }
    if (this.target && this.target !== repository) {
      throw new Error("All gates in a job must validate the same worktree.");
    }
    this.target = repository;
    this.scopeResult = this.changeScope();
    const { scope, reason } = this.scopeResult;
    if (!this.required(gate, scope)) {
      return {
        status: 0,
        outcome: "not-applicable",
        summary: `NOT APPLICABLE ${id}: ${reason}\n`
      };
    }
    const cwd = containedDirectory(repository, gate.workingDirectory);
    const inputs = repositoryState(repository);
    const state = JSON.stringify(inputs);
    const previous = this.results.get(id);
    if (gate.reuse && previous?.status === "passed" && previous.state === state) {
      return { status: 0, reused: true, summary: `PASS ${id}: unchanged job-local evidence reused.\n` };
    }
    const controller = new AbortController();
    this.active = controller;
    this.results.set(id, { status: "running" });
    let summary = "";
    let evidence;
    const output = { write: (text) => { summary += text; } };
    try {
      const status = await executeStructuredCommand({
        repository,
        cwd,
        stage: "validation",
        command: gate.command,
        commandArgs: gate.args,
        timeoutSeconds: gate.timeoutSeconds,
        reuse: false
      }, {
        ...io,
        stdout: output,
        stderr: output,
        signal: controller.signal,
        repositoryState: inputs,
        onResult: (result) => { evidence = result; }
      });
      const after = JSON.stringify(repositoryState(repository));
      const gateStatus = controller.signal.aborted
        ? "cancelled"
        : state !== after
          ? "stale"
          : status !== 0
            ? "failed"
            : "passed";
      this.results.set(id, {
        status: gateStatus,
        exitCode: status,
        state,
        durationMs: evidence.durationMs,
        context: evidence.context,
        evidenceDirectory: evidence.evidenceDirectory
      });
      return {
        status: gateStatus === "passed" ? 0 : status || 1,
        summary: `${summary}${gateStatus === "stale" ? "FAIL: source inputs changed during validation; rerun the gate.\n" : ""}`,
        reused: false
      };
    } catch (error) {
      this.results.set(id, { status: "failed" });
      throw error;
    } finally {
      this.active = null;
    }
  }
}
