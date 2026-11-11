// ============================================================
// The strict model threshold system — Claude Hunter
//
// Iron rule (a user requirement, not changeable from the UI):
//   ✔ Only models at version 5.5 and above count as "qualifying premium" — Opus 5.5, Fable, Opus 6+...
//   ⛔ The 4.x family and every version below 5.5 is completely blocked:
//      weight 0, not included in the score, not offered in the filters, and
//      blocked on the server side as well.
// ============================================================

export const MIN_QUALIFYING_VERSION = 5.5;
export const THRESHOLD_LABEL = "5.5+";
export const THRESHOLD_RULE_TEXT =
  "The model threshold is locked: only 5.5 and above (Opus 5.5, Fable — own 5.x track, Opus 6+) — the 4.x family is completely blocked";

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "generic";

export interface ClaudeModelDef {
  id: string; // canonical id, e.g. claude-opus-5-5
  label: string; // Opus 5.5
  family: ModelFamily;
  version: number; // 5.5
  weight: number; // contribution to the model score (cap 45)
  searchStrings: string[]; // exact strings for GitHub code search
}

export interface BlockedModelHit {
  id: string;
  label: string;
  version: number;
  reason: string;
}

export interface ModelDetection {
  qualifying: ClaudeModelDef[];
  blocked: BlockedModelHit[];
  /** true if only blocked models (4.x and below) were detected and no qualifying model */
  blockedOnly: boolean;
}

const FAMILY_LABEL: Record<ModelFamily, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  generic: "Claude",
};

/**
 * The registry of known qualifying models — all ≥ 5.5.
 * Fable is the highest premium flagship (full weight 45).
 */
export const QUALIFYING_MODELS: ClaudeModelDef[] = [
  {
    id: "claude-fable",
    label: "Fable",
    family: "fable",
    version: 5.5,
    weight: 45,
    searchStrings: ["claude-fable", "claude fable", "fable model"],
  },
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    family: "fable",
    version: 5.1,
    weight: 45,
    searchStrings: ["claude-fable-5-1"],
  },
  {
    id: "claude-fable-5-2",
    label: "Fable 5.2",
    family: "fable",
    version: 5.2,
    weight: 45,
    searchStrings: ["claude-fable-5-2", "fable 5.2"],
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    family: "opus",
    version: 5.5,
    weight: 42,
    searchStrings: ["claude-opus-5-5", "claude-opus-5.5", "opus 5.5"],
  },
  {
    id: "claude-opus-5-6",
    label: "Opus 5.6",
    family: "opus",
    version: 5.6,
    weight: 42,
    searchStrings: ["claude-opus-5-6", "claude-opus-5.6"],
  },
  {
    id: "claude-opus-6",
    label: "Opus 6",
    family: "opus",
    version: 6,
    weight: 44,
    searchStrings: ["claude-opus-6", "claude-opus-6-0", "opus 6"],
  },
  {
    id: "claude-opus-6-5",
    label: "Opus 6.5",
    family: "opus",
    version: 6.5,
    weight: 45,
    searchStrings: ["claude-opus-6-5", "claude-opus-6.5"],
  },
  {
    id: "claude-opus-7",
    label: "Opus 7",
    family: "opus",
    version: 7,
    weight: 45,
    searchStrings: ["claude-opus-7", "opus 7"],
  },
];

/** Labels for known blocked models (display only — their weight is always 0) */
const KNOWN_BLOCKED_LABELS: Record<string, string> = {
  "claude-opus-4-5": "Opus 4.5",
  "claude-opus-4-1": "Opus 4.1",
  "claude-opus-4": "Opus 4",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-sonnet-4": "Sonnet 4",
  "claude-3-7-sonnet": "Sonnet 3.7",
  "claude-3-5-sonnet": "Sonnet 3.5",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-haiku": "Haiku",
};

/**
 * Classification by version: below 5.5 → blocked (weight 0).
 * Above the threshold → weight by family and version (cap 45).
 * FABLE EXCEPTION: the fable family has its own version track — born premium
 * at 5.x with no 4.x heritage, so fable 5.1/5.2 qualify despite being < 5.5.
 * Before this fix (fable-probe, 2026-11-11 — the day Fable 5.2 shipped),
 * `claude-fable-5-2` pins were classified as BLOCKED and repos using the new
 * module got block-evidence instead of premium credit.
 */
