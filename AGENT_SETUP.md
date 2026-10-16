# Agent setup: give yourself long-term memory

This file is written for an AI coding agent (Claude Code or similar). A user
pointed you here because they want you to have persistent memory backed by
their own Supabase project. Follow these steps in order. Tell the user what you
are doing as you go, and stop to ask whenever a step says to.

## What you need before starting

1. **Database access to the user's Supabase project.** The easiest route is the
   official Supabase MCP server. If you have tools like `apply_migration` and
   `execute_sql`, you are set. If not, tell the user to connect it and restart
   you:

   ```bash
   claude mcp add --transport http supabase https://mcp.supabase.com/mcp
   ```

   then run `/mcp` in Claude Code to log in. If they have several Supabase
   projects, ask which one holds the memory. A fresh free-tier project is fine.
2. **An OpenAI API key** for embeddings (`text-embedding-3-small`, fractions of
   a cent per thousand memories). Use `$OPENAI_API_KEY` if it is already set in
   the environment. Otherwise ask the user for it.
3. **The project's service role key** (Supabase dashboard, Project Settings,
   API Keys: the legacy `service_role` key or a new `sb_secret_...` key both
   work). The Supabase MCP does not expose this key, so ask the user to paste
   it. It bypasses row-level security: it must only ever live in their local
   MCP config, never in a repo, a frontend or a chat summary.
4. Node 18 or later and `git`.

## Steps

### 1. Get the code

```bash
git clone https://github.com/reescalder/agent-memory-supabase.git ~/agent-memory-supabase \
  || git -C ~/agent-memory-supabase pull
npm install --prefix ~/agent-memory-supabase
```

### 2. Create the schema

Read `~/agent-memory-supabase/sql/schema.sql` and apply the whole file as one
migration named `agent_memory_schema` (Supabase MCP: `apply_migration`). It is
idempotent, so re-running it on a project that already has it is safe. It
enables `vector` and `pg_trgm`, creates one `memories` table plus its search
functions, and turns row-level security on so the table is server-only.

Verify before moving on (`execute_sql`):

```sql
select count(*) as memories,
       (select relrowsecurity from pg_class where relname = 'memories') as rls_on,
       (select count(*) from pg_proc where proname in
         ('search_memories','find_similar_memory','memory_timeline','memory_history')) as functions
from memories;
```

Expect `rls_on = true` and `functions = 4`. Get the project URL with
`get_project_url`.

### 3. Register the memory MCP server

Use an absolute path. Substitute the real values; never echo the keys back to
the user.

```bash
claude mcp add memory --scope user \
  -e SUPABASE_URL=https://YOUR-PROJECT.supabase.co \
  -e SUPABASE_SERVICE_ROLE_KEY=YOUR-SERVICE-ROLE-KEY \
  -e OPENAI_API_KEY=YOUR-OPENAI-KEY \
  -- node "$HOME/agent-memory-supabase/src/mcp-server.js"
```

`--scope user` makes the memory available in every project on this machine.
Then check it connects:

```bash
claude mcp list
```

`memory` should show as connected. If it fails, run the same `node` command
with the same env vars by hand: the server prints a readable error to stderr.

### 4. Finish

Tell the user to restart Claude Code so the `memory_*` tools load. From the
next session you will have:

| Tool | Use it to |
|------|-----------|
| `memory_recall` | search memory with a natural-language query |
| `memory_store` | save a preference, decision, correction or fact |
| `memory_timeline` | list recent memories |
| `memory_history` | see how facts about one entity changed |
| `memory_forget` | retire a memory by id |

The server tells you when to use these at connect time, so no extra prompt
setup is needed. Suggest a first test: in the new session, tell you something
worth remembering, then open another new session and ask about it.
