#!/usr/bin/env node
/**
 * fable-probe.mjs — can the hunter already DETECT "fable 5.2" and mine matching content?
 * Checks: (1) genes mentioning fable, (2) hunts/missions that touched it,
 * (3) sweep findings mentioning it, (4) whether the query arsenal covers it.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const rx = /fable/i;

// 1) genes
const genes = await db.dnaArtifact.findMany({ select: { sourceRepo: true, name: true, kind: true, description: true, content: true } });
const hitGenes = genes.filter((g) => rx.test(g.name ?? "") || rx.test(g.description ?? "") || rx.test(g.content ?? ""));
console.log(`1) GENES mentioning fable: ${hitGenes.length}/${genes.length}`);
for (const g of hitGenes.slice(0, 8)) {
  const where = rx.test(g.name ?? "") ? "name" : rx.test(g.description ?? "") ? "description" : "content";
  console.log(`   · [${where}] ${g.sourceRepo} :: ${g.name} (${g.kind})`);
  if (where === "content") {
    const m = (g.content ?? "").match(/.{0,60}[Ff]able.{0,80}/);
    if (m) console.log(`     ctx: …${m[0].replace(/\n/g, " ")}…`);
  }
}

// 2) hunts + missions
const hunts = await db.liveHunt.findMany({ select: { id: true, goal: true, status: true } });
const fh = hunts.filter((h) => rx.test(h.goal ?? ""));
console.log(`\n2) HUNTS mentioning fable: ${fh.length}/${hunts.length}`);
for (const h of fh) console.log(`   · hunt #${h.id} (${h.status}): ${h.goal.slice(0, 130)}`);
const missions = await db.mission.findMany({ select: { id: true, missionName: true, goal: true, status: true } });
const fm = missions.filter((m) => rx.test((m.missionName ?? "") + " " + (m.goal ?? "")));
console.log(`   MISSIONS mentioning fable: ${fm.length}/${missions.length}`);
for (const m of fm) console.log(`   · mission #${m.id} (${m.status}): ${(m.missionName ?? "").slice(0, 100)}`);

// 3) sweep findings
const sweeps = await db.sweepRun.findMany({ where: { status: "done" }, select: { id: true, findings: true } });
let fableFindings = 0;
const fableRepos = new Set();
for (const s of sweeps) {
  let f; try { f = JSON.parse(s.findings ?? "[]"); } catch { continue; }
  for (const item of (Array.isArray(f) ? f : [])) {
    const blob = `${item.fullName ?? ""} ${item.description ?? ""} ${(item.evidence ?? "").toString().slice(0, 500)} ${(item.modelStrings ?? []).join(" ")}`;
    if (rx.test(blob)) { fableFindings++; fableRepos.add(item.fullName); }
  }
}
console.log(`\n3) SWEEP FINDINGS mentioning fable: ${fableFindings} (repos: ${[...fableRepos].slice(0, 6).join(", ") || "none"})`);

// 4) query arsenal coverage — does any frontier query mention fable or model-version patterns?
const { readFileSync } = await import("node:fs");
const fq = readFileSync("src/lib/frontier-queries.ts", "utf8");
const fqHits = (fq.match(/fable/gi) ?? []).length;
const versionPatterns = /model|opus|sonnet|version|prompt/i;
const dims = (fq.match(/dimension|slice|rotate/gi) ?? []).length;
console.log(`\n4) QUERY ARSENAL (frontier-queries.ts): ${fq.length} chars, fable mentions: ${fqHits}`);
console.log(`   model/version-pattern queries present: ${versionPatterns.test(fq) ? "yes" : "no"}`);

await db.$disconnect();