export function classifyVersion(
  v: number,
  family: ModelFamily
): { qualifying: boolean; weight: number } {
  const minForFamily = family === "fable" ? 5.0 : MIN_QUALIFYING_VERSION;
  if (!Number.isFinite(v) || v < minForFamily) {
    return { qualifying: false, weight: 0 };
  }
  let base: number;
  if (family === "fable") base = 45;
  else if (v >= 6.5) base = 45;
  else if (v >= 6) base = 44;
  else base = 42; // 5.5–5.9
  if (family === "sonnet") base = Math.min(base, 32);
  if (family === "haiku") base = Math.min(base, 24);
  if (family === "generic") base = Math.min(base, 42);
  return { qualifying: true, weight: base };
}

function fmtVersion(maj: number, min: number | null): number {
  return min == null ? maj : Number(`${maj}.${min}`);
}

function buildId(family: ModelFamily, maj: number, min: number | null): string {
  // Fable: a bare family mention ("claude fable") keeps the family id, but a
  // versioned pin ("claude-fable-5-2") builds the specific id — previously ALL
  // fable mentions collapsed to "claude-fable" and the version was discarded,
  // so the new-module wave (5.1/5.2) was invisible as a distinct model signal.
  if (family === "fable") return min == null ? "claude-fable" : `claude-fable-${maj}-${min}`;
  if (family === "generic") return min == null ? `claude-${maj}` : `claude-${maj}-${min}`;
  return min == null ? `claude-${family}-${maj}` : `claude-${family}-${maj}-${min}`;
}

function buildLabel(family: ModelFamily, maj: number, min: number | null): string {
  const fam = FAMILY_LABEL[family];
  return min == null ? `${fam} ${maj}` : `${fam} ${maj}.${min}`;
}

/**
 * Detects models in free text (README, description, CLAUDE.md, settings).
 * Returns a full separation: qualifying (≥5.5) vs blocked (<5.5, including the entire 4.x family).
 */
