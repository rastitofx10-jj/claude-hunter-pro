#!/usr/bin/env bun
// truth-migration.ts — the aggressive fix for the fiction era (2026-11-12).
//
// ROAST FINDING it fixes: the entire model-evidence layer was fabricated —
// all 23 watchlist repos carried ONLY fictional model ids (claude-opus-5-6,
// claude-fable-5-2...), even anthropics/claude-code. The evidence pipeline
// attributed hallucinated pins to real repos; scores, tiers, hunts, missions
// and the "confirmed Fable 5.5 wave" were all built on it.
//
// What it does (idempotent, re-runnable):
//   1. LEDGER   — reclassify fictional entries (claude-fable-5-5...) to
//                kind="fiction", confirmed=false: contamination record, never a wave.
//   2. REPOS    — reset the fabricated `models` field to TRUTH (re-detected from
//                the repo's real GitHub fullName+description only) and rescore
//                honestly via computeListScore (traction/real-models only).
//                The fabricated model bonus is gone; real repos stay by traction.
//   3. MISSIONS — void fiction-based missions (goal distilled from hallucinated
//                intel): status="voided" + explicit reason. Real-intel missions stay.
//   4. LEARNING — strip fiction-targeting queries from the adaptive query book
//                (they were 60% of the book — the quota was hunting hallucinations).
//   5. GENES    — KEPT: the mined files (SKILL.md/CLAUDE.md...) are real content
//                from real repos; the fiction was in the model ATTRIBUTION, not
//                the files. Attribution is reset; the library survives.
//   6. AUDIT    — full before/after numbers to reports/state/truth-audit.json.
import { PrismaClient } from "@prisma/client";
import { detectClaudeModels, computeListScore } from "../src/lib/github";

const db = new PrismaClient();
const dry = process.argv.includes("--dry");

