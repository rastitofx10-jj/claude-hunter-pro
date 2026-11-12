// ============================================================
// Emerging-model radar — the frontier becomes self-detecting.
//
// The manual step this file kills (field evidence, frontier-queries.ts):
//   "Update the version strings when the next model lands."
// Every past wave (fable 5.1, fable 5.2) required a human edit before the
// arsenal could hunt it. From now on the hunter notices a frontier version
// ABOVE the registry's highest the first time it appears in any text it
// touches (gene content, README, CLAUDE.md, repo descriptions), records it
// in a cumulative ledger, and auto-generates the hunt wave for it.
//
// Confirmation discipline (WO1 — data before doctrine):
//   A signal seen in ONE repo is noise (random fork names, typos, dreams).
//   A signal confirmed by ≥2 distinct repos is a wave — and only confirmed
//   entries steer the arsenal. Everything stays recorded either way (WO5).
// ============================================================

import { QUALIFYING_MODELS, MIN_QUALIFYING_VERSION, type ModelFamily } from "./claude-models";
import { db } from "./db";

/** Product words that look like model families but never are (claude-code-2-1 is a product version, not a model). */
const NON_FAMILY_WORDS = new Set([
  "code", "cli", "sdk", "desktop", "agent", "agents", "ai", "api", "pro", "free",
  "chat", "dev", "docs", "doc", "hub", "app", "web", "extension", "vscode",
  "action", "actions", "workflow", "workflows", "mcp", "server", "proxy",
]);

/** A version pin above the known frontier — the raw detection unit. */
export interface EmergingSignal {
  /** Synthesized id, e.g. claude-fable-5-3 / claude-myth-7-1 */
  id: string;
  family: ModelFamily | string;
  /** e.g. 5.3 */
  version: number;
  /** e.g. "Fable 5.3" */
  label: string;
  /** known-family version above the registry frontier | a family the registry has never seen */
  kind: "emerging" | "candidate";
  /** The text fragment that produced the signal (provenance for the ledger) */
  match: string;
}

/** One ledger row — cumulative evidence about an emerging version. */
export interface LedgerEntry {
  id: string;
  family: string;
  version: number;
  label: string;
  kind: "emerging" | "candidate";
  firstSeen: string;
  lastSeen: string;
  /** Distinct repos that mentioned it — the confirmation metric */
  repos: string[];
  /** Total mentions across all texts */
  mentions: number;
  /** Up to 3 real file paths where it was seen */
  samplePaths: string[];
  /** true once repos.length >= CONFIRM_REPO_MIN — the wave is real */
  confirmed: boolean;
}

const LEDGER_KEY = "frontierLedger";
/** Distinct repos required before an entry steers the arsenal. */
export const CONFIRM_REPO_MIN = 2;
/** Max confirmed entries feeding the arsenal per run (budget discipline). */
const MAX_WAVE_ENTRIES = 2;

/** Highest registered version per family — the frontier line to be above.
 *  Family-level placeholders (claude-fable, version 5.5 = the whole track, not a
 *  real registered release) are SKIPPED: letting a placeholder raise the line
 *  would blind the radar to the very next fable release (5.3 < 5.5).
 *  A family with NO registered versions starts its line at the iron threshold
 *  (5.5), never at 0 — otherwise sonnet 4.5 (an OLD model) would "emerge"
 *  just because the registry holds no sonnet entry. Field evidence from the
 *  adversarial suite: 'sonnet 4.5' was detected as an emerging frontier. */
function familyFrontier(): Map<string, number> {
  const m = new Map<string, number>();
  for (const reg of QUALIFYING_MODELS) {
    if (reg.id === `claude-${reg.family}`) continue; // placeholder, not a version
    const cur = m.get(reg.family) ?? 0;
    if (reg.version > cur) m.set(reg.family, reg.version);
  }
  return m;
}

/** The line a version must be ABOVE to count as emerging for a family. */
function frontierLineFor(family: string, frontier: Map<string, number>): number {
  return frontier.get(family) ?? MIN_QUALIFYING_VERSION;
}

function fmtLabel(family: string, v: number): string {
  const fam = family.charAt(0).toUpperCase() + family.slice(1);
  return `${fam} ${v}`;
}

