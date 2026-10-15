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

export function validationGates(profile, mode) {
  if (mode === "playwright-only") {
    return [];
  }
  const gates = profile.validation?.gates;
  if (gates === undefined) {
    return null;
  }
  if (!Array.isArray(gates) || gates.length < 1 || gates.length > 20) {
    throw new Error("validation.gates must contain between 1 and 20 required gates.");
  }
  const ids = new Set();
  return gates.map((gate) => {
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
}

export class ValidationSession {
  constructor(repository, profile, mode) {
    this.repository = realpathSync(repository);
    this.gates = validationGates(profile, mode);
    this.profile = JSON.stringify(profile);
    this.results = new Map();
    this.target = null;
    this.active = null;
    this.error = null;
  }

  summary() {
    let status = "pending";
    if (this.error) {
      status = "blocked";
    } else if (this.gates === null) {
      status = "unconfigured";
    } else if (this.gates.every((gate) => this.results.get(gate.id)?.status === "passed")) {
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
      message: this.error ?? (this.gates === null
        ? "Configure validation.gates for executor-backed readiness."
        : "Required gates use dashboard-owned execution; agent markers are not evidence."),
      gates: (this.gates ?? []).map((gate) => ({
        id: gate.id,
        ...Object.fromEntries(Object.entries(
          this.results.get(gate.id) ?? { status: "pending" }
        ).filter(([key]) => key !== "state"))
      }))
    };
  }

  cancel() {
    this.active?.abort();
  }

  verify() {
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
        : status !== 0
          ? "failed"
          : state !== after
            ? "stale"
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
