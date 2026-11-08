import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

for (const id of [5, 6]) {
  const h = await db.liveHunt.findUnique({ where: { id } });
  const stages = JSON.parse(h.stages || "[]");
  const ev = Object.fromEntries(stages.map(s => [s.key, s.evidence ?? {}]));
  const hunt = ev.hunt ?? {};
  const swarm = ev.swarm ?? {};
  const dist = {};
  for (const t of swarm.triage ?? []) dist[t.verdict] = (dist[t.verdict] ?? 0) + 1;
  console.log(`--- HUNT#${id} (gen ${h.generation}) ---`);
  console.log(`hunt: candidates=${hunt.candidates ?? hunt.totalCandidates} hardEvidence=${hunt.hardEvidence ?? "?"} repos=${hunt.repos ?? hunt.uniqueRepos ?? "?"} novel=${hunt.novelCandidates} repeatPct=${hunt.repeatPct} allNames=${(hunt.allNames ?? []).length} queries=${(hunt.queries ?? []).length} zeroHits=${(hunt.queries ?? []).filter(q => (q.count ?? 0) === 0).length} blockedInfo=${JSON.stringify(hunt.evolvedBlocked ?? hunt.blocked ?? "n/a").slice(0, 150)}`);
  console.log(`swarm: judged=${(swarm.triage ?? []).length} dist=${JSON.stringify(dist)} profiles=${(swarm.profiles ?? []).length} autoSaved=${swarm.autoSaved ?? "?"}`);
  console.log(`attack: patterns=${(ev.attack?.patterns ?? []).length} nextQueries=${(ev.attack?.queryEvo?.nextQueries ?? []).length}`);
  console.log(`mine: mined=${JSON.stringify((ev.mine?.mined ?? []).map(m => ({ repo: m.repo, newCount: m.newCount, stubs: m.skippedStubs })))} added=${ev.mine?.added ?? ev.mine?.newGenes ?? "?"} emptySkipped=${ev.mine?.emptySkipped ?? "n/a"}`);
  console.log(`compile: mission=${ev.compile?.missionName ?? ev.compile?.name ?? "?"} steps=${ev.compile?.stepCount ?? "?"} genes=${ev.compile?.geneCount ?? "?"} skillMdSource=${ev.compile?.skillMdSource}`);
  console.log(`execute: ${JSON.stringify(ev.execute?.summary ?? ev.execute?.done ?? "?").slice(0, 100)}`);
  console.log(`grow: lessons=${(ev.grow?.lessons ?? []).length} bornId=${ev.grow?.bornId ?? ev.grow?.newDnaId ?? "?"} llmCalls=${ev.grow?.llmCalls} basis=${JSON.stringify(ev.grow?.llmCallsBasis ?? "n/a").slice(0, 80)}`);
  console.log(`verdict: ${JSON.stringify(ev.verdict ?? {}).slice(0, 300)}`);
}
await db.$disconnect();
