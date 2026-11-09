#!/usr/bin/env node
/**
 * chimera-live.mjs — generate a Chimera from the top DNA-rich repos in the library.
 * Picks the N repos with the most mined genes and calls POST /api/genesis/synthesize.
 * Usage: node scripts/chimera-live.mjs [topN=5]
 */
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const db = new PrismaClient();
const topN = Math.max(2, Math.min(5, Number(process.argv[2] ?? 5)));

const groups = await db.dnaArtifact.groupBy({
  by: ["sourceRepo"],
  _count: { _all: true },
  orderBy: { _count: { sourceRepo: "desc" } },
  take: topN,
});
const repos = groups.map((g) => g.sourceRepo).filter((r) => !r.startsWith("field:"));
if (repos.length < 1) {
  console.error("FAIL | no DNA-rich repos in library — run a hunt/harvest first");
  process.exit(1);
}
await db.$disconnect();

console.log(`sources (${repos.length}): ${repos.join(", ")}`);
const res = await fetch(`${BASE}/api/genesis/synthesize`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    repos,
    productContext:
      "Claude Hunter Pro — an autonomous competitive-intelligence system for discovering, sweeping and mining DNA from premium Claude projects on GitHub. Next.js 16, TypeScript, Prisma/SQLite, z-ai-web-dev-sdk. The goal: make the hunter industrial-grade — more high-quality targets, less noise, an exploding DNA library.",
  }),
  signal: AbortSignal.timeout(150_000),
});
let body = null;
try { body = await res.json(); } catch { body = null; }

if (res.status !== 200) {
  console.error(`FAIL | chimera → ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  process.exit(1);
}
console.log(`PASS | chimera #${body.id} born: ${body.chimeraName}`);
console.log(`  oneLiner: ${body.oneLiner ?? "—"}`);
console.log(`  sources: ${(body.sources ?? []).join(", ")}`);
console.log(`  principles (${(body.principles ?? []).length}):`);
for (const p of (body.principles ?? []).slice(0, 8)) console.log(`    · ${typeof p === "string" ? p : JSON.stringify(p).slice(0, 140)}`);
console.log(`  workOrders (${(body.workOrders ?? []).length}):`);
for (const w of (body.workOrders ?? []).slice(0, 8)) console.log(`    · ${typeof w === "string" ? w : JSON.stringify(w).slice(0, 140)}`);
console.log(`  breakthrough: ${String(body.breakthrough ?? "—").slice(0, 220)}`);
console.log(`  skillMd: ${String(body.skillMd ?? "").length} chars (ready to inject)`);
