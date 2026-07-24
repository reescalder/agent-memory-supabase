-- ===========================================================================
-- Agent Memory on Supabase: schema
-- ===========================================================================
-- A production-shaped long-term memory store for AI agents, built on Postgres.
-- Vector search (pgvector) + full-text search fused with Reciprocal Rank
-- Fusion, entity-grounded recall, temporal validity, and trigram-based
-- snapshot dedup. You own the SQL and the data.
--
-- Run this once in the Supabase SQL editor (or `psql`). Safe to re-run:
-- IF NOT EXISTS / OR REPLACE throughout.
--
-- Requires: pgvector (`vector`) and `pg_trgm`, both available on Supabase.
-- Embeddings are 1536-dim (OpenAI text-embedding-3-small). Change the vector
-- width here and in your client if you use a different model.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content       text NOT NULL,
  embedding     vector(1536),
  memory_type   text NOT NULL CHECK (memory_type IN (
                  'fact', 'decision', 'event', 'preference', 'correction',
                  'conversation', 'pattern', 'learning', 'transcript'
                )),
  project       text,                      -- namespace / tenant tag, null = global
  tags          text[] DEFAULT '{}',
  importance    smallint DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  source        text,                      -- where it came from (session, manual, agent)
  entities      jsonb DEFAULT '[]'::jsonb, -- [{name, type}] extracted at write time
  metadata      jsonb DEFAULT '{}'::jsonb,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  valid_from    timestamptz DEFAULT now(), -- temporal validity window
  valid_until   timestamptz,
  expires_at    timestamptz,               -- hard TTL for ephemeral memories
  superseded_by uuid REFERENCES memories(id),
  access_count  int DEFAULT 0,             -- how often this row was actually returned
  last_accessed_at timestamptz,
  active        boolean DEFAULT true,
  -- Generated full-text column, always in sync with content.
  content_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_memories_content_tsv ON memories USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS idx_memories_tags        ON memories USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_memories_entities    ON memories USING gin (entities jsonb_path_ops) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_memories_content_trgm ON memories USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memories_project     ON memories (project);
