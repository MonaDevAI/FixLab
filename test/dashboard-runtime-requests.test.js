import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createRuntimeRequestBridge,
  MAX_RUNTIME_REQUESTS,
  runtimePermissionPrompt,
  runtimeQuestionPrompt
} from "../dashboard/runtime-requests.js";
import { extensionLaunchProvider, runCopilotSession } from "../dashboard/copilot-session.js";
import { join } from "node:path";

function managedPolicyRpc(policy = { failClosed: false }) {
  return { managedSettings: { async get() { return policy; } } };
}

function fixture() {
  const sent = [];
  let requests = [];
  const bridge = createRuntimeRequestBridge({
    send: (message) => sent.push(message),
    onChange: (value) => { requests = value; }
  });
  const permission = (command = "npm test") => ({
    ...runtimePermissionPrompt({ kind: "shell", fullCommandText: command }),
    id: randomUUID()
  });
  return { bridge, sent, permission, get requests() { return requests; } };
}

test("runtime permission approval is exact, single-use and never session-wide", () => {
  const state = fixture();
  const first = state.permission();
  const second = state.permission("npm run build");
  state.bridge.receive(first);
  state.bridge.receive(second);
  assert.equal(state.requests.length, 2);
  assert.throws(() => state.bridge.respond(first.id, { action: "approve-for-session" }));
  assert.equal(state.requests.length, 2);
  state.bridge.respond(first.id, { action: "allow" });
  assert.deepEqual(state.sent, [{ type: "response", id: first.id, action: "allow" }]);
  assert.equal(state.requests[0].id, second.id);
  assert.throws(() => state.bridge.respond(first.id, { action: "allow" }), /stale/);
  state.bridge.respond(second.id, { action: "deny" });
  assert.equal(state.requests.length, 0);
});

test("sensitive, malformed and oversized permission details cannot be approved", () => {
  for (const request of [
    { kind: "shell", fullCommandText: "curl -H 'Authorization: Bearer not-a-real-test-token' https://example.invalid" },
    { kind: "shell", fullCommandText: "x".repeat(8193) },
    { kind: "shell" },
    { kind: "write", fileName: "example.txt" },
    { kind: "read", path: "e2e\\.auth\\user.json" },
    { kind: "write", fileName: ".env.local", diff: "Synthetic empty change" },
    { kind: "mcp", serverName: "example", toolName: "test", args: { password: "synthetic-private-value" } },
    { kind: "unknown" }
  ]) {
    const state = fixture();
    const view = { ...runtimePermissionPrompt(request), id: randomUUID() };
    assert.equal(view.canApprove, false);
    assert.doesNotMatch(view.details, /not-a-real-test-token|synthetic-private-value/);
    state.bridge.receive(view);
    assert.throws(() => state.bridge.respond(view.id, { action: "allow" }), /not available/);
    state.bridge.respond(view.id, { action: "deny" });
  }
});

test("permission views disclose sandbox escalation and managed human review", () => {
  const view = runtimePermissionPrompt({
    kind: "shell", fullCommandText: "npm test",
    requestSandboxBypass: true, requestSandboxPermissive: true,
    requestSandboxBypassReason: "The normal sandbox blocked this command.",
    managedApprovalRequired: true
  });
  const details = JSON.parse(view.details);
  assert.equal(details.sandboxBypass, true);
  assert.equal(details.sandboxPermissiveRetry, true);
  assert.equal(details.managedHumanApprovalRequired, true);
});

