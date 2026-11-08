import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const all = await db.dnaArtifact.findMany({ select: { id: true, name: true, content: true, kind: true, sourceRepo: true, path: true } });

// --- B4 fixed: stage keys per hunt ---
const hunts = await db.liveHunt.findMany({ select: { id: true, status: true, stages: true, generation: true, dnaBefore: true, dnaAfter: true, llmCalls: true } });
for (const h of hunts) {
  const arr = JSON.parse(h.stages || "[]");
  console.log(`B4_HUNT#${h.id} gen=${h.generation} dna:${h.dnaBefore}->${h.dnaAfter} llm=${h.llmCalls} stages=${arr.length} [${arr.map(s => s.key).join(",")}]`);
}

// --- B7 fixed: exact 12KB cap check (cap in dna-miner) ---
const CAP = 12 * 1024;
const truncated = all.filter(g => (g.content ?? "").length >= CAP - 512);
const atCap = all.filter(g => (g.content ?? "").length >= CAP - 32);
console.log(`B7_TRUNC: atCap(>=${CAP - 32}): ${atCap.length} | nearCap(>=${CAP - 512}): ${truncated.length} (of ${all.length})`);

// --- B8 fixed: sources comma-split vs DNA repos + field refs ---
const chimeras = await db.chimera.findMany({ select: { id: true, name: true, sources: true } });
const repoSet = new Set(all.map(g => g.sourceRepo).filter(Boolean));
for (const c of chimeras) {
  const list = c.sources.split(",").map(s => s.trim()).filter(Boolean);
  const fieldRefs = list.filter(s => s.startsWith("field:"));
  const repos = list.filter(s => !s.startsWith("field:"));
  const missing = repos.filter(s => !repoSet.has(s));
  console.log(`B8_CHIMERA#${c.id} ${c.name}: total=${list.length} fieldRefs=${fieldRefs.length} repos=${repos.length} NOT_IN_DNA(${missing.length}): ${missing.join(",") || "-"}`);
}

// --- B9 fixed: mission skillMd + source label location ---
const missions = await db.mission.findMany({ select: { id: true, missionName: true, skillMd: true, report: true }, orderBy: { id: "asc" } });
for (const m of missions) {
  let src = "?";
  try { const r = JSON.parse(m.report ?? "{}"); src = r.skillMdSource ?? r.compile?.skillMdSource ?? "not-in-report"; } catch { src = "report-unparseable"; }
  console.log(`B9_MISSION#${m.id} ${m.missionName}: skillMd=${m.skillMd?.length ?? 0}b reportSrc=${src}`);
}
// source label for mission 10 from hunt 6 compile evidence
const h6 = await db.liveHunt.findUnique({ where: { id: 6 } });
if (h6) {
  const stages = JSON.parse(h6.stages || "[]");
  const comp = stages.find(s => s.key === "compile")?.evidence ?? {};
  console.log(`B9_HUNT6_COMPILE: skillMdSource=${comp.skillMdSource} lines=${comp.skillMdLines} missionId=${h6.missionId}`);
  const m10 = missions.find(m => m.id === h6.missionId);
  if (m10?.skillMd) console.log(`B9_M10_HEAD: ${m10.skillMd.slice(0, 120).replace(/\n/g, " | ")}`);
}

// --- B10: settings inventory ---
const settings = await db.setting.findMany({ select: { key: true } });
console.log("B10_SETTING_KEYS:", settings.map(s => s.key).join(", "));

// --- B11: field-born genes (field: source) inventory ---
const fieldGenes = all.filter(g => g.sourceRepo.startsWith("field:"));
console.log("B11_FIELD_GENES:", fieldGenes.length, fieldGenes.map(g => `#${g.id}:${g.name}:${(g.content ?? "").length}b`).join(", "));

// --- B12: hunt queries evidence — any repo:anthropic-ai/claude leakage into actual executed queries? ---
for (const h of hunts) {
  const arr = JSON.parse(h.stages || "[]");
  const huntEv = arr.find(s => s.key === "hunt")?.evidence ?? {};
  const qs = huntEv.queries ?? [];
  const zero = qs.filter(q => (q.count ?? 0) === 0);
  console.log(`B12_HUNT#${h.id}: queries=${qs.length} zeroHit=${zero.length} [${zero.map(q => q.q.slice(0, 40)).join(" ; ")}]`);
}

await db.$disconnect();
