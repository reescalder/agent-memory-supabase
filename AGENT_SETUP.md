# Agent setup: give yourself long-term memory

This file is written for an AI coding agent (Claude Code or similar). A user
pointed you here because they want you to have persistent memory backed by
their own Supabase project. Follow these steps in order and tell the user what
you are doing as you go. Commands are for macOS and Linux shells; on Windows,
translate them to PowerShell.

## What you need before starting

1. **Database access to the user's Supabase project.** The easiest route is the
   official Supabase MCP server. If you have its tools (`apply_migration`,
   `execute_sql`, `get_project_url`), you are set. If not, stop and tell the
   user to run this, restart Claude Code, then type `/mcp` and log in to
   Supabase:

   ```bash
   claude mcp add --transport http supabase https://mcp.supabase.com/mcp
   ```

   If the user has several Supabase projects, ask which one should hold the
   memory. A fresh free-tier project is fine.
2. **An OpenAI API key** for embeddings (`text-embedding-3-small`, fractions of
   a cent per thousand memories). The user pastes it into a local file in
   step 3, so you never need to see it.
3. **The project's secret key.** In the Supabase dashboard: Project Settings,
   API Keys. Prefer the new `sb_secret_...` key; the legacy `service_role` key
   also works. The Supabase MCP deliberately does not expose this key, and it
   bypasses row-level security, so it should never pass through the chat. In
   step 3 the user pastes it into a local file themselves.
4. Node 22 or later (`node --version`) and `git`.

**Keys stay off screen.** Users often record this. Never print a key, never
`cat` the `.env` file, and never put a key literally into a command you show.

## Steps

### 1. Get the code

```bash
if [ -d ~/agent-memory-supabase ]; then
  git -C ~/agent-memory-supabase pull
else
  git clone https://github.com/reescalder/agent-memory-supabase.git ~/agent-memory-supabase
fi
npm install --prefix ~/agent-memory-supabase
```

### 2. Create the schema

Apply the full contents of `~/agent-memory-supabase/sql/schema.sql` as one
migration named `agent_memory_schema`: pass the file's text as the `query`
argument of the Supabase MCP's `apply_migration` tool. There is no need to
summarise the SQL for the user. It is idempotent, so re-running it on a project
that already has it is safe. It enables `vector` and `pg_trgm`, creates one
`memories` table plus its search functions, and turns row-level security on so
the table is server-only.

Verify with `execute_sql`:

```sql
select (select relrowsecurity from pg_class where oid = 'public.memories'::regclass) as rls_on,
       (select count(*) from pg_proc where proname in
         ('search_memories','find_similar_memory','memory_timeline','memory_history')) as functions;
```

Expect `rls_on = true` and `functions = 4`. Then call `get_project_url`: that
URL is the `SUPABASE_URL` for step 3.

### 3. Configure and register the memory MCP server

The server reads its keys from `~/agent-memory-supabase/.env` (git-ignored).
Create it and fill in the project URL from step 2 (the URL is not a secret):

```bash
cd ~/agent-memory-supabase
cp -n .env.example .env
PROJECT_URL="https://YOUR-PROJECT.supabase.co"   # the URL from step 2
sed -i.bak "s#^SUPABASE_URL=.*#SUPABASE_URL=$PROJECT_URL#" .env && rm -f .env.bak
```

If your environment will not let you create or edit `.env`, ask the user to do
it: copy `.env.example` to `.env` and set the `SUPABASE_URL` line.

Then stop and ask the user to open `~/agent-memory-supabase/.env` in their
editor, paste two keys and save:

- the secret key from prerequisite 3, on the `SUPABASE_SERVICE_ROLE_KEY=` line
- their OpenAI key, on the `OPENAI_API_KEY=` line

Wait for them to confirm before continuing. Keys typed by the user into their
own editor never pass through the chat or your tool calls.

Check every value is filled in, without showing any of them:

```bash
grep -cE '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY)=.+' ~/agent-memory-supabase/.env
grep -cE 'YOUR-PROJECT|your-service-role-key|sk-\.\.\.' ~/agent-memory-supabase/.env
```

Expect `3`, then `0`. Now register the server:

```bash
claude mcp add memory --scope user -- node "$HOME/agent-memory-supabase/src/mcp-server.js"
```

`--scope user` makes the memory available in every project on this machine.
Check it:

```bash
claude mcp list
```

After a few seconds of `Checking MCP server health…`, the `memory` line should
end in `✔ Connected`. If it fails, run the server by hand:
`node ~/agent-memory-supabase/src/mcp-server.js`. A healthy server
prints `agent-memory-supabase <version>: connected to <your-project>.supabase.co`
to stderr and then waits for input (press Ctrl-C). A broken one prints what is
missing or wrong.

### 4. Finish

The memory tools load in the next session, not this one, so you cannot test
them yet. Tell the user:

- Setup is done. Quit Claude Code and start it again (`claude`) to load memory.
- Then try it: tell Claude something worth remembering, open another new
  session, and ask about it.

From the next session you will have these tools, and the server tells you when
to use them at connect time, so no extra prompt setup is needed:

| Tool | Use it to |
|------|-----------|
| `memory_recall` | search memory with a natural-language query |
| `memory_store` | save a preference, decision, correction or fact |
| `memory_timeline` | list recent memories |
| `memory_history` | see how facts about one entity changed |
| `memory_forget` | retire a memory by id (soft delete, the row is kept) |

To uninstall: `claude mcp remove memory --scope user`. The data stays in the
user's Supabase project until they drop the `memories` table.