/**
 * Detects emerging-frontier pins in free text.
 * Two detection classes, both strictly version-gated:
 *  1. emerging — a KNOWN family (fable/opus/sonnet/haiku) pinned ABOVE its
 *     highest registered version: "claude-fable-5-3", "opus 6.2", "claude-sonnet-7".
 *  2. candidate — a family word the registry has never seen, pinned ≥ 5.5 with
 *     an explicit minor: "claude-myth-7-1". Product words are excluded.
 * Below-threshold pins (4.x, 5.0-5.4 non-fable) are NOT signals — the iron
 * threshold still rules: an old model is never "emerging".
 */
export function detectEmergingModels(text: string): EmergingSignal[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const frontier = familyFrontier();
  const out = new Map<string, EmergingSignal>();

  // Known families: claude-fable-5-3 / claude opus 6.2 / fable-6 (hyphen/space/underscore)
  const reKnown = /claude[-_ ]?(fable|opus|sonnet|haiku)[-_ ]?(\d{1,2})(?:[-_. ,](\d{1,2}))?(?!\d)/gi;
  // Standalone family phrasing (the frontier-wave evidence style): "written for fable 5.3"
  const reBare = /\b(fable|opus|sonnet|haiku)[-_ ]?(\d{1,2})(?:[-_. ,](\d{1,2}))?(?!\d)/gi;
  // Unknown family candidates: claude-<word>-<maj>-<min>, version ≥ 5.5, word alphabetic
  const reNew = /claude-([a-z]{3,12})-(\d{1,2})-(\d{1,2})(?!\d)/gi;

  const add = (s: EmergingSignal) => {
    const prev = out.get(s.id);
    if (!prev) out.set(s.id, s);
  };

  const known = (fam: string, maj: number, min: number | null, match: string, isClaudePrefixed: boolean) => {
    if (maj < 1 || maj > 9) return;
    if (min != null && (min < 0 || min > 9)) return;
    const family = fam as ModelFamily;
    const version = min == null ? maj : Number(`${maj}.${min}`);
    const line = frontierLineFor(family, frontier);
    if (version <= line) return; // registered, below the family frontier, or below the iron threshold — not emerging
    // A known-family pin above the frontier is decisive even without the claude-
    // prefix: "opus 6.2" in a README IS the model. Fable additionally allows the
    // bare X.Y form; the fable false-positive guard (story prose) requires X.Y anyway.
    const id = min == null ? `claude-${family}-${maj}` : `claude-${family}-${maj}-${min}`;
    add({ id, family, version, label: fmtLabel(family, version), kind: "emerging", match });
    void isClaudePrefixed;
  };

  let m: RegExpExecArray | null;
  while ((m = reKnown.exec(lower))) known(m[1], Number(m[2]), m[3] != null ? Number(m[3]) : null, m[0], true);
  while ((m = reBare.exec(lower))) {
    // Without a claude/anthropic prefix, require an explicit minor (X.Y):
    // "fable 6" bare could be "fable 6: the fox" prose. The X.Y form is a pin.
    if (m[3] == null) continue;
    known(m[1], Number(m[2]), Number(m[3]), m[0], false);
  }
  while ((m = reNew.exec(lower))) {
    const word = m[1];
    if (NON_FAMILY_WORDS.has(word)) continue;
    if (["fable", "opus", "sonnet", "haiku"].includes(word)) continue; // known families handled above
    const maj = Number(m[2]);
    const min = Number(m[3]);
    if (maj < 5 || maj > 9 || min > 9) continue;
    const version = Number(`${maj}.${min}`);
    if (version < 5.5) continue; // iron threshold: below 5.5 is never frontier
    const id = `claude-${word}-${maj}-${min}`;
    add({ id, family: word, version, label: fmtLabel(word, version), kind: "candidate", match: m[0] });
  }

  return Array.from(out.values());
}

// ---------- The ledger (Setting key: frontierLedger) ----------

