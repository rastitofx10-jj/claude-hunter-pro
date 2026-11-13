// ============================================================
// Emerging-model radar — the frontier becomes self-detecting, TRUTH-GATED.
//
// ROAST-FINDING (2026-11-12, truth migration): the old confirmation rule —
// "≥2 distinct repos mention it = confirmed wave" — confirmed TEXT, not
// MODELS. Two hallucinating spam repos ("awesome-fable5-5-videos" style)
// were enough to declare a fictional model a LIVE WAVE, steer the arsenal
// after it, and burn the code-search quota hunting hallucinations. The
// ledger held a "confirmed" entry for a model that does not exist.
//
// The new discipline (data before doctrine, AUTHORITY before action):
//   1. SIGNAL — a pin above the REAL registry frontier (opus/sonnet/haiku
//      above 4.5, or a plausible new family ≥ 4.5) is recorded from any
//      text the pipeline touches. Fiction words (fable) are never signals.
//   2. VOUCH — ≥2 distinct repos vouching marks the entry vouchReached.
//      This alone steers NOTHING.
//   3. AUTHORITY — an org:anthropics code-search hit for the exact id is
//      the only path to "confirmed". Anthropic's own repos (SDKs, docs,
//      claude-code) carry real model ids on day one; spam repos don't.
//      Only authority-confirmed waves feed the arsenal.
// Everything stays recorded either way — noise included, labeled as noise.
// ============================================================

import { QUALIFYING_MODELS, MIN_QUALIFYING_VERSION, type ModelFamily } from "./claude-models";
import { ghSearchWithBackoff } from "./github";
import { db } from "./db";

/** Product words that look like model families but never are (claude-code-2-1 is a product version, not a model). */
const NON_FAMILY_WORDS = new Set([
  "code", "cli", "sdk", "desktop", "agent", "agents", "ai", "api", "pro", "free",
  "chat", "dev", "docs", "doc", "hub", "app", "web", "extension", "vscode",
  "action", "actions", "workflow", "workflows", "mcp", "server", "proxy",
]);

/** Words that name FICTIONAL families — never a signal, only contamination. */
export const FICTION_WORDS = new Set(["fable"]);

/** A version pin above the real frontier — the raw detection unit. */
export interface EmergingSignal {
  /** Synthesized id, e.g. claude-opus-4-6 / claude-myth-5-0 */
  id: string;
  family: ModelFamily | string;
  /** e.g. 4.6 */
  version: number;
  /** e.g. "Opus 4.6" */
  label: string;
  /** known-family version above the real frontier | a family the registry has never seen */
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
  kind: "emerging" | "candidate" | "fiction";
  firstSeen: string;
  lastSeen: string;
  /** Distinct repos that mentioned it — the vouch metric */
  repos: string[];
  /** Total mentions across all texts */
  mentions: number;
  /** Up to 3 real file paths where it was seen */
  samplePaths: string[];
  /** true once an org:anthropics search hit confirms the model is REAL — the only path to arsenal control */
  confirmed: boolean;
  /** true once ≥2 repos vouch (pre-authority state — steers nothing) */
  vouchReached?: boolean;
  /** ISO time of the last authority check */
  authorityCheckedAt?: string;
  /** true if the authority search hit (real model, confirmed) */
  authorityHit?: boolean;
}

const LEDGER_KEY = "frontierLedger";
/** Distinct repos required before an entry is worth an authority check. */
export const CONFIRM_REPO_MIN = 2;
/** Max confirmed entries feeding the arsenal per run (budget discipline). */
const MAX_WAVE_ENTRIES = 2;

/** Highest REAL registered version per family — the frontier line to be above. */
function familyFrontier(): Map<string, number> {
  const m = new Map<string, number>();
  for (const reg of QUALIFYING_MODELS) {
    if (reg.family === "generic") continue;
    const cur = m.get(reg.family);
    if (cur === undefined || reg.version > cur) m.set(reg.family, reg.version);
  }
  return m;
}

/** The line a version must be ABOVE to count as emerging for a family. */
function frontierLineFor(family: string, frontier: Map<string, number>): number {
  return frontier.get(family) ?? Math.max(...Array.from(frontier.values()), MIN_QUALIFYING_VERSION);
}

function fmtLabel(family: string, v: number): string {
  const fam = family.charAt(0).toUpperCase() + family.slice(1);
  return `${fam} ${v}`;
}

/**
 * Detects emerging-frontier pins in free text — ABOVE the REAL registry line.
 * Two detection classes, both version-gated:
 *  1. emerging — a KNOWN family (opus/sonnet/haiku) pinned ABOVE its highest
 *     real registered version: "claude-opus-4-6", "opus 5", "claude-sonnet-5".
 *  2. candidate — a family word the registry has never seen, pinned ≥ 4.5
 *     with an explicit minor: "claude-myth-5-0". Product words are excluded.
 * Fiction words (fable) never produce signals. Below-frontier pins are not
 * signals — they are either registered models or noise.
 */
