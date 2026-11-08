import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const h = await db.liveHunt.findUnique({ where: { id: 4 } });
const stages = JSON.parse(h.stages || "[]");
const hunt = stages.find((s) => s.key === "hunt")?.evidence ?? {};
console.log("GEN4 per-query results:");
for (const q of hunt.queries ?? []) {
  console.log(`  [${q.origin}] ${q.error ? "ERR: " + q.error.slice(0, 60) : q.count + " hits"} — ${q.q.slice(0, 80)}`);
}
const top = (hunt.topCandidates ?? []).map((c) => c.fullName);
console.log("topCandidates:", top);
await db.$disconnect();
process.exit(0);