export async function loadFrontierLedger(): Promise<LedgerEntry[]> {
  try {
    const row = await db.setting.findUnique({ where: { key: LEDGER_KEY } });
    const parsed = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Merges signals into the ledger — race-safe by transaction re-read (the v1.1
 * pattern from adaptive-learning: never save a stale run-local copy over a
 * concurrent writer's fresher state).
 */
export async function recordEmergingSignals(
  signals: EmergingSignal[],
  repo: string,
  samplePath?: string
): Promise<number> {
  if (signals.length === 0) return 0;
  const now = new Date().toISOString();
  try {
    await db.$transaction(
      async (tx) => {
        const row = await tx.setting.findUnique({ where: { key: LEDGER_KEY } });
        let entries: LedgerEntry[] = [];
        try {
          const v = row?.value ? JSON.parse(row.value) : [];
          if (Array.isArray(v)) entries = v;
        } catch {
          entries = []; // corrupted row — rebuild beats losing the radar
        }
        for (const s of signals) {
          let e = entries.find((x) => x.id === s.id);
          if (!e) {
            e = {
              id: s.id, family: s.family, version: s.version, label: s.label, kind: s.kind,
              firstSeen: now, lastSeen: now, repos: [], mentions: 0, samplePaths: [], confirmed: false,
            };
            entries.push(e);
          }
          e.lastSeen = now;
          e.mentions += 1;
          if (repo && !e.repos.includes(repo)) e.repos.push(repo);
          if (samplePath && e.samplePaths.length < 3 && !e.samplePaths.includes(samplePath)) e.samplePaths.push(samplePath);
          // Confirmation is one-way: once ≥ CONFIRM_REPO_MIN repos vouch, it stays confirmed
          if (!e.confirmed && e.repos.length >= CONFIRM_REPO_MIN) e.confirmed = true;
        }
        await tx.setting.upsert({
          where: { key: LEDGER_KEY },
          update: { value: JSON.stringify(entries) },
          create: { key: LEDGER_KEY, value: JSON.stringify(entries) },
        });
      },
      { timeout: 10_000 }
    );
    return signals.length;
  } catch {
    return 0; // the radar is an instrument, not a load-bearing wall
  }
}

/** Scans a text and records anything emerging — the one-call wire for every pipeline site. */
export async function scanAndRecord(text: string, repo: string, samplePath?: string): Promise<EmergingSignal[]> {
  const signals = detectEmergingModels(text);
  if (signals.length > 0) await recordEmergingSignals(signals, repo, samplePath);
  return signals;
}

// ---------- Auto-generated hunt wave ----------

/**
 * The 7-pattern wave for a confirmed emerging version — the same shapes that
 * caught the fable 5.2 wave day-one (FRONTIER_MODEL_POOL), parameterized.
 */
export function waveQueriesFor(entry: { id: string; label: string; version: number }): { q: string; kind: "code" | "repo"; why: string }[] {
  // claude-fable-5-3 → "claude-fable-5-3" + "fable 5.3" (both pin spellings)
  const idQ = `"${entry.id}"`;
  const words = entry.id.replace(/^claude-/, "").split("-");
  const maj = Math.floor(entry.version);
  const min = String(entry.version).split(".")[1] ?? "0";
  const spoken = `${words[0]} ${maj}.${min}`;
  const spokenQ = `"${entry.id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}" OR "${spoken}"`;
  return [
    { q: idQ, kind: "code", why: `${entry.label} model-string pin — day-one adopters` },
    { q: `${entry.id} filename:SKILL.md`, kind: "code", why: `skills written for ${entry.label}` },
    { q: `${spoken} filename:CLAUDE.md`, kind: "code", why: `project contracts pinning ${entry.label}` },
    { q: `${spokenQ} system prompt`, kind: "code", why: `system-prompt engineering for ${entry.label}` },
    { q: `"claude-opus-5-5" ${idQ}`, kind: "code", why: `routers comparing opus 5.5 vs ${entry.label}` },
    { q: `${spoken} created:{fresh}`, kind: "repo", why: `repos born around the ${entry.label} release` },
    { q: `${spoken} eval`, kind: "code", why: `eval harnesses measuring ${entry.label}` },
  ];
}

/**
 * Arsenal feed — queries for the top confirmed ledger entries by momentum
 * (mentions). An emerging wave is young: probing it every run cannot saturate,
 * so it joins WITHOUT rotation, capped to keep the query budget honest.
 */
export function emergingModelQueries(
  ledger: LedgerEntry[]
): { q: string; kind: "code" | "repo"; why: string; entryId: string }[] {
  const confirmed = ledger
    .filter((e) => e.confirmed)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, MAX_WAVE_ENTRIES);
  const out: { q: string; kind: "code" | "repo"; why: string; entryId: string }[] = [];
  for (const e of confirmed) {
    for (const w of waveQueriesFor(e)) out.push({ ...w, entryId: e.id });
  }
  return out;
}
