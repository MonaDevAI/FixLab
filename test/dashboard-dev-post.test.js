import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDevPostTool } from "../dashboard/dev-post.js";
import { runCopilotSession } from "../dashboard/copilot-session.js";
import { createRuntimeRequestBridge, runtimeRequestId } from "../dashboard/runtime-requests.js";

function fixture(t, overrides = {}) {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-dev-post-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  mkdirSync(join(repository, ".github", "fixlab"), { recursive: true });
  const path = join(repository, ".github", "fixlab", "repository-profile.json");
  const helper = join(repository, "session.mjs");
  writeFileSync(helper, 'export async function withApiToken(options, run) { await run("synthetic-value"); }\n');
  const url = "https://api.dev.example.test/items";
  const profile = {
    environments: ["DEV"], browserAutomation: {
      testSynthesis: { defaultDataSource: "non-production-approved", mutationMode: "approved-write" },
      dataSafety: { productionAllowed: false,
        devPost: { scope: "api://example-service/access", sessionHelper: "session.mjs",
          actions: [{ url, testRecord: { field: "name", value: "FIXLAB_TEST_001" } }] } }
    }
  };
  const save = () => writeFileSync(path, JSON.stringify(profile));
  save();
  const prompts = [];
  const requests = [];
  const args = { url, payload: { name: "FIXLAB_TEST_001", enabled: true }, purpose: "Verify synthetic item creation" };
  const settings = { repository, targetEnvironment: "DEV", mutationMode: "approved-write", isReady: () => true,
    async ask(prompt) { prompts.push(prompt); return { action: "allow" }; },
    async request(target, options) {
      requests.push({ target, options });
      return new Response(null, { status: 201 });
    }, ...overrides };
  return { repository, path, helper, url, profile, save, prompts, requests, args, settings,
    tool: () => createDevPostTool(settings) };
}

test("DEV/SIT/UAT POST checkboxes enable requests or defer confirmation without approving writes", async (t) => {
  for (const environment of ["DEV", "SIT", "UAT"]) {
    for (const enabled of [true, false]) {
      const state = fixture(t);
      const key = environment.toLowerCase();
      const configuration = structuredClone(state.profile.browserAutomation.dataSafety.devPost);
      configuration.actions[0].url = `https://api.${key}.example.test/items`;
      delete state.profile.browserAutomation.dataSafety.devPost;
      state.profile.browserAutomation.dataSafety.post = { [key]: configuration };
      state.profile.environments = ["DEV", "SIT", "UAT"];
      state.profile.browserAutomation.testSynthesis = {
        defaultDataSource: "non-production-read-only", mutationMode: "none"
      };
      state.save();
      Object.assign(state.settings, {
        targetEnvironment: environment, mutationMode: "none", allowPostRequests: enabled
      });
      state.args.url = configuration.actions[0].url;
      const tool = state.tool();
      assert.equal(tool.name, "fixlab_nonproduction_post");
      assert.equal(state.prompts.length, 0, "the checkbox is not a permission grant");
      const result = await tool.handler(state.args);
      assert.equal(result.environment, environment);
      const prompt = state.prompts[0];
      assert.equal(prompt.title, `${enabled ? "Confirm" : "Allow"} one ${environment} POST action`);
      assert.equal(prompt.perAction, true);
      assert.equal(JSON.parse(prompt.details).enabledAtJobStart, enabled);
      assert.equal(state.requests.length, 1);
      await assert.rejects(tool.handler({ ...state.args, url: "https://api.other.example.test/items" }), /allowlisted/u);
      await tool.handler(state.args);
      assert.equal(state.prompts.length, 2, "each action still requires separate confirmation");
      for (const selectedMutationMode of ["none", "intercepted"]) {
        assert.equal(createDevPostTool({ ...state.settings, selectedMutationMode }), null);
      }
      assert.equal(createDevPostTool({ ...state.settings, targetEnvironment: "production" }), null);
      if (environment !== "DEV") {
        assert.equal(createDevPostTool({ ...state.settings, allowPostRequests: undefined,
          mutationMode: "approved-write" }), null, "older jobs must not gain a new environment capability");
      }
    }
  }
});

