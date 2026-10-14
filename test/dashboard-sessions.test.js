import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createSessionRegistry } from "../dashboard/sessions.js";

test("session ownership rejects external URLs and arbitrary owner identifiers", async () => {
  const registry = createSessionRegistry(randomUUID());
  assert.throws(() => registry.register("https://example.com"), /invalid/);
  assert.throws(() => registry.register("http://127.0.0.1:4317/private"), /invalid/);
  await assert.rejects(registry.control("..\\other", {}), /invalid/);
});

test("session ownership refuses a reused port or another repository's live owner", async () => {
  const registry = createSessionRegistry(randomUUID());
  let session = { id: randomUUID(), scopeId: registry.scopeId };
  let controls = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      controls += 1;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(session));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  registry.register(`http://127.0.0.1:${server.address().port}`);
  try {
    const owners = await registry.list();
    assert.equal(owners[0].available, false);
    await assert.rejects(registry.control(registry.id, {
      resource: "all", action: "shutdown", confirmed: true
    }), /no longer belongs/);
    session = { id: registry.id, scopeId: randomUUID() };
    await assert.rejects(registry.control(registry.id, {
      resource: "all", action: "shutdown", confirmed: true
    }), /no longer belongs/);
    assert.equal(controls, 0);
  } finally {
    registry.unregister();
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
