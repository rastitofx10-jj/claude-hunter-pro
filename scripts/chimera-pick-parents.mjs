#!/usr/bin/env node
/**
 * chimera-pick-parents.mjs — rank source repos by DNA richness to select
 * parents for a new chimera. Richness = gene count × content depth
 * (content length as proxy for engineered substance, since DnaArtifact has
 * no numeric quality field).
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const genes = await db.dnaArtifact.findMany({
  select: { sourceRepo: true, kind: true, name: true, description: true, content: true },
});

const byRepo = {};
for (const g of genes) {
  const r = (byRepo[g.sourceRepo] ??= { count: 0, kinds: {}, chars: 0, top: [] });
  r.count++;
  r.kinds[g.kind] = (r.kinds[g.kind] ?? 0) + 1;
  r.chars += g.content?.length ?? 0;
  if (g.description && g.description.length > 60) {
    r.top.push({ name: g.name, d: g.description.slice(0, 90) });
  }
}

const ranked = Object.entries(byRepo)
  .map(([repo, d]) => ({ repo, ...d, depth: Math.round(d.chars / d.count) }))
  .sort((a, b) => b.count * b.depth - a.count * a.depth)
  .slice(0, 12);

for (const r of ranked) {
  const kinds = Object.entries(r.kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(
    String(r.count).padStart(3) + " genes · " + String(r.depth).padStart(6) + " ch/gene · " +
    r.repo.padEnd(40) + " | " + kinds
  );
}

console.log("\n--- richest skills per top repo ---");
for (const r of ranked.slice(0, 5)) {
  console.log("\n[" + r.repo + "]");
  for (const t of r.top.slice(0, 3)) console.log("  • " + t.name + " — " + t.d);
}

await db.$disconnect();