export function detectClaudeModels(text: string): ModelDetection {
  const qualifying = new Map<string, ClaudeModelDef>();
  const blocked = new Map<string, BlockedModelHit>();
  if (!text) return { qualifying: [], blocked: [], blockedOnly: false };
  const lower = text.toLowerCase();

  const addQual = (id: string, family: ModelFamily, v: number) => {
    const reg = QUALIFYING_MODELS.find((m) => m.id === id);
    if (reg) {
      qualifying.set(reg.id, reg);
      return;
    }
    const { qualifying: ok, weight } = classifyVersion(v, family);
    if (!ok) return;
    qualifying.set(id, {
      id,
      label: buildLabel(family, Math.floor(v), v % 1 ? Number(String(v).split(".")[1]) : null),
      family,
      version: v,
      weight,
      searchStrings: [id],
    });
  };
  const addBlocked = (id: string, family: ModelFamily, v: number) => {
    const label = KNOWN_BLOCKED_LABELS[id] ?? buildLabel(family, Math.floor(v), v % 1 ? Number(String(v).split(".")[1]) : null);
    blocked.set(id, { id, label, version: v, reason: `Version ${v} is below the 5.5 threshold — the ${label.replace(/\s.*/, "")} family is blocked` });
  };

  const handle = (family: ModelFamily, maj: number, min: number | null) => {
    // Sanitization against false positives: only plausible version numbers — maj 1-9, min 0-9.
    // "opus 45" / "sonnet 4.25" from prose no longer counts as a version (prevents a wrong threshold crossing).
    if (!Number.isInteger(maj) || maj < 1 || maj > 9) return;
    if (min != null && (!Number.isInteger(min) || min < 0 || min > 9)) return;
    const v = fmtVersion(maj, min);
    const id = buildId(family, maj, min);
    const { qualifying: ok } = classifyVersion(v, family);
    if (ok) addQual(id, family, v);
    else addBlocked(id, family, v);
  };

  // claude-opus-4-5 / claude_opus_5_5 / claude opus 4.5 / claude-opus-4-5-20251101
  // maj: (\d{1,2}) + (?!\d) — so that "opus 45" is not captured as version 45
  const re1 = /claude[-_ ]?(opus|sonnet|haiku|fable)[-_ ]?(\d{1,2})(?!\d)(?:[-_. ,](\d{1,2}))?(?!\d)/gi;
  // claude-3-5-sonnet / claude-3-7-sonnet-20250219 / claude-5-5
  const re2 = /claude[-_ ](\d{1,2})(?!\d)[-_. ](\d{1,2})(?!\d)(?:[-_ ]?(opus|sonnet|haiku|fable))?/gi;
  // opus 5.5 / opus-5.5 / sonnet-4-5 (also without the claude prefix) — including the decimal comma "opus 5,5"
  const re3 = /\b(opus|sonnet|haiku)[-_ ]?(\d{1,2})(?!\d)(?:[-_. ,](\d{1,2}))?(?!\d)/gi;
  // claude-5 / claude 6 — a model mention without a family and without a minor version.
  // Iron rule: a mention without a minor = maj.0 → "claude 5" is blocked (5.0 < 5.5), "claude 6" qualifies (6.0 ≥ 5.5).
  const re4 = /claude[-_ ](\d{1,2})(?!\d)/gi;

  let m: RegExpExecArray | null;
  while ((m = re1.exec(lower))) handle(m[1] as ModelFamily, Number(m[2]), m[3] != null ? Number(m[3]) : null);
  while ((m = re2.exec(lower))) {
    const fam = (m[3] as ModelFamily | undefined) ?? "generic";
    handle(fam, Number(m[1]), Number(m[2]));
  }
  while ((m = re3.exec(lower))) handle(m[1] as ModelFamily, Number(m[2]), m[3] != null ? Number(m[3]) : null);
  while ((m = re4.exec(lower))) handle("generic", Number(m[1]), null);

  // fable stands alone — qualifies only with an explicit model context (false-positive prevention).
  // Strict formulas: "claude fable" / "claude-fable" / "anthropic's fable" /
  // "fable model" — but not just any fable story that mentions Claude (a critical fixed false positive).
  if (
    /\b(?:claude|anthropic)[^\w]{0,3}fable\b/.test(lower) ||
    /\bfable[^\w]{0,3}(?:model|models|claude|anthropic)\b/.test(lower)
  ) {
    addQual("claude-fable", "fable", 5.5);
  }

  // De-duplication: remove a qualifying model that is a prefix of a longer qualifying one from the same family
  const qList0 = Array.from(qualifying.values()).filter(
    (a) => !Array.from(qualifying.values()).some((b) => b !== a && b.id.startsWith(`${a.id}-`))
  );
  // Hardening: remove a generic qualifying model (e.g. claude-5-5) if a family qualifying model with the same version exists — prevents duplicates
  const qList = qList0.filter(
    (a) => !(a.family === "generic" && qList0.some((b) => b.family !== "generic" && b.version === a.version))
  );
  const bList = Array.from(blocked.values()).filter(
    (a) => !qList.some((q) => q.id.startsWith(a.id)) && !Array.from(blocked.values()).some((b) => b !== a && b.id.startsWith(`${a.id}-`))
  );

  return {
    qualifying: qList.sort((a, b) => b.weight - a.weight),
    blocked: bList.sort((a, b) => b.version - a.version),
    blockedOnly: qList.length === 0 && bList.length > 0,
  };
}

/**
 * A strict check for a "model" string coming from the filters.
 * Returns true if the string describes a model below the threshold (4.x and below) — blocked on the server.
 * If the string is also identified with a qualifying model (5.5+) — it is allowed.
 */
export function isBlockedModelString(s: string): boolean {
  if (!s) return false;
  const det = detectClaudeModels(s);
  return det.blocked.length > 0 && det.qualifying.length === 0;
}

/** Filter options for the UI — derived automatically from the registry, so 4.x cannot leak in */
export function qualifyingModelOptions(): { value: string; label: string }[] {
  return QUALIFYING_MODELS.map((m) => ({
    value: m.id,
    label: m.family === "fable" ? `✨ ${m.label} (5.5+)` : `${m.label} (5.5+)`,
  }));
}
