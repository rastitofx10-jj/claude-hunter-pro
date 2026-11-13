#!/usr/bin/env node
/**
 * change-history.mjs — chimera #3 (verified-mutation-flywheel) WO5 live injection:
 * "Record every verdict — history is not an audit log, it is base-rate ammunition."
 *
 * Builds reports/state/change-history.json from DB state: one entry per generation
 * {gen, date, genesAdded, genesTotal, llmCalls, sweepStats, chimerasBorn}.
 * Each run regenerates from source-of-truth (idempotent) and the committed file
 * survives env recycles — so skepticism compounds across cycles.
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";

const db = new PrismaClient();

const hunts = await db.liveHunt.findMany({ orderBy: { id: "asc" } });
const sweeps = await db.sweepRun.findMany({ orderBy: { id: "asc" } });
const chimeras = await db.chimera.findMany({ orderBy: { id: "asc" } });
const genesTotal = await db.dnaArtifact.count();

// genes per hunt generation: createdAt windows are unreliable after restores,
// so attribute genes by their id ranges: hunt N started before gene ids mined in gen N.
// Simpler robust proxy: dna 685→686 style deltas were logged per hunt; rebuild from hunt stats.
const entries = [];
let prevDna = 0;
for (const h of hunts) {
  // round 8: schema default dnaAfter=0 — failed/interrupted hunts carry 0, which passed
  // `!= null`, reset prevDna to 0, and credited the NEXT completed hunt with the whole
  // library as genesAdded (avgGenesPerHuntGen massively inflated — this file is the
  // base-rate ammunition for the next adversarial pass). 0 is treated as unset now,
  // and attribution is gated on the hunt actually finishing.
  const dnaAfter = h.status === "done" && (h.dnaAfter ?? 0) > 0 ? h.dnaAfter : null;
  const genesAdded = dnaAfter != null ? Math.max(0, dnaAfter - prevDna) : null;
  if (dnaAfter != null) prevDna = dnaAfter;
  entries.push({
    gen: h.id,
    date: (h.createdAt ?? new Date()).toISOString().slice(0, 10),
    genesAdded,
    genesTotalAfter: dnaAfter,
    llmCalls: h.llmCalls ?? null,
    status: h.status,
  });
}

// sweeps: findings + code hits per sweep run — the quality-desk verdicts
const sweepHistory = sweeps.map((s) => {
  const st = typeof s.stats === "string" ? safeParse(s.stats) : (s.stats ?? {});
  return {
    sweep: s.id,
    date: (s.startedAt ?? s.createdAt ?? new Date()).toISOString().slice(0, 10),
    status: s.status,
    queries: st.queriesRun ?? null,
    codeHits: st.codeHits ?? null,
    candidates: st.candidatesFound ?? null,
    enriched: st.enriched ?? null,
    hardEvidence: st.hardEvidence ?? null,
    llmCalls: st.llmCalls ?? null,
  };
});

const chimeraHistory = chimeras.map((c) => ({
  id: c.id,
  name: c.name,
  born: (c.createdAt ?? new Date()).toISOString().slice(0, 10),
  parents: (c.sources ?? "").split(",").filter(Boolean),
}));

// base-rate summary — the ammunition for the next red-team
const doneSweeps = sweepHistory.filter((s) => s.status === "done");
const baseRates = {
  huntsTotal: hunts.length,
  huntsDone: hunts.filter((h) => h.status === "done").length,
  sweepDoneRate: sweeps.length ? doneSweeps.length / sweeps.length : null,
  avgGenesPerHuntGen: avg(entries.map((e) => e.genesAdded).filter((v) => v != null)),
  avgCodeHitsPerSweep: avg(doneSweeps.map((s) => s.codeHits).filter((v) => v != null)),
  avgCandidatesPerSweep: avg(doneSweeps.map((s) => s.candidates).filter((v) => v != null)),
  enrichmentRate:
    ratio(sum(doneSweeps.map((s) => s.enriched)), sum(doneSweeps.map((s) => s.candidates))),
  chimerasBorn: chimeras.length,
  genesTotal,
};

const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  note: "WO5 of chimera #3 (verified-mutation-flywheel): every verdict recorded; base rates feed the next adversarial pass.",
  baseRates,
  generations: entries,
  sweeps: sweepHistory,
  chimeras: chimeraHistory,
};

// diff-aware console note
// round 8: the old code diffed against a .bak file that NOTHING ever writes — newGens
// was always the full count presented as "(+N)" new. The previous content is captured
// in memory BEFORE the overwrite now, so the diff is real.
// round 9 — atomic write (tmp + rename), the same discipline dna-snapshot.mjs
// already applies: the env recycle kills processes mid-run, and a kill between the
// open and the flush truncated this file — the next run's safeParse then read {}
// and the "(+N)" diff reported the FULL count as new.
const prevRaw = existsSync("reports/state/change-history.json")
  ? safeParse(readFileSync("reports/state/change-history.json", "utf8"))
  : null;
const histTmp = "reports/state/change-history.json.tmp";
writeFileSync(histTmp, JSON.stringify(out, null, 1), "utf8");
renameSync(histTmp, "reports/state/change-history.json");
const newGens = prevRaw ? entries.length - (prevRaw.generations ?? []).length : entries.length;
console.log(
  `HISTORY_OK | gens=${entries.length} (+${newGens}) sweeps=${sweepHistory.length} chimeras=${chimeraHistory.length} genes=${genesTotal}`
);
console.log(
  `  base rates: avgGenes/hunt=${fmt(baseRates.avgGenesPerHuntGen)} avgCodeHits/sweep=${fmt(
    baseRates.avgCodeHitsPerSweep
  )} enrichmentRate=${fmt(baseRates.enrichmentRate)} sweepDoneRate=${fmt(baseRates.sweepDoneRate)}`
);
console.log("  → reports/state/change-history.json (commit to survive env recycles)");
await db.$disconnect();

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function sum(a) { return a.reduce((x, y) => x + (y ?? 0), 0); }
function ratio(n, d) { return d ? n / d : null; }
function fmt(v) { return v == null ? "—" : v.toFixed(2); }