// round 8: guarded parse for DB JSON columns — a malformed row is skipped (returns
// null), never a mid-migration crash with half-committed state and no audit file.
function safeParse(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// The fiction fingerprint: strings that exist only in the hallucination ecosystem.
const FICTION_RE = /\b(?:fable|claude[-_ ]?(?:fable|opus|sonnet|haiku)[-_ ]?[567](?:[-_ ]?\d)?|claude[-_ ]?[567]\b|opus[ ._ -]?[567]\b|sonnet[ ._ -]?[567]\b|haiku[ ._ -]?[567]\b|version[ ._ -]?5\.5|5\.5\+)/i;
const isFictionText = (s: string | null | undefined) => !!s && FICTION_RE.test(s);

interface Audit {
  ranAt: string;
  dry: boolean;
  ledger: { before: number; fictionReclassified: string[] };
  repos: { total: number; modelsReset: number; modelsResetToNull: number; scoresRecomputed: number; scoreDeltas: { fullName: string; before: number; after: number }[] };
  missions: { total: number; voided: number; kept: number; voidedNames: string[] };
  learning: { queriesBefore: number; queriesRemoved: number; queriesKept: number; removedSamples: string[] };
  genes: { total: number; kept: number; note: string };
}

const audit: Audit = {
  ranAt: new Date().toISOString(),
  dry,
  ledger: { before: 0, fictionReclassified: [] },
  repos: { total: 0, modelsReset: 0, modelsResetToNull: 0, scoresRecomputed: 0, scoreDeltas: [] },
  missions: { total: 0, voided: 0, kept: 0, voidedNames: [] },
  learning: { queriesBefore: 0, queriesRemoved: 0, queriesKept: 0, removedSamples: [] },
  genes: { total: 0, kept: 0, note: "kept — mined files are real content from real repos; only the model attribution was fabricated and is reset" },
};

try {
  // ---------- 1. Ledger ----------
  // round 8: three unguarded JSON.parse on DB JSON columns (ledger line ~58, mission
  // report line ~115, stats line ~128) — one malformed row crashed the migration
  // MID-RUN with half-committed state and no audit file; worse, the mission parse sat
  // inside `if (!dry)`, so --dry validated clean while the real run died at the same
  // mission. safeParse everywhere now: a malformed row is recorded and skipped.
  const ledgerRow = await db.setting.findUnique({ where: { key: "frontierLedger" } });
  const ledger: any[] = Array.isArray(safeParse(ledgerRow?.value)) ? safeParse(ledgerRow?.value) : [];
  audit.ledger.before = ledger.length;
  for (const e of ledger) {
    // Any fable entry or any above-real-frontier id that was "confirmed" by the
    // old text-only rule is fiction/contamination — the authority gate is the
    // only confirmation path now, and org:anthropics has no such ids.
    if (isFictionText(e.id) || isFictionText(e.label) || e.family === "fable") {
      if (e.kind !== "fiction" || e.confirmed) {
        audit.ledger.fictionReclassified.push(`${e.id} (was kind=${e.kind}, confirmed=${e.confirmed}, mentions=${e.mentions}, repos=${e.repos.length})`);
      }
      e.kind = "fiction";
      e.confirmed = false;
      e.vouchReached = false;
      e.authorityHit = false;
      e.authorityCheckedAt = new Date().toISOString();
    }
  }
  if (!dry && ledger.length > 0) {
    await db.setting.update({ where: { key: "frontierLedger" }, data: { value: JSON.stringify(ledger) } });
  }

  // ---------- 2. Repos ----------
  const repos = await db.savedRepo.findMany();
  audit.repos.total = repos.length;
  for (const r of repos) {
    // TRUTH source: only the repo's real GitHub metadata (name + description).
    // The stored models/evidence text is fabricated — never re-detect from it.
    const hay = `${r.fullName} ${r.description ?? ""}`;
    const det = detectClaudeModels(hay);
    const realModels = det.qualifying.map((m) => m.id);
    const newModels = realModels.length > 0 ? realModels.join(",") : null;
    const newScore = computeListScore({ fullName: r.fullName, description: r.description ?? "", stars: r.stars, forks: 0, topics: [], pushedAt: undefined }).score;
    const changed = r.models !== newModels || r.score !== newScore;
    if (changed) {
      audit.repos.modelsReset += 1;
      if (newModels === null) audit.repos.modelsResetToNull += 1;
      audit.repos.scoresRecomputed += 1;
      audit.repos.scoreDeltas.push({ fullName: r.fullName, before: r.score, after: newScore });
      if (!dry) {
        await db.savedRepo.update({ where: { id: r.id }, data: { models: newModels, score: newScore } });
      }
    }
  }

  // ---------- 3. Missions ----------
  const missions = await db.mission.findMany();
  audit.missions.total = missions.length;
  for (const m of missions) {
    const text = `${m.missionName} ${m.goal} ${m.context ?? ""} ${m.plan ?? ""} ${m.report ?? ""}`;
    if (isFictionText(text) && m.status !== "voided") {
      audit.missions.voided += 1;
      audit.missions.voidedNames.push(`${m.missionName} (was ${m.status})`);
      if (!dry) {
        const reason = {
          voidedAt: new Date().toISOString(),
          reason: "VOIDED BY TRUTH MIGRATION: the mission's goal was distilled from fabricated model intel (fictional models — fable / opus 5.5+ — that do not exist). The mission hunted hallucinations.",
        };
        const existingReport = m.report ? safeParse(m.report) : {};
        await db.mission.update({
          where: { id: m.id },
          data: { status: "voided", report: JSON.stringify({ ...existingReport, ...reason }) },
        });
      }
    } else {
      audit.missions.kept += 1;
    }
  }

  // ---------- 4. Learning query book ----------
  const statsRow = await db.setting.findUnique({ where: { key: "queryYieldStats" } });
  const stats: Record<string, unknown> = safeParse(statsRow?.value) ?? {};
  audit.learning.queriesBefore = Object.keys(stats).length;
  const kept: Record<string, unknown> = {};
  for (const [q, v] of Object.entries(stats)) {
    if (isFictionText(q)) {
      audit.learning.queriesRemoved += 1;
      if (audit.learning.removedSamples.length < 8) audit.learning.removedSamples.push(q);
    } else {
      kept[q] = v;
    }
  }
  audit.learning.queriesKept = Object.keys(kept).length;
  if (!dry && statsRow) {
    await db.setting.update({ where: { key: "queryYieldStats" }, data: { value: JSON.stringify(kept) } });
  }

  // ---------- 5. Genes ----------
  audit.genes.total = await db.dnaArtifact.count();
  audit.genes.kept = audit.genes.total;

  // ---------- 6. Write the audit ----------
  const auditJson = JSON.stringify(audit, null, 2);
  if (!dry) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/home/z/my-project/reports/state/truth-audit.json", auditJson, "utf8");
  }

  console.log(auditJson);
  console.log(dry ? "\nDRY RUN — nothing written" : "\nTRUTH MIGRATION COMPLETE");
} finally {
  await db.$disconnect();
}