test("deferred POST reports missing setup without asking for unsafe approval", async (t) => {
  const state = fixture(t, { allowPostRequests: false, mutationMode: "none" });
  delete state.profile.browserAutomation.dataSafety.devPost;
  state.save();
  const tool = state.tool();
  assert.ok(tool);
  await assert.rejects(tool.handler(state.args), /dataSafety\.post\.dev.*No request was sent/u);
  assert.equal(state.prompts.length, 0);
  assert.equal(state.requests.length, 0);
  assert.throws(() => createDevPostTool({ ...state.settings, allowPostRequests: "yes" }), /boolean/u);
});

test("DEV POST reviews the complete frozen action once and keeps credentials and bodies out of results", async (t) => {
  const state = fixture(t);
  const tool = state.tool();
  assert.equal(tool.name, "fixlab_dev_post");
  const result = await tool.handler(state.args);
  assert.equal(state.prompts.length, 1);
  const prompt = state.prompts[0];
  assert.equal(prompt.perAction, true);
  assert.equal(prompt.canAllowAll, undefined);
  const review = JSON.parse(prompt.details);
  assert.equal(review.url, state.url);
  assert.deepEqual(review.payload, state.args.payload);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].options.body, JSON.stringify(review.payload));
  assert.equal(state.requests[0].options.redirect, "manual");
  assert.equal(state.requests[0].options.headers.Authorization, "Bearer synthetic-value");
  assert.equal(result.status, 201);
  assert.equal(result.validationPassed, false);
  assert.equal(result.mutationMode, "approved-write");
  assert.doesNotMatch(JSON.stringify({ result, prompt }), /synthetic-value|Authorization/u);
  await tool.handler(state.args);
  assert.equal(state.prompts.length, 2, "a repeat action requires fresh individual confirmation");
});

test("DEV POST transport forbids batch/session grants and consumes only the exact pending request", (t) => {
  const state = fixture(t);
  let bridge;
  const sent = [];
  state.settings.ask = async (prompt) => {
    bridge = createRuntimeRequestBridge({ send: (value) => sent.push(value), onChange() {} });
    const id = runtimeRequestId();
    bridge.receive({ ...prompt, id });
    assert.throws(() => bridge.respond(id, { action: "allow", scope: "all-tools" }), /not available/u);
    bridge.respond(id, { action: "allow" });
    assert.throws(() => bridge.respond(id, { action: "allow" }), /stale/u);
    assert.throws(() => bridge.receive({ ...prompt, id: runtimeRequestId(), canAllowAll: true }), /invalid/u);
    return sent[0];
  };
  return state.tool().handler(state.args);
});

test("native SDK exposes DEV POST only with explicit run policy and never uses Allow all for its action", async (t) => {
  const state = fixture(t);
  let prompts = 0;
  await runCopilotSession({
    repository: state.repository, targetEnvironment: "DEV", testMutationMode: "approved-write",
    toolApprovalMode: "allow-all", prompt: "Synthetic approved DEV action."
  }, {
    output() {},
    async ask(prompt) {
      prompts++;
      assert.equal(prompt.perAction, true);
      assert.equal(prompt.canAllowAll, undefined);
      return { action: "deny" };
    },
    client: {
      async start() {},
      async createSession(options) {
        assert.equal(options.tools[0].name, "fixlab_dev_post");
        return {
          rpc: { managedSettings: { async get() { return { failClosed: false }; } } }, on() {},
          async sendAndWait() {
            await assert.rejects(options.tools[0].handler(state.args), /not individually approved/u);
          }
        };
      },
      async stop() { return []; }
    }
  });
  assert.equal(prompts, 1);
});

