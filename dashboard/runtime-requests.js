import { randomUUID } from "node:crypto";

export const MAX_RUNTIME_REQUESTS = 8;
export const MAX_RUNTIME_FRAME_BYTES = 1024 * 1024;
const secret = /authorization|bearer\s|(?:password|passwd|secret|token|cookie|api[_-]?key)\s*["':=]|(?:gh[pousr]_|github_pat_|eyJ)[A-Za-z0-9_-]{16,}|https?:\/\/[^/\s]+:[^/\s]+@|[?&](?:sig|code|key|access_token|client_secret)=|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const credentialQuestion = /(?:enter|provide|paste|type|share|input|tell|send|copy|what is|what's).{0,80}(?:password|verification code|one.time code|MFA code|access token|cookie|secret)/i;
const credentialPath = /(?:^|[\\/])(?:\.auth|\.edge-profile|\.ssh|\.aws|\.azure|\.env(?:\.[^\\/]*)?|credentials(?:\.[^\\/]*)?)(?:[\\/]|$)/i;

export function safeRuntimeText(value, limit = 8192) {
  return typeof value === "string" && value.length <= limit &&
    !secret.test(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

export function validateRuntimeUsage(value, previous = {}) {
  const usage = {};
  for (const name of ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"]) {
    if (!Number.isSafeInteger(value?.[name]) || value[name] < (previous[name] ?? 0)) {
      throw new Error("Copilot sent invalid or decreasing structured usage counters.");
    }
    usage[name] = value[name];
  }
  if (usage.cachedInputTokens > usage.inputTokens) {
    throw new Error("Copilot cached input cannot exceed total structured input.");
  }
  usage.cacheReusePercent = usage.inputTokens > 0
    ? usage.cachedInputTokens / usage.inputTokens * 100 : 0;
  return usage;
}

export function runtimePermissionPrompt(request) {
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  const supported = {
    shell: text(request?.fullCommandText),
    read: text(request?.path),
    write: text(request?.fileName) && typeof request?.diff === "string",
    url: text(request?.url),
    mcp: text(request?.serverName) && text(request?.toolName)
  }[request?.kind] === true;
  const fields = {
    kind: request?.kind,
    intention: request?.intention,
    command: request?.fullCommandText,
    path: request?.path ?? request?.fileName,
    diff: request?.diff,
    url: request?.url,
    server: request?.serverName,
    tool: request?.toolName,
    readOnly: request?.readOnly,
    arguments: request?.args,
    possiblePaths: request?.possiblePaths,
    possibleUrls: request?.possibleUrls,
    warning: request?.warning,
    sandboxBypass: request?.requestSandboxBypass === true,
    sandboxPermissiveRetry: request?.requestSandboxPermissive === true,
    sandboxReason: request?.requestSandboxBypassReason,
    managedHumanApprovalRequired: request?.managedApprovalRequired === true
  };
  const details = JSON.stringify(fields, null, 2);
  const sensitivePath = ["read", "write"].includes(request?.kind) &&
    credentialPath.test(request.path ?? request.fileName ?? "");
  const reviewable = supported && !sensitivePath && safeRuntimeText(details);
  const canUseFileTrust = request?.kind === "write" && supported && !sensitivePath &&
    Buffer.byteLength(details, "utf8") <= MAX_RUNTIME_FRAME_BYTES &&
    safeRuntimeText(request.diff, MAX_RUNTIME_FRAME_BYTES) &&
    safeRuntimeText(details, MAX_RUNTIME_FRAME_BYTES);
  return {
    kind: "permission",
    title: "Copilot requests permission",
    details: reviewable ? details :
      "This request has unsupported, sensitive or oversized details. Approval is unavailable; deny it and inspect it in an interactive Copilot session.",
    canApprove: reviewable,
    canUseFileTrust,
    choices: [],
    allowFreeform: false
  };
}

export function runtimeQuestionPrompt(request) {
  const choices = request?.choices ?? [];
  if (!safeRuntimeText(request?.question, 4000) ||
      credentialQuestion.test(request.question) ||
      !Array.isArray(choices) || choices.length > 20 ||
      choices.some((choice) => !safeRuntimeText(choice, 1000))) {
    throw new Error("Copilot requested sensitive, unsupported or oversized input. Complete authentication in the normal browser; never enter credentials in FixLab.");
  }
  if (choices.length === 0 && request.allowFreeform === false) {
    throw new Error("Copilot supplied a question without an available answer.");
  }
  return {
    kind: "question",
    title: "Copilot needs your input",
    details: request.question,
    choices,
    allowFreeform: request.allowFreeform !== false,
    canApprove: false
  };
}

export function createRuntimeRequestBridge({ send, onChange }) {
  const pending = new Map();
  const publish = () => onChange([...pending.values()]);
  return {
    receive(value) {
      if (pending.size >= MAX_RUNTIME_REQUESTS ||
          typeof value?.id !== "string" ||
          !/^[a-f0-9-]{36}$/.test(value.id) || pending.has(value.id) ||
          !["permission", "question"].includes(value.kind) ||
          !safeRuntimeText(value.title, 200) || !safeRuntimeText(value.details) ||
          !Array.isArray(value.choices) || value.choices.length > 20 ||
          value.choices.some((choice) => !safeRuntimeText(choice, 1000)) ||
          typeof value.canApprove !== "boolean" ||
          typeof value.allowFreeform !== "boolean" ||
          (value.grantScope !== undefined &&
            (!value.canApprove || value.kind !== "permission" ||
              !["repository-reads", "exact-test-command", "publication-batch"].includes(value.grantScope)))) {
        throw new Error("Copilot sent an invalid or excessive runtime request.");
      }
      pending.set(value.id, {
        id: value.id,
        kind: value.kind,
        title: value.title,
        details: value.details,
        choices: [...value.choices],
        canApprove: value.canApprove,
        allowFreeform: value.allowFreeform,
        ...(value.grantScope ? { grantScope: value.grantScope } : {})
      });
      publish();
    },
    respond(id, response) {
      const request = pending.get(id);
      if (!request) {
        throw new Error("The runtime request is stale or was already answered.");
      }
      const { action, choice, answer } = response;
      let result = { type: "response", id, action };
      if (response.scope !== undefined) {
        if (action !== "allow" || !request.grantScope || response.scope !== request.grantScope) {
          throw new Error("This job-scoped permission decision is not available.");
        }
        result.scope = response.scope;
      }
      if (request.kind === "permission") {
        if (!["allow", "deny"].includes(action) ||
            (action === "allow" && !request.canApprove)) {
          throw new Error("This permission decision is not available.");
        }
      } else if (action === "answer") {
        if (Number.isInteger(choice) && choice >= 0 &&
            choice < request.choices.length) {
          result = { ...result, answer: request.choices[choice], wasFreeform: false };
        } else if (choice === undefined && request.allowFreeform &&
            safeRuntimeText(answer, 4000) && answer.trim() &&
            !credentialQuestion.test(answer)) {
          result = { ...result, answer, wasFreeform: true };
        } else {
          throw new Error("Select an available choice or supply a non-sensitive answer.");
        }
      } else if (action !== "cancel") {
        throw new Error("This question decision is not available.");
      }
      send(result);
      pending.delete(id);
      publish();
    },
    cancel(notify = true) {
      if (notify) {
        for (const id of pending.keys()) {
          send({ type: "response", id, action: "cancel" });
        }
      }
      pending.clear();
      publish();
    }
  };
}

export function runtimeRequestId() {
  return randomUUID();
}
