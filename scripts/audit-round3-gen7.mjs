import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const h = await db.liveHunt.findUnique({ where: { id: 7 } });
const stages = JSON.parse(h.stages || "[]");
const ev = Object.fromEntries(stages.map(s => [s.key, s.evidence ?? {}]));

const hunt = ev.hunt ?? {};
console.log("1_HUNT: candidates=", hunt.candidates, "novel=", hunt.novelCandidates, "repeatPct=", hunt.repeatPct, "allNames=", (hunt.allNames ?? []).length, "queries=", (hunt.queries ?? []).length, "zeroHits=", (hunt.queries ?? []).filter(q => (q.count ?? 0) === 0).length, "evolvedOrigin=", (hunt.queries ?? []).filter(q => q.origin && q.origin !== "registry").length);

const swarm = ev.swarm ?? {};
const dist = {};
for (const t of swarm.triage ?? []) dist[t.verdict] = (dist[t.verdict] ?? 0) + 1;
console.log("2_SWARM: judged=", (swarm.triage ?? []).length, "dist=", JSON.stringify(dist), "autoSaved=", swarm.autoSaved);

console.log("3_ATTACK: nextQueries=", JSON.stringify(ev.attack?.queryEvo?.nextQueries ?? []).slice(0, 250));

console.log("4_MINE: mined=", JSON.stringify(ev.mine?.mined ?? []), "emptySkipped=", ev.mine?.emptySkipped, "newGenes=", ev.mine?.newCount ?? ev.mine?.added);

console.log("5_COMPILE: mission=", ev.compile?.missionName, "skillMdSource=", ev.compile?.skillMdSource, "steps=", ev.compile?.stepCount ?? ev.compile?.steps, "genes=", ev.compile?.geneCount ?? ev.compile?.genes);

console.log("6_EXECUTE: steps=", JSON.stringify(ev.execute?.summary ?? ev.execute?.steps ?? "?").slice(0, 150));

console.log("7_GROW: lessons=", (ev.grow?.lessons ?? []).length, "llmCalls=", ev.grow?.llmCalls, "basis=", JSON.stringify(ev.grow?.llmCallsBasis ?? "n/a").slice(0, 100), "born=", ev.grow?.bornId ?? ev.grow?.newDnaId);

const verdict = ev.verdict ?? {};
console.log("8_VERDICT: llmCalls=", verdict.llmCalls, "llmCallsBasis=", verdict.llmCallsBasis ?? "MISSING", "totals=", JSON.stringify(verdict.totals ?? {}).slice(0, 200));

const ma = await db.setting.findUnique({ where: { key: "mineAttempts" } });
console.log("9_MINE_ATTEMPTS_SETTING:", ma ? ma.value.slice(0, 250) : "MISSING");

const m11 = await db.mission.findUnique({ where: { id: 11 }, select: { missionName: true, skillMd: true } });
console.log("10_MISSION11:", m11?.missionName, "skillMd=", m11?.skillMd?.length ?? 0, "b, head=", (m11?.skillMd ?? "").slice(0, 80).replace(/\n/g, " | "));

const dnaCount = await db.dnaArtifact.count();
console.log("11_DNA_TOTAL:", dnaCount);

await db.$disconnect();
