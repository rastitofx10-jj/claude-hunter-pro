#!/usr/bin/env node
/**
 * chimera-3-store.mjs — store chimera #3 (verified-mutation-flywheel) in the DB.
 * Note: Chimera.sources is a plain String (comma-joined), not an array.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const db = new PrismaClient();

const skillMd = readFileSync("reports/evolution/chimera-3-skill.md", "utf8");

const principles = [
  "Data before doctrine — live state, never assumed; every figure carries source + as-of + confidence; stale data flagged loudly",
  "Standing desks, silent roles — verification is a persistent window over a queue, not an event; slots refill, reviews parallel, humans merge",
  "Draft → Validate → Publish — every mutation staged; batch validation across the full hierarchy; undo is delete-draft; publish needs explicit confirmation",
  "Six gates, one ratchet — types, lint, tests, coverage ≥80%, security, dead code; harness read BEFORE authoring; never below last-green",
  "Adversarial pass before belief — deliberate red-team arguing the opposite before accepting; counterevidence is first-class output",
];

const workOrders = [
  "WO1 — Pre-flight data oath: fetch live, stamp sources, render staleness warnings before proceeding",
  "WO2 — Open the standing window: intake → work → review → human-merge; keep slots full; measure in cadence ticks",
  "WO3 — Stage every mutation: drafts only; batch-validate the hierarchy; explicit publish; delete-draft is the undo",
  "WO4 — Gate on measurement, ratchet on green: acceptance gates defined before work; null-test vs reference; hold the floor",
  "WO5 — Record every verdict: accept/reject with evidence → change-history; history is training data for the next red-team",
];

const existing = await db.chimera.findFirst({ where: { name: "verified-mutation-flywheel" } });
const data = {
  name: "verified-mutation-flywheel",
  oneLiner:
    "Operating system for change under adversarial verification — standing desks, staged drafts, measured gates, and a history that compounds into sharper skepticism.",
  sources: [
    "yennanliu/InvestSkill",
    "medici-finance/assay",
    "spotify/ads-agentic-tools",
    "itz4blitz/agentful",
    "Generous-Corp/pulp",
  ].join(","),
  skillMd,
  principles: JSON.stringify(principles),
  workOrders: JSON.stringify(workOrders),
  breakthrough:
    "Verification compounds: every recorded verdict accumulates base rates, and base rates are the ammunition of the next adversarial pass — skepticism gets sharper every cycle instead of staying constant.",
};

const c = existing
  ? await db.chimera.update({ where: { id: existing.id }, data })
  : await db.chimera.create({ data });

console.log(`CHIMERA_${existing ? "UPDATED" : "BORN"} | #${c.id} ${c.name} | skillMd: ${skillMd.length} chars`);
console.log("chimeras total:", await db.chimera.count());
await db.$disconnect();
