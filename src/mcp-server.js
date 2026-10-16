#!/usr/bin/env node
// ===========================================================================
// Agent Memory on Supabase: MCP server (stdio)
// ===========================================================================
// Gives Claude (or any MCP client) long-term memory backed by your own
// Supabase project. Configure with environment variables, or put them in a
// .env file at the repo root (env vars passed by the MCP client win):
//
//   SUPABASE_URL               https://YOUR-PROJECT.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service_role or secret key (server-side only)
//   OPENAI_API_KEY             for embeddings
//   MEMORY_PROJECT             optional default namespace for new memories
//   MEMORY_EXTRACT_ENTITIES    optional, "false" to skip entity extraction
//
// stdout belongs to the MCP protocol. Anything human-readable goes to stderr.
// ===========================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MemoryStore } from "./client.js";
import { registerMemoryTools, SERVER_INSTRUCTIONS } from "./mcp-tools.js";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"];
const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

// Resolved next to the code, not the client's cwd, so it works wherever
// Claude launches the server from. quiet: dotenv must never write to stdout.
dotenv.config({ path: ENV_FILE, quiet: true });

function loadConfig(env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    console.error(
      `agent-memory-supabase: missing ${missing.join(", ")}. ` +
        `Set them in ${ENV_FILE} or pass them as env vars from your MCP client.`,
    );
    process.exit(1);
  }
  return {
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
    openaiKey: env.OPENAI_API_KEY,
    extractEntities: env.MEMORY_EXTRACT_ENTITIES !== "false",
    defaultProject: env.MEMORY_PROJECT || null,
  };
}

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const config = loadConfig(process.env);
const store = new MemoryStore(config);
const server = new McpServer(
  { name: "agent-memory-supabase", version },
  { instructions: SERVER_INSTRUCTIONS },
);
registerMemoryTools(server, store, { defaultProject: config.defaultProject });

await server.connect(new StdioServerTransport());
console.error(`agent-memory-supabase ${version}: connected to ${new URL(config.supabaseUrl).host}`);
