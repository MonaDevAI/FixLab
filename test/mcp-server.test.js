import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../mcp/server.js", import.meta.url));

async function startServer() {
  const child = spawn(process.execPath, [server], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  async function request(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = responses.find((item) => item.id === message.id);
      if (response) {
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`MCP response timed out for ${message.method}`);
  }

  async function stop() {
    child.stdin.end();
    await once(child, "exit");
  }

  return { request, stop };
}

test("MCP server initializes and lists FixLab tools", async () => {
  const client = await startServer();
  try {
    const initialized = await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" }
      }
    });
    assert.equal(initialized.result.serverInfo.name, "fixlab");

    const listed = await client.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["fixlab_inspect_repository", "fixlab_validation_commands"]
    );
  } finally {
    await client.stop();
  }
});

test("MCP server reports repository profile readiness", async () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-mcp-"));
  const profileDirectory = join(repository, ".github", "fixlab");
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(
    join(profileDirectory, "repository-profile.json"),
    JSON.stringify({
      name: "Example",
      applications: { frontend: {} },
      environments: { DEV: {} },
      browserAutomation: {}
    })
  );

  const client = await startServer();
  try {
    const response = await client.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "fixlab_inspect_repository",
        arguments: { repository }
      }
    });
    const result = JSON.parse(response.result.content[0].text);
    assert.equal(result.profileReady, true);
    assert.equal(result.name, "Example");
    assert.deepEqual(result.applicationNames, ["frontend"]);
  } finally {
    await client.stop();
    rmSync(repository, { recursive: true, force: true });
  }
});
