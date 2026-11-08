import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

// ---------- 1. Inspect before purge ----------
for (const id of [108, 155]) {
  const g = await db.dnaArtifact.findUnique({ where: { id } });
  if (!g) { console.log(`#${id}: already gone`); continue; }
  console.log(`#${id} kind=${g.kind} path=${g.path} repo=${g.sourceRepo} bytes=${g.content?.length}`);
  console.log("  head:", (g.content ?? "").slice(0, 120).replace(/\n/g, "␤"));
}

// ---------- 2. Repair malformed field genes ----------
function normalizeBornSkillMd(raw) {
  let t = (raw ?? "").trim();
  // strip a full outer fence ```markdown ... ``` / ```yaml ... ```
  const fence = t.match(/^```(?:markdown|md|yaml)?\s*\n([\s\S]*)\n```\s*$/);
  if (fence) t = fence[1].trim();
  // leak case: content literally starts with "yaml\n" (fence lost its backticks)
  t = t.replace(/^yaml[ \t]*\n(?=(name|description):)/, "");
  if (/^---/.test(t)) return t;
  const headEnd = t.search(/\n#\s|^#\s/);
  const head = (headEnd > 0 ? t.slice(0, headEnd) : t).trim();
  if (/^name:/m.test(head) && /^description:/m.test(head)) {
    const body = headEnd > 0 ? t.slice(headEnd).trim() : "";
    return (`---\n${head}\n---\n\n${body}`).trim() + "\n";
  }
  return t;
}

for (const id of [94, 95, 138]) {
  const g = await db.dnaArtifact.findUnique({ where: { id } });
  if (!g) { console.log(`repair #${id}: not found`); continue; }
  const before = g.content ?? "";
  const after = normalizeBornSkillMd(before);
  const changed = after !== before;
  const valid = /^---\n/.test(after) && /^name:/m.test(after) && /^description:/m.test(after);
  if (changed) {
    await db.dnaArtifact.update({ where: { id }, data: { content: after, size: after.length } });
  }
  console.log(`repair #${id}: changed=${changed} nowValidFrontmatter=${valid} | head: ${after.slice(0, 100).replace(/\n/g, "␤")}`);
}

// ---------- 3. Purge misclassified genes ----------
for (const id of [108, 155]) {
  const g = await db.dnaArtifact.findUnique({ where: { id } });
  if (!g) continue;
  await db.dnaArtifact.delete({ where: { id } });
  console.log(`PURGED #${id} (${g.kind} · ${g.path}) — test/fixture artifact mislabeled as capability`);
}

// ---------- 4. Final state ----------
const count = await db.dnaArtifact.count();
const minGene = await db.dnaArtifact.findMany({ orderBy: { id: "asc" }, select: { id: true, content: true } });
const minBytes = Math.min(...minGene.map(g => g.content?.length ?? 0));
const fieldGenes = await db.dnaArtifact.findMany({ where: { sourceRepo: { startsWith: "field:" } }, select: { id: true, content: true } });
console.log("\nFINAL:", JSON.stringify({
  total: count,
  minBytes,
  fieldGenes: fieldGenes.map(f => ({ id: f.id, validFrontmatter: /^---\n/.test(f.content ?? "") })),
}));
await db.$disconnect();
