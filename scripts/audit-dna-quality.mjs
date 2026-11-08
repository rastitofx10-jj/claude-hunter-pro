import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

// 1. DNA quality distribution
const genes = await db.dnaArtifact.findMany({ select: { id: true, kind: true, name: true, sourceRepo: true, path: true, size: true, content: true, rawUrl: true } });
const sizes = genes.map(g => g.content?.length ?? 0).sort((a,b)=>a-b);
const under400 = genes.filter(g => (g.content?.length ?? 0) < 400);
const truncated = genes.filter(g => (g.content ?? "").includes("[נחתך לכרייה]"));
const emptyContent = genes.filter(g => !g.content || g.content.trim().length === 0);
console.log("=== DNA QUALITY ===");
console.log(JSON.stringify({
  total: genes.length,
  minBytes: sizes[0], medianBytes: sizes[Math.floor(sizes.length/2)], maxBytes: sizes[sizes.length-1],
  under400Bytes: under400.length,
  truncatedContent: truncated.length,
  emptyContent: emptyContent.length,
}));

// 2. Misclassification scan: kind vs path
const misclass = genes.filter(g => {
  const p = (g.path||"").toLowerCase();
  if (g.kind === "mcp-config" && !p.includes(".mcp.json") && !p.includes("mcp_config")) return true;
  if (g.kind === "skill" && !/(^|\/)skill\.md$/.test(p)) return true;
  if (g.kind === "claude-md" && p !== "claude.md") return true;
  if (g.kind === "agents-md" && p !== "agents.md") return true;
  if (g.kind === "command" && !p.includes("commands/")) return true;
  if (g.kind === "agent" && !p.includes("agents/")) return true;
  return false;
});
console.log("\n=== SUSPECT CLASSIFICATIONS (kind vs path) ===");
for (const m of misclass) console.log(`  #${m.id} kind=${m.kind} path=${m.path} repo=${m.sourceRepo} bytes=${m.content?.length}`);

// 3. Duplicate genes: same name, different repo
const byName = new Map();
for (const g of genes) { const k = (g.name||"").toLowerCase(); byName.set(k, (byName.get(k)||[]).concat([g])); }
const dups = [...byName.entries()].filter(([,v]) => v.length > 1);
console.log("\n=== DUPLICATE NAMES ACROSS REPOS ===");
for (const [k, v] of dups) console.log(`  "${k}" ×${v.length}: ${v.map(x=>`#${x.id}(${x.sourceRepo})`).join(", ")}`);

// 4. Field DNA content (born lessons) — quality check
const fieldDna = genes.filter(g => (g.sourceRepo||"").startsWith("field:"));
console.log("\n=== FIELD DNA (born from hunts) ===");
for (const f of fieldDna) console.log(`  #${f.id} ${f.sourceRepo} name="${f.name}" bytes=${f.content?.length} | head: ${(f.content??"").slice(0,150).replace(/\n/g," ")}`);

// 5. Mission #10 SKILL.md — the "AI-grade" claim
const m10 = await db.mission.findUnique({ where: { id: 10 } });
console.log("\n=== MISSION #10 SKILL.md (claimed AI-grade) ===");
console.log("len:", m10.skillMd.length, "| dnaRefs:", m10.dnaRefs);
console.log(m10.skillMd.slice(0, 2000));

// 6. Chimera #2..4 — do SKILL.md actually reference source genes?
const chimeras = await db.chimera.findMany();
console.log("\n=== CHIMERAS ===");
for (const c of chimeras) {
  console.log(`--- #${c.id} ${c.chimeraName} | skillMd bytes=${c.skillMd?.length} | principles=${(c.principles||"").length} | workOrders=${(c.workOrders||"").length}`);
  console.log("   head:", (c.skillMd??"").slice(0, 300).replace(/\n/g, " "));
}

// 7. Missions 9/10 plan + promptSequence sizes
for (const mid of [9, 10]) {
  const m = await db.mission.findUnique({ where: { id: mid } });
  const plan = JSON.parse(m.plan || "{}");
  console.log(`\n=== MISSION ${mid} ${m.missionName} ===`);
  console.log(JSON.stringify({ status: m.status, skillMdSource: plan.skillMdSource, skillMdBytes: m.skillMd?.length, promptSeq: JSON.parse(m.promptSequence||"[]").length, dnaRefsCount: JSON.parse(m.dnaRefs||"[]").length }));
}

await db.$disconnect();
