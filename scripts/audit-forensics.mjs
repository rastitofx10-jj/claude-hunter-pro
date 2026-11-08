import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
const db = new PrismaClient();

// ---------- 1. Mission 7 & 8 deliverables (what execute ACTUALLY produced) ----------
for (const mid of [7, 8]) {
  const m = await db.mission.findUnique({ where: { id: mid } });
  if (!m) continue;
  const plan = JSON.parse(m.plan || "{}");
  const ap = JSON.parse(m.autopilot || "{}");
  console.log(`\n===== MISSION #${mid} "${m.missionName}" status=${m.status} =====`);
  console.log(`phases: ${plan.phases?.length ?? 0}, steps executed: ${ap.steps?.length ?? 0}, failures: ${ap.failures?.length ?? 0}`);
  for (const s of ap.steps ?? []) {
    console.log(`  step ${s.phaseIndex + 1} "${s.title}": deliverable ${s.deliverable?.length ?? 0} chars`);
    console.log(`    head: ${(s.deliverable ?? "").replace(/\n/g, " ").slice(0, 160)}`);
  }
  for (const f of ap.failures ?? []) console.log(`  FAILURE phase ${f.phaseIndex + 1}: ${String(f.error).slice(0, 140)}`);
}

// ---------- 2. Gen 3/4 mined DNA — real content or stubs? ----------
const mined = await db.dnaArtifact.findMany({
  where: { sourceRepo: { not: { startsWith: "field:" } } },
  orderBy: { id: "desc" },
  take: 20,
  select: { id: true, sourceRepo: true, path: true, kind: true, size: true, content: true, createdAt: true },
});
console.log("\n===== MINED DNA (newest 20) =====");
for (const g of mined) {
  const created = g.createdAt ? new Date(g.createdAt).toISOString().slice(5, 16) : "?";
  const hasRealContent = (g.content ?? "").length > 50;
  console.log(`#${g.id} [${g.kind}] ${g.sourceRepo} ${g.path} size=${g.size} real=${hasRealContent} at=${created}`);
}

// ---------- 3. Gen 3 vs Gen 4 hunt evidence: knownBefore + novel ----------
for (const hid of [3, 4]) {
  const h = await db.liveHunt.findUnique({ where: { id: hid } });
  if (!h) continue;
  const stages = JSON.parse(h.stages || "[]");
  const hunt = stages.find((s) => s.key === "hunt")?.evidence ?? {};
  const compile = stages.find((s) => s.key === "compile")?.evidence ?? {};
  const swarm = stages.find((s) => s.key === "swarm")?.evidence ?? {};
  console.log(`\n===== HUNT #${hid} gen=${h.generation} =====`);
  console.log(`knownBefore=${hunt.knownBefore} novel=${hunt.novelCandidates} candidates=${hunt.candidates} withToken=${hunt.withToken}`);
  console.log(`evolvedQueries run: ${(hunt.evolvedQueries ?? []).length} — sample:`, (hunt.evolvedQueries ?? []).slice(0, 3).map((q) => q.q));
  console.log(`compile skillMdSource=${compile.skillMdSource} skillMdLines=${compile.skillMdLines}`);
  console.log(`swarm triage verdicts:`, (swarm.triage ?? []).map((t) => `${t.fullName}:${t.verdict}`).slice(0, 12));
}

await db.$disconnect();
process.exit(0);
