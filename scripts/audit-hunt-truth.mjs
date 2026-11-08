import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

// 1. All live hunts with their real stage data
const hunts = await db.liveHunt.findMany({ orderBy: { id: "asc" } });
console.log("=== LIVE HUNTS (real DB rows) ===");
for (const h of hunts) {
  const stages = typeof h.stages === "string" ? JSON.parse(h.stages) : h.stages;
  const stageSummary = Array.isArray(stages)
    ? stages.map(s => ({ i: s.index ?? s.stage ?? "?", name: s.name ?? s.stageName ?? "?", items: s.itemsFound ?? s.found ?? s.newDna ?? null, llmCalls: s.llmCalls ?? null }))
    : "NON-ARRAY";
  console.log(JSON.stringify({ id: h.id, gen: h.generation, missionId: h.missionId, done: h.done, llmCalls: h.llmCalls, elapsedMs: h.elapsedMs, dnaBefore: h.dnaBefore, dnaAfter: h.dnaAfter, stages: stageSummary }));
}

// 2. Missions
const missions = await db.mission.findMany({ orderBy: { id: "asc" } });
console.log("\n=== MISSIONS ===");
for (const m of missions) {
  const o = typeof m.objective === "string" && m.objective.length > 120 ? m.objective.slice(0,120) + "..." : m.objective;
  console.log(JSON.stringify({ id: m.id, mission: m.missionName ?? m.name ?? null, objective: o }));
}

// 3. DNA breakdown by kind + by repo
const dnaByKind = await db.dnaArtifact.groupBy({ by: ["kind"], _count: true });
console.log("\n=== DNA BY KIND ===");
console.log(JSON.stringify(dnaByKind));
const dnaByRepo = await db.dnaArtifact.groupBy({ by: ["sourceRepo"], _count: true, orderBy: { _count: { sourceRepo: "desc" } } });
console.log("\n=== DNA TOP 15 REPOS ===");
for (const r of dnaByRepo.slice(0, 15)) console.log(JSON.stringify(r));

// 4. Per-generation DNA counts (evolved vs mined)
const evolved = await db.dnaArtifact.count({ where: { kind: { contains: "evolved" } } });
const mined = await db.dnaArtifact.count({ where: { kind: { contains: "mined" } } });
const uniqueRepos = await db.dnaArtifact.groupBy({ by: ["sourceRepo"] });
console.log("\n=== DNA ROLLUP ===");
console.log(JSON.stringify({ total: await db.dnaArtifact.count(), evolved, mined, uniqueRepos: uniqueRepos.length }));

// 5. Sample: latest 5 genes - show FULL path + kind + sourceRepo
const latest = await db.dnaArtifact.findMany({ orderBy: { id: "desc" }, take: 5, select: { id: true, kind: true, sourceRepo: true, path: true } });
console.log("\n=== 5 LATEST GENES ===");
for (const g of latest) console.log(JSON.stringify(g));

await db.$disconnect();
