// End-to-end test through the MCP server against a real Supabase project.
// Writes a handful of memories under a throwaway project tag and forgets them
// afterwards. Skipped unless MEMORY_INTEGRATION=1 and the usual env vars are set:
//
//   MEMORY_INTEGRATION=1 SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   OPENAI_API_KEY=... npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"];
const enabled =
  process.env.MEMORY_INTEGRATION === "1" && REQUIRED.every((k) => process.env[k]);
const SERVER = fileURLToPath(new URL("../src/mcp-server.js", import.meta.url));
const PROJECT = `itest-${randomUUID().slice(0, 8)}`;
const created = new Set();
let client;

const idOf = (res) => res.content[0].text.match(/memory ([0-9a-f-]{36})/)?.[1];

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  assert.notEqual(res.isError, true, `${name} failed: ${res.content?.[0]?.text}`);
  return res;
}

async function store(args) {
  const res = await call("memory_store", { project: PROJECT, ...args });
  const id = idOf(res);
  assert.ok(id, `no id in: ${res.content[0].text}`);
  created.add(id);
  return { id, text: res.content[0].text };
}

before(async () => {
  if (!enabled) return;
  const env = { PATH: process.env.PATH };
  for (const k of REQUIRED) env[k] = process.env[k];
  client = new Client({ name: "itest", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "pipe" }),
  );
});

after(async () => {
  if (!client) return;
  for (const id of created) {
    await client.callTool({ name: "memory_forget", arguments: { id } });
  }
  await client.close();
});

test("store then recall the right memory", { skip: !enabled }, async () => {
  await store({ content: "Sam prefers all money figures in British pounds (GBP).", memory_type: "preference" });
  await store({ content: "The staging database runs on Supabase in eu-west-2.", memory_type: "fact" });
  const res = await call("memory_recall", { query: "what currency does Sam want?", project: PROJECT });
  const first = res.content[0].text.split("\n")[0];
  assert.match(first, /GBP/);
});

test("near-duplicate store updates instead of inserting", { skip: !enabled }, async () => {
  const a = await store({ content: "Sam's daughter Ava was born on 3 March 2024.", memory_type: "fact" });
  const b = await store({ content: "Sam's daughter Ava was born on 3 March 2024.", memory_type: "fact" });
  assert.match(b.text, /^updated/);
  assert.equal(a.id, b.id);
});

test("supersedes retires the old fact", { skip: !enabled }, async () => {
  const old = await store({ content: "Sam's team deploys on Fridays after the weekly review.", memory_type: "fact" });
  const fresh = await store({
    content: "Sam's team stopped Friday deploys and now ships on Tuesdays.",
    memory_type: "fact",
    supersedes: old.id,
  });
  const res = await call("memory_recall", { query: "when does Sam's team deploy?", project: PROJECT });
  assert.ok(res.content[0].text.includes(fresh.id));
  assert.ok(!res.content[0].text.includes(old.id), "superseded memory came back");
});

test("timeline lists newest first", { skip: !enabled }, async () => {
  const res = await call("memory_timeline", { project: PROJECT, limit: 50 });
  assert.match(res.content[0].text, /Tuesdays/);
});

test("forget removes a memory from recall", { skip: !enabled }, async () => {
  const m = await store({ content: "Sam's locker combination at the gym is 4-1-7.", memory_type: "fact" });
  const forgot = await call("memory_forget", { id: m.id });
  assert.match(forgot.content[0].text, /^Forgot/);
  const res = await call("memory_recall", { query: "gym locker combination", project: PROJECT });
  assert.ok(!res.content[0].text.includes(m.id));
  const again = await call("memory_forget", { id: m.id });
  assert.match(again.content[0].text, /No active memory/);
});
