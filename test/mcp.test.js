// Protocol-level tests for the MCP server. No database needed: these check the
// server boots, advertises the right tools, and rejects bad input cleanly.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../src/mcp-server.js", import.meta.url));

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { PATH: process.env.PATH, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const FAKE_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test",
  OPENAI_API_KEY: "test",
};

test("advertises the five memory tools with instructions", async () => {
  const client = await connect(FAKE_ENV);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["memory_forget", "memory_history", "memory_recall", "memory_store", "memory_timeline"],
    );
    assert.match(client.getInstructions() ?? "", /memory_recall/);
    const recall = tools.find((t) => t.name === "memory_recall");
    assert.equal(recall.annotations.readOnlyHint, true);
    assert.deepEqual(recall.inputSchema.required, ["query"]);
  } finally {
    await client.close();
  }
});

test("rejects invalid input without crashing the server", async () => {
  const client = await connect(FAKE_ENV);
  try {
    const bad = await client.callTool({ name: "memory_forget", arguments: { id: "not-a-uuid" } });
    assert.equal(bad.isError, true);
    // Server is still alive after the bad call.
    const { tools } = await client.listTools();
    assert.equal(tools.length, 5);
  } finally {
    await client.close();
  }
});

test("surfaces backend failures as tool errors", async () => {
  // Unreachable OpenAI key: the embed call fails, and the model should get a
  // readable error back instead of a dead connection.
  const client = await connect(FAKE_ENV);
  try {
    const res = await client.callTool({ name: "memory_recall", arguments: { query: "anything" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /embeddings failed|fetch failed/i);
  } finally {
    await client.close();
  }
});