export function detectEmergingModels(text: string): EmergingSignal[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const frontier = familyFrontier();
  const out = new Map<string, EmergingSignal>();

  // Known families: claude-opus-4-6 / claude opus 5 / opus-4-6 (hyphen/space/underscore)
  const reKnown = /claude[-_ ]?(opus|sonnet|haiku)[-_ ]?(\d{1,2})(?:[-_. ,](\d{1,2}))?(?!\d)/gi;
  // Standalone family phrasing (the frontier-wave evidence style): "written for opus 4.6"
  const reBare = /\b(opus|sonnet|haiku)[-_ ]?(\d{1,2})(?:[-_. ,](\d{1,2}))?(?!\d)/gi;
  // Unknown family candidates: claude-<word>-<maj>-<min>, version ≥ 4.5, word alphabetic
  const reNew = /claude-([a-z]{3,12})-(\d{1,2})-(\d{1,2})(?!\d)/gi;

  const add = (s: EmergingSignal) => {
    const prev = out.get(s.id);
    if (!prev) out.set(s.id, s);
  };

  const known = (fam: string, maj: number, min: number | null, match: string, isClaudePrefixed: boolean) => {
    if (FICTION_WORDS.has(fam)) return; // fable is fiction, never a signal
    if (maj < 1 || maj > 9) return;
    if (min != null && (min < 0 || min > 9)) return;
    const family = fam as ModelFamily;
    const version = min == null ? maj : Number(`${maj}.${min}`);
    const line = frontierLineFor(family, frontier);
    if (version <= line) return; // registered or below the real frontier — not emerging
    const id = min == null ? `claude-${family}-${maj}` : `claude-${family}-${maj}-${min}`;
    add({ id, family, version, label: fmtLabel(family, version), kind: "emerging", match });
    void isClaudePrefixed;
  };

  let m: RegExpExecArray | null;
  while ((m = reKnown.exec(lower))) known(m[1], Number(m[2]), m[3] != null ? Number(m[3]) : null, m[0], true);
  while ((m = reBare.exec(lower))) {
    // Without a claude/anthropic prefix, require an explicit minor (X.Y):
    // bare "opus 5" could be prose. The X.Y form is a pin.
    if (m[3] == null) continue;
    known(m[1], Number(m[2]), Number(m[3]), m[0], false);
  }
  while ((m = reNew.exec(lower))) {
    const word = m[1];
    if (NON_FAMILY_WORDS.has(word) || FICTION_WORDS.has(word)) continue;
    if (["opus", "sonnet", "haiku"].includes(word)) continue; // known families handled above
    const maj = Number(m[2]);
    const min = Number(m[3]);
    if (maj < 4 || maj > 9 || min > 9) continue;
    const version = Number(`${maj}.${min}`);
    if (version < 4.5) continue; // a real new family ships at/above the current frontier
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
 *
 * NOTE: reaching CONFIRM_REPO_MIN repos sets vouchReached only — text mentions
 * NEVER confirm. Confirmation is authority-only (promoteWithAuthority).
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
          if (!e.vouchReached && e.repos.length >= CONFIRM_REPO_MIN) e.vouchReached = true;
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

// ---------- The authority gate ----------

/**
 * THE fix for the spam-confirmation flaw: an org:anthropics code search for
 * the exact id is the only path from vouch to confirmed. Anthropic's own
 * repos (SDKs, docs, claude-code) carry every real model id from day one;
 * hallucinating spam repos never appear there. One query per entry, capped.
 */
export async function promoteWithAuthority(
  token: string | null,
  maxChecks = 3
): Promise<{ checked: number; confirmed: number }> {
  const ledger = await loadFrontierLedger();
  // round 8: authorityCheckedAt was WRITE-ONLY (nothing ever read it) — a definitive
  // miss (org:anthropics does NOT contain the id) left the entry in pending, costing
  // one real code-search query (the 10/min quota the codebase paces at 6.5s) on EVERY
  // sweep/hunt/arsenal build, forever, for spam-vouched entries that will never confirm.
  // It is read now: a definitive miss backs off 7 days before it can be re-checked.
  const AUTHORITY_MISS_BACKOFF_MS = 7 * 24 * 3600_000;
  const pending = ledger
    .filter((e) => {
      if (!e.vouchReached || e.confirmed || e.authorityHit || e.kind === "fiction") return false;
      if (e.authorityCheckedAt && Date.now() - new Date(e.authorityCheckedAt).getTime() < AUTHORITY_MISS_BACKOFF_MS) {
        return false; // definitively checked recently — backoff window
      }
      return true;
    })
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, maxChecks);
  if (pending.length === 0) return { checked: 0, confirmed: 0 };

  let confirmedCount = 0;
  for (const e of pending) {
    let hit = false;
    try {
      const resp = await ghSearchWithBackoff<{ total_count?: number }>(
        `/search/code?q=${encodeURIComponent(`org:anthropics "${e.id}"`)}&per_page=1&page=1`,
        token
      );
      hit = (resp.total_count ?? 0) > 0;
    } catch {
      // quota/network failure — leave unchecked, next cycle retries
      continue;
    }
    const now = new Date().toISOString();
    confirmedCount += hit ? 1 : 0;
    await db.$transaction(
      async (tx) => {
        const row = await tx.setting.findUnique({ where: { key: LEDGER_KEY } });
        let entries: LedgerEntry[] = [];
        try {
          const v = row?.value ? JSON.parse(row.value) : [];
          if (Array.isArray(v)) entries = v;
        } catch { /* rebuild below */ }
        const target = entries.find((x) => x.id === e.id);
        if (target) {
          target.authorityCheckedAt = now;
          if (hit) {
            target.authorityHit = true;
            target.confirmed = true; // authority is one-way: a real model stays real
          }
        }
        await tx.setting.upsert({
          where: { key: LEDGER_KEY },
          update: { value: JSON.stringify(entries) },
          create: { key: LEDGER_KEY, value: JSON.stringify(entries) },
        });
      },
      { timeout: 10_000 }
    );
  }
  return { checked: pending.length, confirmed: confirmedCount };
}

// ---------- Auto-generated hunt wave ----------

/**
 * The 7-pattern wave for an authority-confirmed emerging version — the same
 * shapes that catch real release-day content, parameterized.
 */
export function waveQueriesFor(entry: { id: string; label: string; version: number }): { q: string; kind: "code" | "repo"; why: string }[] {
  // claude-opus-4-6 → "claude-opus-4-6" + "opus 4.6" (both pin spellings)
  const idQ = `"${entry.id}"`;
  const words = entry.id.replace(/^claude-/, "").split("-");
  const maj = Math.floor(entry.version);
  // Round 9 — an INTEGER version (e.g. 5) fabricated a minor ("5.0"): 3 of the 7
  // wave queries then probed the misspelled "opus 5.0" pin while real day-one
  // adopters write "opus 5" / "claude-opus-5". Integer versions speak without a minor.
  const hasMinor = !Number.isInteger(entry.version);
  const min = hasMinor ? String(entry.version).split(".")[1] : null;
  const spoken = min != null ? `${words[0]} ${maj}.${min}` : `${words[0]} ${maj}`;
  const spokenQ = min != null
    ? `"${entry.id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}" OR "${spoken}"`
    : `"${entry.id}" OR "${spoken}"`;
  return [
    { q: idQ, kind: "code", why: `${entry.label} model-string pin — day-one adopters` },
    { q: `${entry.id} filename:SKILL.md`, kind: "code", why: `skills written for ${entry.label}` },
    { q: `${spoken} filename:CLAUDE.md`, kind: "code", why: `project contracts pinning ${entry.label}` },
    { q: `${spokenQ} system prompt`, kind: "code", why: `system-prompt engineering for ${entry.label}` },
    { q: `"claude-opus-4-5" ${idQ}`, kind: "code", why: `routers comparing the real frontier (opus 4.5) vs ${entry.label}` },
    { q: `${spoken} created:{fresh}`, kind: "repo", why: `repos born around the ${entry.label} release` },
    { q: `${spoken} eval`, kind: "code", why: `eval harnesses measuring ${entry.label}` },
  ];
}

/**
 * Arsenal feed — queries for the top AUTHORITY-CONFIRMED ledger entries by
 * momentum (mentions). Unconfirmed vouches never steer the arsenal; fiction
 * entries never do either. A confirmed wave is young: probing it every run
 * cannot saturate, so it joins WITHOUT rotation, capped to keep the budget honest.
 */
export function emergingModelQueries(
  ledger: LedgerEntry[]
): { q: string; kind: "code" | "repo"; why: string; entryId: string }[] {
  const confirmed = ledger
    .filter((e) => e.confirmed && e.kind !== "fiction")
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, MAX_WAVE_ENTRIES);
  const out: { q: string; kind: "code" | "repo"; why: string; entryId: string }[] = [];
  for (const e of confirmed) {
    for (const w of waveQueriesFor(e)) out.push({ ...w, entryId: e.id });
  }
  return out;
}
