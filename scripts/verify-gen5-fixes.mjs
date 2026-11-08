import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const h = await db.liveHunt.findUnique({ where: { id: 5 } });
const stages = JSON.parse(h.stages || "[]");
const hunt = stages.find((s) => s.key === "hunt")?.evidence ?? {};
const attack = stages.find((s) => s.key === "attack")?.evidence ?? {};
const swarm = stages.find((s) => s.key === "swarm")?.evidence ?? {};
const compile = stages.find((s) => s.key === "compile")?.evidence ?? {};
const mine = stages.find((s) => s.key === "mine")?.evidence ?? {};

console.log("=== FIX 1: evolved queries hits (gen5 ran gen4's evolved) ===");
for (const q of hunt.queries ?? []) {
  if (q.origin !== "registry") console.log(`  [${q.count} hits] ${q.q.slice(0, 90)}`);
}
console.log("=== FIX 2: memory fields ===");
console.log("allNames stored:", (hunt.allNames ?? []).length, "| novel:", hunt.novelCandidates, "| repeatPct:", hunt.repeatPct);
console.log("=== FIX 3: triage distribution ===");
const dist = {};
for (const t of swarm.triage ?? []) dist[t.verdict] = (dist[t.verdict] ?? 0) + 1;
console.log("verdicts:", JSON.stringify(dist), "| reasons sample:", (swarm.triage ?? []).slice(0, 3).map((t) => `${t.fullName}→${t.verdict}: ${String(t.reason).slice(0, 80)}`));
console.log("=== FIX 4: compile skillMdSource ===");
console.log("skillMdSource:", compile.skillMdSource, "lines:", compile.skillMdLines);
console.log("=== FIX 5: mine stubs ===");
console.log("mined:", JSON.stringify((mine.mined ?? []).map((m) => ({ repo: m.repo, new: m.newCount, stubs: m.skippedStubs }))));
console.log("=== NEW nextQueries (for gen 6) ===");
console.log((attack.queryEvo?.nextQueries ?? []).slice(0, 6));
await db.$disconnect();
process.exit(0);
