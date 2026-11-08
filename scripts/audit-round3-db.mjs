import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

// --- B1: stub genes (<200 bytes) remaining ---
const all = await db.dnaArtifact.findMany({ select: { id: true, name: true, content: true, kind: true, sourceRepo: true, path: true, createdAt: true } });
const stubs = all.filter(g => (g.content ?? "").length < 200);
console.log("B1_TOTAL_GENES:", all.length, "| STUBS_UNDER_200B:", stubs.length, stubs.map(s => `#${s.id}:${s.name}:${s.content?.length}b`).join(", "));

// --- B2: test/fixture path genes remaining ---
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|fixtures?)(\/|$)|(_test\.(go|js|ts|py|jsx|tsx)$|\.(test|spec)\.(js|ts|jsx|tsx)$)/i;
const testGenes = all.filter(g => TEST_PATH_RE.test(g.path ?? "") || TEST_PATH_RE.test(g.name ?? ""));
console.log("B2_TEST_PATH_GENES:", testGenes.length, testGenes.map(s => `#${s.id}:${s.path}`).join(", "));

// --- B3: field genes frontmatter validity (born DNA) ---
const born = all.filter(g => (g.sourceRepo ?? "") === "" || (g.path ?? "").startsWith("field://"));
const badFm = born.filter(g => !/^---\n/.test(g.content ?? ""));
console.log("B3_BORN_GENES:", born.length, "| BAD_FRONTMATTER:", badFm.length, badFm.map(s => `#${s.id}:${s.name}`).join(", "));

// --- B4: stage counts per hunt (dedup claim: 8 per hunt) ---
const hunts = await db.liveHunt.findMany({ select: { id: true, status: true, stages: true } });
for (const h of hunts) {
  let stages = h.stages;
  if (typeof stages === "string") stages = JSON.parse(stages);
  const arr = Array.isArray(stages) ? stages : [];
  const kinds = arr.map(s => s?.kind ?? s?.stage ?? "?").join(",");
  console.log(`B4_HUNT#${h.id}: status=${h.status} stages=${arr.length} [${kinds}]`);
}

// --- B5: mineAttempts setting exists ---
const ma = await db.setting.findUnique({ where: { key: "mineAttempts" } });
console.log("B5_MINE_ATTEMPTS:", ma ? `${ma.value.slice(0, 200)}` : "MISSING");

// --- B6: duplicate gene names ---
const nameCount = {};
for (const g of all) nameCount[g.name] = (nameCount[g.name] ?? 0) + 1;
const dups = Object.entries(nameCount).filter(([, c]) => c > 1);
console.log("B6_DUP_NAMES:", dups.length, dups.map(([n, c]) => `${n}×${c}`).join(", "));

// --- B7: truncated genes (12KB cap marker) ---
const TRUNC_MARK = /(…|…|\[\.\.\.\]|truncat|—cut—)/i;
const truncated = all.filter(g => (g.content ?? "").length >= 11500);
console.log("B7_NEAR_CAP_12KB:", truncated.length, "/ claim was 39/144");

// --- B8: chimera sources vs DB repos ---
const chimeras = await db.chimera.findMany({ select: { id: true, name: true, sources: true } });
const repoSet = new Set(all.map(g => g.sourceRepo).filter(Boolean));
for (const c of chimeras) {
  let srcs = c.sources;
  if (typeof srcs === "string") { try { srcs = JSON.parse(srcs); } catch { srcs = [srcs]; } }
  const list = Array.isArray(srcs) ? srcs : [srcs];
  const missing = list.filter(s => !repoSet.has(s));
  console.log(`B8_CHIMERA#${c.id} ${c.name}: sources=${list.length} NOT_IN_DNA(${missing.length}): ${missing.join(",") || "-"}`);
}

// --- B9: skills/missions — skillMdSource + sizes ---
const missions = await db.mission.findMany({ select: { id: true, name: true, skillMd: true, skillMdSource: true }, orderBy: { id: "asc" } });
for (const m of missions) console.log(`B9_MISSION#${m.id} ${m.name}: skillMd=${m.skillMd?.length ?? 0}b source=${m.skillMdSource ?? "n/a"}`);

// --- B10: Setting keys inventory (catch orphan/leftover junk) ---
const settings = await db.setting.findMany({ select: { key: true } });
console.log("B10_SETTING_KEYS:", settings.map(s => s.key).join(", "));

await db.$disconnect();
