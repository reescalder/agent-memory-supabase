// ===========================================================================
// MCP tool definitions over MemoryStore.
// ===========================================================================
// Pure wiring: each tool validates its input with zod, calls one MemoryStore
// method, and formats the result as compact text an LLM can read cheaply.
// No database or embedding logic lives here; that is all in client.js.
// ===========================================================================

import { z } from "zod";

const MEMORY_TYPES = [
  "fact", "decision", "event", "preference", "correction",
  "conversation", "pattern", "learning", "transcript",
];

// What the agent sees once, at connect time. Claude Code puts server
// instructions into the system prompt, so this is where "when to use memory"
// lives instead of in every tool description.
export const SERVER_INSTRUCTIONS = `Long-term memory that persists across sessions, stored in the user's own Supabase Postgres.

- At the start of a task, and before answering anything about the user, their projects, people or past decisions, call memory_recall with a natural-language query.
- When the user states a preference, makes a decision, corrects you, or tells you a durable fact, call memory_store straight away, before replying.
- Write each memory as a standalone declarative fact a future session with zero context would understand ("Sam prefers TypeScript over Python for new services."), never as an instruction to yourself.
- If a new fact replaces an old one, store the new one with supersedes set to the old memory's id.
- Recalled memories can be stale. What the user says now wins.`;

function line(m) {
  const date = m.created_at ? String(m.created_at).slice(0, 10) : "";
  const sim = typeof m.similarity === "number" ? ` sim=${m.similarity.toFixed(2)}` : "";
  const project = m.project ? ` project=${m.project}` : "";
  return `- [${m.memory_type}] ${m.content}\n  (id=${m.id} ${date}${project}${sim})`;
}

function text(body) {
  return { content: [{ type: "text", text: body }] };
}

function fail(err) {
  return { isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] };
}

// Wrap a handler so any thrown error becomes an MCP tool error the model can
// read and react to, rather than a protocol-level crash.
function safe(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerMemoryTools(server, store, { defaultProject = null } = {}) {
  server.registerTool(
    "memory_recall",
    {
      title: "Recall memories",
      description:
        "Search long-term memory with a natural-language query. Hybrid vector + keyword + entity search. Returns the most relevant memories with their ids.",
      inputSchema: {
        query: z.string().min(1).describe("What you want to remember, in plain language"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
        project: z.string().optional().describe("Only search this project namespace. Omit to search everything."),
        types: z.array(z.enum(MEMORY_TYPES)).optional().describe("Only return these memory types"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ query, limit, project, types }) => {
      const hits = await store.recall(query, {
        matchCount: limit ?? 10,
        project: project ?? null,
        types: types?.length ? types : null,
      });
      if (!hits.length) return text(`No memories matched "${query}".`);
      return text(hits.map(line).join("\n"));
    }),
  );

  server.registerTool(
    "memory_store",
    {
      title: "Store a memory",
      description:
        "Save a durable memory. Near-duplicates of the same type are merged automatically, so storing an updated version of a fact is safe.",
      inputSchema: {
        content: z.string().min(1).describe("A standalone declarative fact, e.g. 'Sam's daughter Ava was born on 3 March 2024.'"),
        memory_type: z.enum(MEMORY_TYPES).describe(
          "correction = user corrected you. preference = how they want things done. decision = a choice and why. fact = durable state of the world. event = something that happened. pattern/learning = reusable lessons.",
        ),
        project: z.string().optional().describe("Namespace for this memory, e.g. a project name"),
        tags: z.array(z.string()).optional(),
        importance: z.number().int().min(1).max(10).optional().describe("1-10. Omit for a sensible per-type default."),
        supersedes: z.string().uuid().optional().describe("Id of an older memory this one replaces"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ content, memory_type, project, tags, importance, supersedes }) => {
      const { action, memory } = await store.store({
        content,
        memoryType: memory_type,
        project: project ?? defaultProject,
        tags: tags ?? [],
        importance,
        supersedes: supersedes ?? null,
        source: "mcp",
      });
      return text(`${action} memory ${memory?.id ?? "(unknown id)"}`);
    }),
  );

  server.registerTool(
    "memory_timeline",
    {
      title: "Recent memories",
      description: "List the most recent memories, newest first. Useful for 'what have we been working on'.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
        project: z.string().optional(),
        types: z.array(z.enum(MEMORY_TYPES)).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ limit, project, types }) => {
      const rows = await store.timeline({
        limit: limit ?? 20,
        project: project ?? null,
        types: types?.length ? types : null,
      });
      if (!rows.length) return text("No memories yet.");
      return text(rows.map(line).join("\n"));
    }),
  );

  server.registerTool(
    "memory_history",
    {
      title: "How a fact changed",
      description:
        "Show how memories about one entity (a person, project, tool) changed over time, including superseded versions.",
      inputSchema: {
        entity: z.string().min(1).describe("Entity name, e.g. 'Supabase' or 'Ava'"),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ entity, project, limit }) => {
      const rows = await store.history(entity, { project: project ?? null, limit: limit ?? 20 });
      if (!rows.length) return text(`No history for "${entity}".`);
      return text(
        rows
          .map((r) => `${line(r)}${r.is_current ? "" : "  [no longer current]"}`)
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "memory_forget",
    {
      title: "Forget a memory",
      description:
        "Retire a memory by id so it no longer comes back in recall. Use when the user asks you to forget something or a memory is wrong and has no replacement.",
      inputSchema: {
        id: z.string().uuid().describe("Id of the memory to forget"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id }) => {
      const row = await store.forget(id);
      return text(row ? `Forgot ${row.id}: ${row.content}` : `No active memory with id ${id}.`);
    }),
  );
}