test("runtime questions preserve offered choices and enforce freeform policy", () => {
  const state = fixture();
  const request = {
    ...runtimeQuestionPrompt({
      question: "Authentication is required. Complete sign-in in the normal browser.",
      choices: ["Ready", "Stop"], allowFreeform: false
    }),
    id: randomUUID()
  };
  state.bridge.receive(request);
  assert.throws(() => state.bridge.respond(request.id, { action: "allow" }));
  assert.throws(() => state.bridge.respond(request.id, { action: "answer", answer: "Other" }));
  assert.throws(() => state.bridge.respond(request.id, { action: "answer", choice: -1 }));
  state.bridge.respond(request.id, { action: "answer", choice: 0 });
  assert.deepEqual(state.sent[0], {
    type: "response", id: request.id, action: "answer", answer: "Ready", wasFreeform: false
  });
  const freeform = { ...runtimeQuestionPrompt({ question: "Which scenario?" }), id: randomUUID() };
  state.bridge.receive(freeform);
  assert.throws(() => state.bridge.respond(freeform.id, { action: "answer", answer: "password=synthetic-only" }));
  state.bridge.respond(freeform.id, { action: "answer", answer: "Validate the selected scenario." });
  assert.equal(state.sent[1].wasFreeform, true);
});

test("runtime input rejects credential collection and malformed choices", () => {
  for (const request of [
    { question: "Please enter your password" },
    { question: "What is your password?" },
    { question: "Paste your MFA code" },
    { question: "Choose", choices: ["x".repeat(1001)] },
    { question: "Choose", choices: new Array(21).fill("Option") },
    { question: "Choose", choices: [], allowFreeform: false },
    { question: null }
  ]) {
    assert.throws(() => runtimeQuestionPrompt(request));
  }
});

test("pending requests are bounded, cancelled on stop and never reusable", () => {
  const state = fixture();
  for (let index = 0; index < MAX_RUNTIME_REQUESTS; index++) {
    state.bridge.receive(state.permission());
  }
  assert.throws(() => state.bridge.receive(state.permission()), /excessive/);
  const id = state.requests[0].id;
  state.bridge.cancel();
  assert.equal(state.requests.length, 0);
  assert.equal(state.sent.length, MAX_RUNTIME_REQUESTS);
  assert.ok(state.sent.every((item) => item.action === "cancel"));
  assert.throws(() => state.bridge.respond(id, { action: "allow" }), /stale/);
});

test("invalid transport requests and disconnected requests fail closed", () => {
  const state = fixture();
  assert.throws(() => state.bridge.receive({ ...state.permission(), id: "../other" }));
  assert.throws(() => state.bridge.receive({ ...state.permission(), details: "password=synthetic-only" }));
  const request = state.permission();
  state.bridge.receive(request);
  assert.throws(() => state.bridge.receive(request));
  state.bridge.cancel(false);
  assert.equal(state.sent.length, 0);
  assert.equal(state.requests.length, 0);
});

for (const resume of [false, true]) {
  test(`SDK ${resume ? "resumed" : "fresh"} session waits for real permission and question responses`, async () => {
    const events = [];
    let config;
    let stopped = false;
    const session = {
      rpc: managedPolicyRpc(),
      on(listener) { events.push(listener); },
      async sendAndWait(input) {
        assert.equal(input.prompt, "Synthetic native-bridge scenario.");
        const permission = await config.onPermissionRequest({
          kind: "shell", fullCommandText: "npm test", managedApprovalRequired: true
        });
        assert.deepEqual(permission, { kind: "approve-once", approvedInteractively: true });
        assert.deepEqual(await config.onUserInputRequest({
          question: "Continue the synthetic scenario?", choices: ["Continue", "Cancel"]
        }), { answer: "Continue", wasFreeform: false });
        events[0]({ type: "assistant.message_delta", data: { deltaContent: "Scenario complete." } });
      }
    };
    const client = {
      async start() {},
      async createSession(value) { assert.equal(resume, false); config = value; return session; },
      async resumeSession(id, value) { assert.equal(resume, true); assert.equal(id, "test-session"); config = value; return session; },
      async stop() { stopped = true; return []; }
    };
    const output = [];
    await runCopilotSession({
      sessionId: "test-session", repository: "test-repository", additionalDirs: ["reviewed-directory"],
      model: "hydrafusion", prompt: "Synthetic native-bridge scenario.", resume
    }, {
      client,
      ask: async (request) => request.kind === "permission"
        ? { action: "allow" }
        : { action: "answer", answer: "Continue", wasFreeform: false },
      output: (stream, text) => output.push({ stream, text })
    });
    assert.equal(stopped, true);
    assert.equal(config.agent, "fixlab:fixlab");
    assert.equal(config.enableManagedSettings, true);
    assert.equal(config.enableExperimentalMode, true);
    assert.deepEqual(config.additionalDirectories, ["reviewed-directory"]);
    assert.deepEqual(output, [{ stream: "stdout", text: "Scenario complete." }]);
  });
}

