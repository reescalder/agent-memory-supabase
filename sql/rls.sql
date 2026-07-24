-- ===========================================================================
-- Row Level Security (optional but recommended)
-- ===========================================================================
-- Two common postures. Pick one; do not run both.
--
-- The memories table holds whatever your agent remembers, which is often
-- sensitive. Never expose it to the anon/authenticated client roles without
-- policies. The service_role key bypasses RLS by design: server-side agents
-- using the service key are unaffected by everything below.
-- ===========================================================================

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Posture A: server-only (default, simplest).
-- No policies for anon/authenticated => those roles see nothing. Only the
-- service_role key (server side) can read/write. Use this when memory is
-- managed entirely by a backend agent, never touched from the browser.
-- (Just the ENABLE above is enough. Stop here.)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Posture B: per-user memory (multi-tenant, browser clients).
-- Add an owner column and scope every row to auth.uid(). Uncomment to use.
-- ---------------------------------------------------------------------------
-- ALTER TABLE memories ADD COLUMN IF NOT EXISTS owner uuid DEFAULT auth.uid();
-- CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories (owner);
--
-- CREATE POLICY "owners read own memories" ON memories
--   FOR SELECT USING (auth.uid() = owner);
-- CREATE POLICY "owners insert own memories" ON memories
--   FOR INSERT WITH CHECK (auth.uid() = owner);
-- CREATE POLICY "owners update own memories" ON memories
--   FOR UPDATE USING (auth.uid() = owner) WITH CHECK (auth.uid() = owner);
-- CREATE POLICY "owners delete own memories" ON memories
--   FOR DELETE USING (auth.uid() = owner);