test("DEV POST requires DEV, exact configured URLs and test records, and explicit approved-write policy", async (t) => {
  const state = fixture(t);
  for (const targetEnvironment of ["", "local", "SIT", "UAT", "production", undefined]) {
    assert.equal(createDevPostTool({ ...state.settings, targetEnvironment }), null);
  }
  for (const mutationMode of ["none", "intercepted", undefined]) {
    assert.equal(createDevPostTool({ ...state.settings, mutationMode }), null);
  }
  for (const args of [
    { ...state.args, url: `${state.url}/other` },
    { ...state.args, url: `${state.url}?redirect=other` },
    { ...state.args, payload: { name: "ANOTHER_RECORD" } },
    { ...state.args, payload: { name: "FIXLAB_TEST_001", password: "synthetic-private-value" } },
    { ...state.args, payload: { name: "FIXLAB_TEST_001", note: "x".repeat(4001) } },
    { ...state.args, payload: [] }, { ...state.args, headers: {} }
  ]) {
    await assert.rejects(state.tool().handler(args));
  }
  assert.equal(state.prompts.length, 0);
  assert.equal(state.requests.length, 0);
  state.profile.browserAutomation.mode = "api";
  state.save();
  assert.throws(state.tool, /read-only/u);
  delete state.profile.browserAutomation.mode;
  state.profile.browserAutomation.dataSafety.devPost.actions[0].url = "https://api.prod.example.test/items";
  state.save();
  assert.throws(state.tool, /exact credential-free/u);
});

test("DEV POST rejects denial, broad grants, expiry and changed policy/helper without sending", async (t) => {
  for (const change of ["deny", "grant", "expire", "helper", "profile", "policy"]) {
    const state = fixture(t);
    let time = 0;
    let ready = true;
    state.settings.now = () => time;
    state.settings.isReady = () => ready;
    state.settings.ask = async () => {
      if (change === "expire") { time = 300000; }
      if (change === "helper") { writeFileSync(state.helper, `${readFileSync(state.helper, "utf8")}\n`); }
      if (change === "profile") { state.profile.name = "Changed"; state.save(); }
      if (change === "policy") { ready = false; }
      return change === "deny" ? { action: "deny" }
        : change === "grant" ? { action: "allow", scope: "all-tools" } : { action: "allow" };
    };
    await assert.rejects(state.tool().handler(state.args), /not individually approved|expired|changed/u, change);
    assert.equal(state.requests.length, 0, change);
  }
});

test("DEV POST never follows redirects or retries ambiguous outcomes, and hides authentication errors", async (t) => {
  for (const status of [302, 401, 500, "network", "auth", "double-callback"]) {
    const state = fixture(t);
    if (status === "auth") {
      writeFileSync(state.helper, 'export async function withApiToken() { throw new Error("synthetic-private-value"); }\n');
    }
    if (status === "double-callback") {
      writeFileSync(state.helper, 'export async function withApiToken(options, run) { await run("synthetic-value"); await run("synthetic-value"); }\n');
    }
    state.settings.request = async (url, options) => {
      state.requests.push({ url, options });
      if (status === "network") { throw new Error("synthetic-private-value"); }
      return new Response(null, { status: typeof status === "number" ? status : 201 });
    };
    await assert.rejects(state.tool().handler(state.args), (error) => {
      assert.doesNotMatch(error.message, /synthetic-private-value/u);
      assert.match(error.message, /Approval is spent|no request was sent/u);
      return true;
    });

    assert.equal(state.requests.length, status === "auth" ? 0 : 1);
  }
});

test("DEV POST refuses credential-sensitive debug logging before asking or sending", async (t) => {
  const state = fixture(t);
  const original = process.env.NODE_DEBUG;
  try {
    process.env.NODE_DEBUG = "http";
    await assert.rejects(state.tool().handler(state.args), /debug logging/u);
    assert.equal(state.prompts.length, 0);
    assert.equal(state.requests.length, 0);
  } finally {
    if (original === undefined) { delete process.env.NODE_DEBUG; }
    else { process.env.NODE_DEBUG = original; }
  }
});