test("SDK denial, cancelled questions and shutdown errors are not approvals", async () => {
  let stopped = false;
  const client = {
    async start() {},
    async createSession(config) {
      assert.deepEqual(await config.onPermissionRequest({ kind: "shell", fullCommandText: "npm test" }), { kind: "reject" });
      await assert.rejects(config.onUserInputRequest({ question: "Continue?" }), /cancelled/);
      return { rpc: managedPolicyRpc(), on() {}, async sendAndWait() {} };
    },
    async stop() { stopped = true; return [new Error("Synthetic cleanup failure")]; }
  };
  await assert.rejects(runCopilotSession({ prompt: "Test" }, {
    client, ask: async () => ({ action: "cancel" }), output() {}
  }), /shutdown failed/);
  assert.equal(stopped, true);
});

test("SDK output preserves final messages and cumulative usage on resume", async () => {
  let listener;
  const output = [];
  const client = {
    async start() {},
    async resumeSession() {
      return {
        rpc: managedPolicyRpc(),
        on(value) { listener = value; },
        async sendAndWait() {
          listener({ type: "assistant.message", data: { content: "Final message without streaming." } });
          listener({ type: "assistant.usage", data: {
            inputTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 5, outputTokens: 7
          } });
        }
      };
    },
    async stop() { return []; }
  };
  await runCopilotSession({
    resume: true,
    usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 3, outputTokens: 10 }
  }, { client, ask() {}, output: (stream, text) => output.push(text) });
  assert.equal(output[0], "Final message without streaming.");
  assert.match(output.at(-1), /130 \(32 cached, 8 written\).*17/);
});

test("SDK extension discovery retains the official bootstrap within owned containment", async () => {
  const bootstrap = join(process.cwd(), "test-bootstrap.mjs");
  const entry = join(process.cwd(), "extension.mjs");
  const provider = extensionLaunchProvider(bootstrap);
  assert.deepEqual(await provider.resolve({ modulePath: entry }), {
    launch: { executable: process.execPath, args: [bootstrap], env: { EXTENSION_PATH: entry } }
  });
  await assert.rejects(provider.resolve({ modulePath: "relative-extension.mjs" }), /unsupported/);
  await assert.rejects(provider.resolve({ modulePath: join(process.cwd(), "extension.ps1") }), /unsupported/);
});

for (const resume of [false, true]) {
  test(`SDK ${resume ? "resumed" : "fresh"} session fails closed before prompting on unresolved enterprise policy`, async () => {
    for (const policy of [{}, { failClosed: true }, null]) {
      let stopped = false;
      const session = {
        rpc: managedPolicyRpc(policy),
        on() { assert.fail("Unresolved policy must block execution"); },
        async sendAndWait() { assert.fail("Unresolved policy must block execution"); }
      };
      const open = async (config) => {
        assert.equal(config.enableManagedSettings, true);
        return session;
      };
      const client = {
        async start() {},
        createSession: open,
        async resumeSession(id, config) { return open(config); },
        async stop() { stopped = true; return []; }
      };
      await assert.rejects(runCopilotSession({ resume }, {
        client, ask() { assert.fail("Local approval cannot override unresolved policy"); }, output() {}
      }));
      assert.equal(stopped, true);
    }
    let stopped = false;
    const open = async () => ({
      rpc: { managedSettings: { async get() { throw new Error("Policy service unavailable"); } } }
    });
    const client = {
      async start() {},
      createSession: open,
      resumeSession: open,
      async stop() { stopped = true; return []; }
    };
    await assert.rejects(runCopilotSession({ resume }, {
      client, ask() {}, output() {}
    }), /Policy service unavailable/);
    assert.equal(stopped, true);
  });
}
