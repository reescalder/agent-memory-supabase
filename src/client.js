// ===========================================================================
// Agent Memory on Supabase: Node client
// ===========================================================================
// A thin, dependency-light client over the schema in sql/schema.sql.
// Handles embedding, write-time dedup, optional entity extraction, and hybrid
// recall. Bring your own Supabase project and OpenAI key.
//
//   import { MemoryStore } from "agent-memory-supabase";
//   const mem = new MemoryStore({
//     supabaseUrl: process.env.SUPABASE_URL,
//     supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
//     openaiKey:   process.env.OPENAI_API_KEY,
//   });
//   await mem.store({ content: "Rees prefers GBP.", memoryType: "preference" });
//   const hits = await mem.recall("what currency does he want?");
// ===========================================================================

import { createClient } from "@supabase/supabase-js";

const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536-dim, matches schema
const ENTITY_MODEL = "gpt-4o-mini";

const VALID_TYPES = new Set([
  "fact", "decision", "event", "preference", "correction",
  "conversation", "pattern", "learning", "transcript",
]);

// Per-type default importance. Corrections and preferences are load-bearing;
// transcripts are noise you keep for provenance. Tune to taste.
const DEFAULT_IMPORTANCE = {
  correction: 9, preference: 8, decision: 7, pattern: 7,
  learning: 6, fact: 5, event: 4, conversation: 3, transcript: 1,
};

export class MemoryStore {
  constructor({ supabaseUrl, supabaseKey, openaiKey, extractEntities = true }) {
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("MemoryStore: supabaseUrl and supabaseKey are required");
    }
    if (!openaiKey) {
      throw new Error("MemoryStore: openaiKey is required (embeddings)");
    }
    this.db = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });
    this.openaiKey = openaiKey;
    this.doExtractEntities = extractEntities;
  }

  // -------------------------------------------------------------------------
  // Embedding
  // -------------------------------------------------------------------------
  async embed(text) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    return data.data[0].embedding;
  }

  // -------------------------------------------------------------------------
  // Entity extraction (optional). Returns [{name, type}].
  // Skipped for short content and transcripts.
  // -------------------------------------------------------------------------
  async extractEntities(content) {
    if (!this.doExtractEntities || !content || content.length < 50) return [];
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ENTITY_MODEL,
          temperature: 0,
          max_tokens: 500,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Extract named entities from the text. Return JSON " +
                '{"entities":[{"name":"...","type":"..."}]}. type is one of: ' +
                "person, project, tool, company, location, concept. " +
                "Only real named entities, not generic nouns. Empty array if none.",
            },
            { role: "user", content },
          ],
        }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const parsed = JSON.parse(data.choices[0].message.content || "{}");
      return Array.isArray(parsed.entities) ? parsed.entities : [];
    } catch {
      return []; // Entity extraction is a nice-to-have; never block a write on it.
    }
  }

  // -------------------------------------------------------------------------
  // Store a memory. Dedups against a >=95% semantic near-duplicate of the same
  // type (updates instead of inserting). Returns { action, memory }.
  // -------------------------------------------------------------------------
  async store({
    content,
    memoryType,
    project = null,
    tags = [],
    importance,
    source = "client",
    metadata = {},
    supersedes = null,
    expiresAt = null,
    dedupeThreshold = 0.95,
  }) {
    if (!content) throw new Error("store: content is required");
    if (!VALID_TYPES.has(memoryType)) {
      throw new Error(`store: invalid memoryType "${memoryType}"`);
    }
    const imp = importance ?? DEFAULT_IMPORTANCE[memoryType] ?? 5;
    const embedding = await this.embed(content);

    // 1) Semantic dedup: collapse near-identical memories of the same type.
    const { data: dupes } = await this.db.rpc("find_similar_memory", {
      query_embedding: embedding,
      similarity_threshold: dedupeThreshold,
      filter_project: project,
      filter_memory_type: memoryType,
    });
    if (dupes && dupes.length > 0) {
      const dupe = dupes[0];
      const { data: updated } = await this.db
        .from("memories")
        .update({ content, importance: imp, metadata, tags })
        .eq("id", dupe.id)
        .select()
        .single();
      return { action: "updated", memory: updated ?? dupe };
    }

    // 2) Entity extraction (skipped for transcripts).
    const entities =
      memoryType === "transcript" ? [] : await this.extractEntities(content);

    // 3) If this supersedes a prior memory, close its validity window + link it.
    if (supersedes) {
      await this.db
        .from("memories")
        .update({ active: false, valid_until: new Date().toISOString() })
        .eq("id", supersedes);
    }

    // 4) Insert.
    const { data: inserted, error } = await this.db
      .from("memories")
      .insert({
        content,
        embedding,
        memory_type: memoryType,
        project,
        tags,
        importance: imp,
        source,
        entities,
        metadata,
        expires_at: expiresAt,
      })
      .select()
      .single();
    if (error) throw new Error(`store insert failed: ${error.message}`);

    if (supersedes) {
      await this.db
        .from("memories")
        .update({ superseded_by: inserted.id })
        .eq("id", supersedes);
    }
    return { action: "created", memory: inserted };
  }

  // -------------------------------------------------------------------------
  // Hybrid recall. Returns rows with a real cosine `similarity`.
  // Pass namedEntities (array of names the query mentions) to enable
  // entity-grounded recall.
  // -------------------------------------------------------------------------
  async recall(query, {
    matchCount = 10,
    project = null,
    types = null,
    minImportance = 0,
    minSimilarity = 0.3,
    dateFrom = null,
    dateTo = null,
    useBlended = true,
    trackAccess = true,
    namedEntities = null,
  } = {}) {
    const embedding = await this.embed(query);
    const { data, error } = await this.db.rpc("search_memories", {
      query_embedding: embedding,
      query_text: query,
      match_count: matchCount,
      filter_project: project,
      filter_types: types,
      min_importance: minImportance,
      min_similarity: minSimilarity,
      date_from: dateFrom,
      date_to: dateTo,
      use_blended: useBlended,
      track_access: trackAccess,
      boost_entities: namedEntities,
    });
    if (error) throw new Error(`recall failed: ${error.message}`);
    return data ?? [];
  }

  // -------------------------------------------------------------------------
  // Convenience: recent timeline, project-scoped or global.
  // -------------------------------------------------------------------------
  async timeline({ project = null, limit = 20, types = null } = {}) {
    const { data, error } = await this.db.rpc("memory_timeline", {
      filter_project: project,
      entry_limit: limit,
      filter_types: types,
    });
    if (error) throw new Error(`timeline failed: ${error.message}`);
    return data ?? [];
  }

  // -------------------------------------------------------------------------
  // Convenience: how facts about an entity evolved over time.
  // -------------------------------------------------------------------------
  async history(entityQuery, { project = null, limit = 20 } = {}) {
    const { data, error } = await this.db.rpc("memory_history", {
      entity_query: entityQuery,
      filter_project: project,
      max_results: limit,
    });
    if (error) throw new Error(`history failed: ${error.message}`);
    return data ?? [];
  }
}