CREATE INDEX IF NOT EXISTS idx_memories_type        ON memories (memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_created      ON memories (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_importance   ON memories (importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_active       ON memories (active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_memories_temporal     ON memories (valid_from, valid_until) WHERE active = true;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- Retrieval stats (access_count / last_accessed_at) are stamped on every read;
-- those touches must NOT bump updated_at, or "content last changed" silently
-- becomes "last read". Only bump when a real field changed.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_memories_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.access_count IS NOT DISTINCT FROM OLD.access_count
     AND NEW.last_accessed_at IS NOT DISTINCT FROM OLD.last_accessed_at THEN
    NEW.updated_at = now();
    RETURN NEW;
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.importance IS DISTINCT FROM OLD.importance
     OR NEW.memory_type IS DISTINCT FROM OLD.memory_type
     OR NEW.tags IS DISTINCT FROM OLD.tags
     OR NEW.active IS DISTINCT FROM OLD.active
     OR NEW.metadata IS DISTINCT FROM OLD.metadata
     OR NEW.project IS DISTINCT FROM OLD.project
     OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memories_updated_at ON memories;
CREATE TRIGGER memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION update_memories_updated_at();

-- ---------------------------------------------------------------------------
-- Hybrid recall: vector similarity + full-text keyword, fused with Reciprocal
-- Rank Fusion (RRF), plus optional entity-grounding injection and gentle
-- recency / importance / usage blend factors.
--
--   * `similarity` in the result is real cosine similarity (0..1), safe to show.
--   * ordering uses an internal RRF `final_rank`, which is NOT a match score.
--
-- When query_text is NULL it degrades to pure vector ranking (still works).
-- When boost_entities is passed (lowercased names the query mentions), memories
-- tagged with those entities are injected into the candidate pool and lifted,
-- so identity/grounding facts surface even when the wording doesn't match.
--
-- use_blended=false forces every non-semantic factor to 1.0 (pure RRF baseline,
-- useful for evals/AB). track_access=true stamps read stats on returned rows;
-- keep it false for eval or ad-hoc queries so you don't pollute usage stats.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_memories(
  query_embedding vector(1536),
  query_text      text DEFAULT NULL,
  match_count     int DEFAULT 10,
  filter_project  text DEFAULT NULL,
  filter_types    text[] DEFAULT NULL,
  min_importance  smallint DEFAULT 0,
  min_similarity  float DEFAULT 0.3,
  date_from       timestamptz DEFAULT NULL,
  date_to         timestamptz DEFAULT NULL,
  use_blended     boolean DEFAULT true,
  track_access    boolean DEFAULT false,
  boost_entities  text[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  memory_type text,
  project text,
  tags text[],
  importance smallint,
  source text,
  created_at timestamptz,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
DECLARE
  k constant int := 60;  -- RRF smoothing constant
  ts_query tsquery;
  boost_lc text[] := ARRAY(SELECT lower(x) FROM unnest(boost_entities) AS x);
  has_entities boolean := array_length(boost_lc, 1) > 0;
BEGIN
  -- OR-based tsquery: natural-language queries want broad matching; ranking
  -- handles precision. (plainto_tsquery ANDs terms, which is too strict here.)
  IF query_text IS NOT NULL AND trim(query_text) <> '' THEN
    ts_query := replace(plainto_tsquery('english', query_text)::text, ' & ', ' | ')::tsquery;
  END IF;

  RETURN QUERY
  WITH vector_ranked AS (
    SELECT
      m.id, m.content, m.memory_type, m.project, m.tags,
      m.importance, m.source, m.created_at, m.metadata, m.access_count, m.entities,
      1 - (m.embedding <=> query_embedding) AS vec_sim,
      ROW_NUMBER() OVER (ORDER BY m.embedding <=> query_embedding) AS vec_rank
    FROM memories m
    WHERE m.active = true
      AND (filter_project IS NULL OR m.project = filter_project)
      AND (filter_types IS NULL OR m.memory_type = ANY(filter_types))
      AND m.importance >= min_importance
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND 1 - (m.embedding <=> query_embedding) >= min_similarity
      AND (date_from IS NULL OR m.created_at >= date_from)
      AND (date_to IS NULL OR m.created_at <= date_to)
    ORDER BY m.embedding <=> query_embedding
    LIMIT 50
  ),
  text_ranked AS (
    SELECT
      m.id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank(m.content_tsv, ts_query, 2) DESC, m.importance DESC
      ) AS txt_rank
    FROM memories m
    WHERE ts_query IS NOT NULL
      AND m.active = true
      AND m.content_tsv @@ ts_query
      AND m.memory_type NOT IN ('transcript')
      AND (filter_project IS NULL OR m.project = filter_project)
      AND (filter_types IS NULL OR m.memory_type = ANY(filter_types))
      AND m.importance >= min_importance
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND (date_from IS NULL OR m.created_at >= date_from)
      AND (date_to IS NULL OR m.created_at <= date_to)
    LIMIT 30
  ),
  text_full AS (
    SELECT
      m.id, m.content, m.memory_type, m.project, m.tags,
      m.importance, m.source, m.created_at, m.metadata, m.access_count, m.entities,
      1 - (m.embedding <=> query_embedding) AS vec_sim,
      t.txt_rank
    FROM text_ranked t
    JOIN memories m ON m.id = t.id
    WHERE t.id NOT IN (SELECT v.id FROM vector_ranked v)
      -- The text lane rescues lexical matches the vector top-N missed, but
      -- never rows semantically unrelated to the query. Without this floor,
      -- RRF (rank-based, not score-based) hands a lone weak lexical match
      -- (e.g. one shared stop-ish word) full text-lane credit and it can
      -- outrank a genuinely relevant memory.
      AND 1 - (m.embedding <=> query_embedding) >= min_similarity
  ),
  entity_ranked AS (
    SELECT
      m.id, m.content, m.memory_type, m.project, m.tags,
      m.importance, m.source, m.created_at, m.metadata, m.access_count, m.entities,
      1 - (m.embedding <=> query_embedding) AS vec_sim,
      ROW_NUMBER() OVER (ORDER BY m.importance DESC, m.created_at DESC) AS ent_rank
    FROM memories m
    WHERE has_entities
      AND m.active = true
      AND m.memory_type <> 'transcript'
      AND (filter_project IS NULL OR m.project = filter_project)
      AND (filter_types IS NULL OR m.memory_type = ANY(filter_types))
      AND m.importance >= min_importance
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND (date_from IS NULL OR m.created_at >= date_from)
      AND (date_to IS NULL OR m.created_at <= date_to)
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(m.entities) e
        WHERE lower(e->>'name') = ANY(boost_lc)
      )
    ORDER BY m.importance DESC, m.created_at DESC
    LIMIT 12
  ),
  combined AS (
    SELECT
      v.id, v.content, v.memory_type, v.project, v.tags,
      v.importance, v.source, v.created_at, v.metadata, v.access_count, v.entities,
      v.vec_sim::float AS similarity,
      CASE
        WHEN ts_query IS NULL THEN v.vec_sim
        ELSE (1.0 / (k + v.vec_rank))::float
           + (1.0 / (k + COALESCE(t.txt_rank, 200)))::float
      END AS rank_score
    FROM vector_ranked v
    LEFT JOIN text_ranked t ON v.id = t.id

    UNION ALL

    SELECT
      tf.id, tf.content, tf.memory_type, tf.project, tf.tags,
      tf.importance, tf.source, tf.created_at, tf.metadata, tf.access_count, tf.entities,
      tf.vec_sim::float AS similarity,
      (1.0 / (k + 200))::float + (1.0 / (k + tf.txt_rank))::float AS rank_score
    FROM text_full tf
    WHERE ts_query IS NOT NULL

    UNION ALL

    SELECT
      er.id, er.content, er.memory_type, er.project, er.tags,
      er.importance, er.source, er.created_at, er.metadata, er.access_count, er.entities,
      er.vec_sim::float AS similarity,
      (1.0 / (k + er.ent_rank))::float AS rank_score
    FROM entity_ranked er
    WHERE has_entities
      AND er.id NOT IN (SELECT v.id FROM vector_ranked v)
      AND er.id NOT IN (SELECT tf.id FROM text_full tf)
  ),
  scored AS (
    SELECT
      c.*,
      c.rank_score
        * CASE
            WHEN NOT use_blended THEN 1.0
            -- Preferences and corrections never decay: still the law until superseded.
            WHEN c.memory_type IN ('preference', 'correction') THEN 1.0
            ELSE GREATEST(
              0.75,
              exp(-extract(epoch FROM (now() - c.created_at)) / (86400.0 * 180))
            )
          END
        * CASE WHEN use_blended THEN (1.0 + 0.04 * (c.importance - 5)) ELSE 1.0 END
        * CASE WHEN use_blended THEN (1.0 + LEAST(0.10, 0.02 * ln(1 + COALESCE(c.access_count, 0)))) ELSE 1.0 END
        * CASE
            WHEN use_blended AND has_entities AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(c.entities) e
              WHERE lower(e->>'name') = ANY(boost_lc)
            ) THEN 1.4
            ELSE 1.0
          END
      AS final_rank
    FROM combined c
  ),
  results AS (
    SELECT s.*
    FROM scored s
    ORDER BY s.final_rank DESC
    LIMIT match_count
  ),
  touched AS (
    -- Stamp read stats on exactly the returned rows (opt-in via track_access).
    UPDATE memories m
    SET last_accessed_at = now(),
        access_count = COALESCE(m.access_count, 0) + 1
    WHERE m.id IN (SELECT r.id FROM results r)
      AND track_access
    RETURNING m.id
  )
  SELECT
    r.id, r.content, r.memory_type, r.project, r.tags,
    r.importance, r.source, r.created_at, r.metadata, r.similarity
  FROM results r
  ORDER BY r.final_rank DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- Write-time dedup: exact-ish semantic duplicate (embedding cosine).
-- Pass the incoming memory_type so a paraphrase can only collapse into a
-- memory of the SAME type (a `fact` must not overwrite a `decision`).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION find_similar_memory(
  query_embedding vector(1536),
  similarity_threshold float DEFAULT 0.95,
  filter_project text DEFAULT NULL,
  filter_memory_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  memory_type text,
  importance smallint,
  source text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.memory_type, m.importance, m.source, m.metadata,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE m.active = true
    AND 1 - (m.embedding <=> query_embedding) >= similarity_threshold
    AND (filter_project IS NULL OR m.project = filter_project)
    AND (filter_memory_type IS NULL OR m.memory_type = filter_memory_type)
  ORDER BY m.embedding <=> query_embedding
  LIMIT 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- Snapshot dedup: "same template, different values" duplicates via pg_trgm.
-- Catches evolving tracker facts (counts, statuses) that slip under the 95%
-- embedding threshold because the values changed but the structure didn't.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION find_snapshot_duplicate(
  new_content text,
  new_memory_type text,
  filter_project text DEFAULT NULL,
  trgm_threshold float DEFAULT 0.65,
  max_age_days int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  content text,
  memory_type text,
  trgm_similarity float
)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.memory_type::text,
    similarity(m.content, new_content)::float
  FROM memories m
  WHERE m.active = true
    AND m.memory_type = new_memory_type
    AND m.memory_type IN ('fact', 'pattern')
    AND (filter_project IS NULL OR m.project = filter_project)
    AND m.created_at > now() - (max_age_days || ' days')::interval
    AND length(m.content) > 50
    AND similarity(m.content, new_content) > trgm_threshold
  ORDER BY similarity(m.content, new_content) DESC
  LIMIT 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- Timeline: most recent entries, project-scoped or global.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION memory_timeline(
  filter_project text DEFAULT NULL,
  entry_limit int DEFAULT 20,
  filter_types text[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  memory_type text,
  project text,
  tags text[],
  importance smallint,
  source text,
  created_at timestamptz,
  metadata jsonb
)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.memory_type, m.project, m.tags,
    m.importance, m.source, m.created_at, m.metadata
  FROM memories m
  WHERE m.active = true
    AND (filter_project IS NULL OR m.project = filter_project)
    AND (filter_types IS NULL OR m.memory_type = ANY(filter_types))
    AND (m.expires_at IS NULL OR m.expires_at > now())
  ORDER BY m.created_at DESC
  LIMIT entry_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Entity search: memories mentioning a named entity.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_by_entity(
  entity_name text,
  entity_type text DEFAULT NULL,
  filter_project text DEFAULT NULL,
  max_results int DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  content text,
  memory_type text,
  project text,
  importance smallint,
  entities jsonb,
  created_at timestamptz
)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.memory_type::text, m.project::text,
    m.importance, m.entities, m.created_at
  FROM memories m
  WHERE m.active = true
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(m.entities) e
      WHERE lower(e->>'name') = lower(entity_name)
        AND (entity_type IS NULL OR lower(e->>'type') = lower(entity_type))
    )
    AND (filter_project IS NULL OR m.project = filter_project)
  ORDER BY m.importance DESC, m.created_at DESC
  LIMIT max_results;
END;
$$;

-- ---------------------------------------------------------------------------
-- Entity vocabulary: proper-noun-ish names by mention count. Feed the result
-- back into search_memories(boost_entities => ...) for query-side grounding.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION list_entity_names(
  min_mentions integer DEFAULT 2,
  max_results integer DEFAULT 2000
)
RETURNS TABLE (entity_name text, mention_count bigint)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT lower(e->>'name') AS entity_name, count(*) AS mention_count
  FROM memories m, jsonb_array_elements(m.entities) e
  WHERE m.active = true
    AND m.entities IS NOT NULL
    AND m.entities <> '[]'::jsonb
    AND lower(e->>'type') IN ('person', 'project', 'tool', 'company', 'location')
    AND length(e->>'name') >= 3
  GROUP BY lower(e->>'name')
  HAVING count(*) >= min_mentions
  ORDER BY count(*) DESC
  LIMIT max_results;
END;
$$;

-- ---------------------------------------------------------------------------
-- Fact evolution: how memories about an entity changed over time, following
-- the supersedes chain and temporal validity windows.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION memory_history(
  entity_query text,
  filter_project text DEFAULT NULL,
  max_results integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  content text,
  memory_type text,
  project text,
  importance smallint,
  valid_from timestamptz,
  valid_until timestamptz,
  superseded_by uuid,
  is_current boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.memory_type::text, m.project::text, m.importance,
    m.valid_from, m.valid_until, m.superseded_by,
    (m.active AND m.valid_until IS NULL) AS is_current,
    m.created_at
  FROM memories m
  WHERE m.content ILIKE '%' || entity_query || '%'
    AND (filter_project IS NULL OR m.project = filter_project)
  ORDER BY m.valid_from DESC
  LIMIT max_results;
END;
$$;
