import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  executeStructuredCommand,
  repositoryState,
  reusableValidationCommand
} from "../bin/structured-command.js";
import { automaticValidationPolicy, affectedApplications, requiresFullValidation } from "./affected-surface.js";

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

function scopePaths(values, label = "validation.apiOnly") {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    throw new Error(`${label} path lists need between 1 and 100 repository-relative paths.`);
  }
  return values.map((value) => {
    const path = typeof value === "string" ? value.replace(/\\/gu, "/").replace(/\/$/u, "") : "";
    if (!path || path.length > 500 || /[:*?[\]\0\r\n]/u.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`${label} paths must be literal repository-relative files or directories.`);
    }
    return path;
  });
}

function validationScopePolicy(profile, gates) {
  if (profile.validation?.changeAware !== undefined) {
    if (profile.validation.apiOnly !== undefined) {
      throw new Error("validation.changeAware cannot combine with validation.apiOnly.");
    }
    const policy = profile.validation.changeAware;
    const label = "validation.changeAware";
    if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
        typeof policy.baseRef !== "string" || !policy.baseRef.trim() ||
        policy.baseRef.length > 200 || /[\s\0]/u.test(policy.baseRef) ||
        policy.baseRef.startsWith("-") ||
        !Array.isArray(policy.scopes) || policy.scopes.length < 1 || policy.scopes.length > 100) {
      throw new Error(`${label} needs a baseRef and between 1 and 100 scopes.`);
    }
    return {
      baseRef: policy.baseRef,
      fullValidationPaths: scopePaths(policy.fullValidationPaths, label),
      scopes: policy.scopes.map((scope) => {
        if (!scope || !Array.isArray(scope.gateIds) || scope.gateIds.length < 1 ||
            new Set(scope.gateIds).size !== scope.gateIds.length ||
            scope.gateIds.some((id) => !gates?.some((gate) => gate.id === id))) {
          throw new Error(`${label} scopes need unique gateIds from validation.gates.`);
        }
        return { paths: scopePaths(scope.paths, label), gateIds: [...scope.gateIds] };
      })
    };
  }
  const policy = profile.validation?.apiOnly;
  if (policy === undefined) {
    return automaticValidationPolicy(profile, gates);
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
    validationScopePolicy(profile, null);
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
      (gate.required !== undefined && typeof gate.required !== "boolean") ||
      (gate.kind !== undefined && !["tests", "builds", "checks"].includes(gate.kind)) ||
      (gate.stage !== undefined && !["review", "local-stack", "live-test", "fix", "pr"].includes(gate.stage)) ||
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
      required: gate.required === true,
      kind: gate.kind ?? (/^(?:test|test:|--test)/.test(gate.args[0] === "run" ? gate.args[1] ?? "" : gate.args[0] ?? "")
        ? "tests" : gate.args.includes("build") ? "builds" : "checks"),
      stage: gate.stage ?? "review",
      timeoutSeconds: gate.timeoutSeconds
    };
  });
  validationScopePolicy(profile, normalized);
  return normalized;
}

export function selectedValidationGates(gates, selection, value) {
  if (!Array.isArray(gates) || !["all", "tests", "builds", "gate", "stage"].includes(selection) ||
      (["gate", "stage"].includes(selection) && typeof value !== "string")) {
    throw new Error("Select configured all, tests, builds, gate or stage validation.");
  }
  const selected = gates.filter((gate) => selection === "all" ||
    (selection === "gate" ? gate.id === value : selection === "stage" ? gate.stage === value : gate.kind === selection));
  if (!selected.length) {throw new Error("No configured validation gates match this selection.");}
  return selected;
}

export function defaultValidationIntent(profile, mode = "fix-and-validate") {
  if (mode === "playwright-only") { return "full"; }
  return validationScopePolicy(profile, validationGates(profile, "fix-and-validate")) ? "affected" : "full";
}

