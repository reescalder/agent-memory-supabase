// Quickstart: store a few memories, then recall them.
//
//   1. Run sql/schema.sql in your Supabase project.
//   2. cp .env.example .env  and fill in the three values.
//   3. node examples/quickstart.js
//
// Uses the service_role key (server-side). Never ship that key to a browser.

import "dotenv/config";
import { MemoryStore } from "../src/client.js";

// dotenv never overrides variables already exported in your shell. Make it
// unmissable which project this is about to write to.
console.log(`Target Supabase project: ${process.env.SUPABASE_URL}\n`);

const mem = new MemoryStore({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
});

// Seed a handful of memories of different types.
const seed = [
  { content: "Rees is based in Cape Town, South Africa (UTC+2).", memoryType: "fact" },
  { content: "Rees prefers all monetary figures shown in GBP.", memoryType: "preference" },
  { content: "Decided to target the Supabase Strategic Partner Manager role.", memoryType: "decision" },
  { content: "Never use em dashes in written output.", memoryType: "correction" },
];

for (const m of seed) {
  const { action, memory } = await mem.store({ ...m, project: "demo" });
  console.log(`${action.padEnd(8)} [${m.memoryType}] ${memory.content}`);
}

console.log("\n--- recall: 'what currency should I use for money?' ---");
const hits = await mem.recall("what currency should I use for money?", { project: "demo" });
for (const h of hits) {
  console.log(`${(h.similarity ?? 0).toFixed(3)}  [${h.memory_type}]  ${h.content}`);
}
if (hits.length === 0) {
  console.error(
    "\n✗ Recall returned 0 results, which should never happen right after " +
      "seeding. Two usual suspects:\n" +
      "  1. sql/schema.sql was not run in this Supabase project.\n" +
      "  2. SUPABASE_URL points at a different project than you think " +
      "(shell env vars beat .env). Check the target host printed above.",
  );
  process.exit(1);
}

console.log("\n--- timeline (most recent first) ---");
for (const t of await mem.timeline({ project: "demo", limit: 5 })) {
  console.log(`[${t.memory_type}]  ${t.content}`);
}