export class ValidationSession {
  constructor(repository, profile, mode, {
    validationIntent, baseCommit, history = { complete: true, gates: [] }, advisory = false
  } = {}) {
    this.repository = realpathSync(repository);
    this.gates = validationGates(profile, mode);
    this.policy = mode === "playwright-only" ? null : validationScopePolicy(profile, this.gates);
    this.validationIntent = validationIntent ?? defaultValidationIntent(profile, mode);
    this.advisory = advisory && profile.workflow?.mode !== "strict";
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
    this.applicationProfile = profile;
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
        return { scope: "all", reason: "No changed files establish a reviewed change scope; all configured gates are required." };
      }
      const scopes = this.policy.scopes ?? [{ paths: this.policy.paths, gateIds: this.policy.gateIds }];
      const gateIds = new Set();
      const componentNames = new Set();
      for (const path of changes) {
        const matching = scopes.filter((scope) => matchesScopePath(path, scope.paths));
        if (matchesScopePath(path, this.policy.fullValidationPaths) || matching.length === 0 ||
            (this.policy.automatic && requiresFullValidation(path))) {
          return { scope: "all", reason: "Changes include contract, shared, frontend, or unclassified paths; all configured gates are required." };
        }
        for (const scope of matching) {
          scope.gateIds.forEach((id) => gateIds.add(id));
          if (scope.name) { componentNames.add(scope.name); }
        }
      }
      if (this.policy.scopes) {
        const applications = this.policy.automatic
          ? affectedApplications(this.applicationProfile, [...componentNames]) : null;
        return {
          scope: "affected", gateIds: [...gateIds],
          ...(this.policy.automatic ? {
            components: [...componentNames],
            ...applications,
            browserApplicable: applications.browserApplicable || this.gates.some((gate) =>
              gate.stage === "live-test" && (gateIds.has(gate.id) || this.results.has(gate.id)))
          } : {}),
          reason: this.policy.automatic
            ? "Changed paths match profile components and gate working directories. Global and explicitly required gates plus previously executed gates remain required."
            : "Changed paths match reviewed component scopes; their combined gate sets are required. Previously executed gates remain required."
        };
      }
      return { scope: "api-only", reason: "API-only changes match the reviewed repository policy; unexecuted gates outside the API gate set are not applicable. Previously executed gates remain required." };
    } catch (error) {
      return { scope: "all", reason: error.message };
    }
  }

  required(gate, scope) {
    if (scope === "all" || this.results.has(gate.id)) {
      return true;
    }
    const gateIds = scope === "api-only" ? this.policy.gateIds : this.scopeResult.gateIds;
    return gateIds.includes(gate.id);
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

  blocking(gate, scope) {
    return this.required(gate, scope) && (!this.advisory || gate.required);
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
    } else if (this.advisory && !this.gates.some((gate) => this.blocking(gate, scope))) {
      status = "advisory";
    } else if (this.gates.every((gate) =>
      !this.blocking(gate, scope) || this.results.get(gate.id)?.status === "passed"
    )) {
      status = "passed";
    } else if (this.active) {
      status = "running";
    } else if (this.gates.some((gate) => this.blocking(gate, scope) &&
      ["failed", "cancelled", "stale"].includes(this.results.get(gate.id)?.status)
    )) {
      status = "blocked";
    }
    return {
      status,
      scope,
      reason,
      ...(this.scopeResult.components && this.validationIntent === "affected" ? {
        components: this.scopeResult.components,
        applications: this.scopeResult.applications,
        browserApplicable: this.scopeResult.browserApplicable
      } : {}),
      fullValidationPassed: !this.error && this.gates !== null && this.gates.every((gate) =>
        !this.required(gate, scope) || this.results.get(gate.id)?.status === "passed"),
      message: this.error ?? (this.gates === null
        ? "Configure validation.gates for executor-backed readiness."
        : this.advisory
          ? "Efficient delivery: only explicitly required local gates block publication. Optional checks retain their real pending, failed or stale status; ready for review does not mean fully validated."
        : scope === "api-only"
          ? `${status === "passed" ? "API-scope validation passed." : "API-scope validation."} ${reason}`
          : scope === "affected"
            ? `Component-scope validation ${status}. ${reason}`
            : `Required gates use dashboard-owned execution; agent markers are not evidence. ${reason}`),
      gates: (this.gates ?? []).map((gate) => ({
        id: gate.id,
        kind: gate.kind,
        stage: gate.stage,
        required: this.blocking(gate, scope),
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
    if (io.jobId !== undefined && (typeof io.jobId !== "string" || !/^[a-f0-9-]{36}$/i.test(io.jobId))) {
      throw new Error("Validation evidence requires a valid owning job ID.");
    }
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
        ownProcessTree: true,
        repositoryState: inputs,
        onResult: (result) => {
          evidence = result;
          if (result.terminationVerified === false) {this.terminationUnverified = true;}
          if (io.jobId !== undefined) {
            writeFileSync(join(result.evidenceDirectory, "job.json"), JSON.stringify({
              jobId: io.jobId, repository: realpathSync.native(repository), gateId: id
            }), { mode: 0o600, flag: "wx" });
          }
        }
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
