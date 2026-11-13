// ============================================================
// The model truth registry — Claude Hunter
//
// ROAST-FINDING (2026-11-12, truth migration): this file previously held
// an INVERTED ontology — a fictional registry ("Fable 5/5.1/5.2/5.5",
// "Opus 5.5/5.6/6/6.5/7") marked as premium, while every REAL model
// (Opus 4.5, Sonnet 4.5, Haiku 4.5 — the actual strongest models Anthropic
// ships) was hard-blocked as "below threshold". The fiction self-reinforced:
// LLM prompts taught it, hunts hunted it, spam repos confirmed it, tests
// asserted it. The system confidently scored hallucinations as premium and
// disqualified reality.
//
// The truth anchor (enforced from here on):
//   ✔ REAL models only — the registered lineup below, exactly as Anthropic
//     ships it. Opus 4.5 is the strongest model that exists today.
//   ✔ The 4.x family IS the real premium tier. Weights ladder by real
//     capability: Opus 4.5 (45) > Sonnet 4.5 (34) > Haiku 4.5 (26) > older.
//   ⛔ FICTION strings — the "fable" family, any opus/sonnet/haiku above
//     4.5, any "claude 5/6/7" — are flagged as hallucination contamination:
//     zero credit, negative trust signal, never offered as a filter.
//   ⛔ Ancient models (Claude 1/2 era) are blocked: real, but worthless
//     as hunting targets in 2026.
//   ⚠ A pin ABOVE the real frontier (e.g. a genuine future "opus 5") is NOT
//     credited here — that is the emerging radar's job (emerging-models.ts),
//     and it only steers the arsenal after AUTHORITATIVE verification
//     (org:anthropics), never after mere text mentions.
// ============================================================

export const MIN_QUALIFYING_VERSION = 3; // Claude 3 era and up = real, creditable models
export const THRESHOLD_LABEL = "real-model gate";
export const THRESHOLD_RULE_TEXT =
  "Only REAL Anthropic models count: Opus 4.5 is the strongest that exists today, the 4.x family is the real premium tier. Fictional strings (fable, opus 5+, claude 5+) are hallucination contamination — zero credit.";

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "generic";

export interface ClaudeModelDef {
  id: string; // canonical id, e.g. claude-opus-4-5
  label: string; // Opus 4.5
  family: ModelFamily;
  version: number; // 4.5
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
  /** fictional model strings found in the text (fable, opus 5+, claude 5+) — contamination, zero credit */
  fiction: BlockedModelHit[];
  /** true if only blocked models (claude-2 era) were detected and no qualifying model */
  blockedOnly: boolean;
  /** true if fictional pins were detected and no real qualifying model — the text is hallucination-poisoned */
  fictionOnly: boolean;
}

const FAMILY_LABEL: Record<ModelFamily, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  generic: "Claude",
};

/** Words that never name a real model family — pins under them are fiction. */
const FICTION_FAMILIES = new Set(["fable"]);

/**
 * The registry of REAL models, exactly as Anthropic ships them.
 * Weight ladder = real capability tier (the user's target: the strongest
 * there is → Opus 4.5, full weight 45).
 */
export const QUALIFYING_MODELS: ClaudeModelDef[] = [
  {
    id: "claude-opus-4-5",
    label: "Opus 4.5",
    family: "opus",
    version: 4.5,
    weight: 45,
    searchStrings: ["claude-opus-4-5", "claude-opus-4.5", "claude opus 4.5", "opus 4.5", "claude-opus-4-5-20251101"],
  },
  {
    id: "claude-sonnet-4-5",
    label: "Sonnet 4.5",
    family: "sonnet",
    version: 4.5,
    weight: 34,
    searchStrings: ["claude-sonnet-4-5", "claude-sonnet-4.5", "claude sonnet 4.5", "sonnet 4.5", "claude-sonnet-4-5-20250514"],
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    family: "haiku",
    version: 4.5,
    weight: 26,
    searchStrings: ["claude-haiku-4-5", "claude-haiku-4.5", "claude haiku 4.5", "haiku 4.5", "claude-haiku-4-5-20251015"],
  },
  {
    id: "claude-opus-4-1",
    label: "Opus 4.1",
    family: "opus",
    version: 4.1,
    weight: 30,
    searchStrings: ["claude-opus-4-1", "claude opus 4.1", "opus 4.1", "claude-opus-4-1-20250805"],
  },
  {
    id: "claude-opus-4",
    label: "Opus 4",
    family: "opus",
    version: 4,
    weight: 28,
    searchStrings: ["claude-opus-4", "claude-opus-4-20250514"],
  },
  {
    id: "claude-sonnet-4",
    label: "Sonnet 4",
    family: "sonnet",
    version: 4,
    weight: 24,
    searchStrings: ["claude-sonnet-4", "claude-sonnet-4-20250514"],
  },
  {
    id: "claude-3-7-sonnet",
    label: "Sonnet 3.7",
    family: "sonnet",
    version: 3.7,
    weight: 16,
    searchStrings: ["claude-3-7-sonnet", "claude-3-7-sonnet-20250219"],
  },
  {
    id: "claude-3-5-sonnet",
    label: "Sonnet 3.5",
    family: "sonnet",
    version: 3.5,
    weight: 14,
    searchStrings: ["claude-3-5-sonnet", "claude-3-5-sonnet-20241022"],
  },
  {
    id: "claude-3-5-haiku",
    label: "Haiku 3.5",
    family: "haiku",
    version: 3.5,
    weight: 10,
    searchStrings: ["claude-3-5-haiku", "claude-3-5-haiku-20241022"],
  },
  {
    id: "claude-3-opus",
    label: "Opus 3",
    family: "opus",
    version: 3,
    weight: 8,
    searchStrings: ["claude-3-opus", "claude-3-opus-20240229"],
  },
  {
    id: "claude-3-sonnet",
    label: "Sonnet 3",
    family: "sonnet",
    version: 3,
    weight: 6,
    searchStrings: ["claude-3-sonnet", "claude-3-sonnet-20240229"],
  },
  {
    id: "claude-3-haiku",
    label: "Haiku 3",
    family: "haiku",
    version: 3,
    weight: 4,
    searchStrings: ["claude-3-haiku", "claude-3-haiku-20240307"],
  },
];

/** The real frontier per family — the highest version Anthropic actually ships. */
export function realFamilyFrontier(): Partial<Record<ModelFamily, number>> {
  const m: Partial<Record<ModelFamily, number>> = {};
  for (const reg of QUALIFYING_MODELS) {
    if (reg.family === "generic") continue;
    const cur = m[reg.family];
    if (cur === undefined || reg.version > cur) m[reg.family] = reg.version;
  }
  return m;
}

/**
 * The frontier line for QUERY GENERATION — the hunt budget.
 *
 * DEVICE DIRECTIVE (2026-11-13, enforced in code): frontier/strongest models
 * only, no old/useless models. Field evidence that motivated it: the sweep
 * arsenal spent 20 of 72 queries per run hunting 9 stale model strings
 * (claude-3-haiku and friends) — a THIRD of the hunt budget on corners whose
 * result set is historically fixed. The harvest rotated onto claude-3-era
 * strings on entire days. The Genesis harvest UI copy already claimed
 * "real-frontier code searches (opus-4-5 · sonnet-4-5 · haiku-4-5)" — the
 * arsenal now makes that copy true.
 *
 * Only models AT each family's real frontier (the strongest real version per
 * family) generate hunt queries. Older registry models keep their roles in
 * DETECTION and SCORING (a found repo gets its full model field), but they
 * never steer the hunt budget again — the same treatment the registry already
 * gives Claude 1/2-era models, one generation up. When the registry itself
 * registers a new real version (e.g. a genuine future opus 4.6), the frontier
 * line moves with it automatically.
 */
export function frontierModels(): ClaudeModelDef[] {
  const frontier = realFamilyFrontier();
  return QUALIFYING_MODELS.filter(
    (m) => m.family !== "generic" && m.version >= (frontier[m.family] ?? Infinity)
  );
}

/** Labels for known ancient (blocked) models — real, but pre-2024 legacy. */
const KNOWN_BLOCKED_LABELS: Record<string, string> = {
  "claude-2": "Claude 2",
  "claude-2-1": "Claude 2.1",
  "claude-2-0": "Claude 2",
  "claude-1": "Claude 1",
  "claude-instant": "Claude Instant",
};

/**
 * Classification by version against REALITY:
 *  - fable family → always FICTION (no such family exists).
 *  - known family above its real frontier (> 4.5) → FICTION (future or
 *    fantasy — only the authority-gated radar may promote a real release).
 *  - claude-generic ≥ 5 → FICTION; ≤ 2 → BLOCKED (ancient); 3/4 → real low weight.
 *  - registered real versions → ladder weight.
 *  - unregistered versions inside the real range → zero credit, not fiction,
 *    not blocked (ignored — the honest treatment of noise).
 */
export function classifyVersion(
  v: number,
  family: ModelFamily
): { qualifying: boolean; weight: number; fiction: boolean } {
  if (!Number.isFinite(v)) return { qualifying: false, weight: 0, fiction: false };
  if (FICTION_FAMILIES.has(family)) return { qualifying: false, weight: 0, fiction: true };
  if (family === "generic") {
    if (v >= 5) return { qualifying: false, weight: 0, fiction: true };
    if (v < 3) return { qualifying: false, weight: 0, fiction: false }; // claude 1/2/2.1 era — ancient, blocked
    const w = v >= 4 ? 8 : 5; // "claude 3/4" generic mentions — real era, low signal
    return { qualifying: true, weight: w, fiction: false };
  }
  const frontier = realFamilyFrontier()[family] ?? 4.5;
  if (v > frontier) return { qualifying: false, weight: 0, fiction: true };
  if (v < MIN_QUALIFYING_VERSION) return { qualifying: false, weight: 0, fiction: false };
  const reg = QUALIFYING_MODELS.find((m) => m.family === family && m.version === v);
  if (!reg) return { qualifying: false, weight: 0, fiction: false }; // unregistered noise inside the real range
  return { qualifying: true, weight: reg.weight, fiction: false };
}

function fmtVersion(maj: number, min: number | null): number {
  return min == null ? maj : Number(`${maj}.${min}`);
}

function buildId(family: ModelFamily, maj: number, min: number | null): string {
  if (family === "generic") return min == null ? `claude-${maj}` : `claude-${maj}-${min}`;
  // Real Anthropic id formats differ by era: the 3.x family ids put the family
  // LAST (claude-3-5-sonnet, claude-3-opus); the 4.x era puts it FIRST
  // (claude-opus-4-5). Matching the real format means registry lookups hit.
  if (maj < 4) return min == null ? `claude-${maj}-${family}` : `claude-${maj}-${min}-${family}`;
  return min == null ? `claude-${family}-${maj}` : `claude-${family}-${maj}-${min}`;
}

function buildLabel(family: ModelFamily, maj: number, min: number | null): string {
  const fam = FAMILY_LABEL[family];
  return min == null ? `${fam} ${maj}` : `${fam} ${maj}.${min}`;
}

/**
 * Detects models in free text (README, description, CLAUDE.md, settings).
 * Full three-way separation: qualifying (REAL, registered) vs blocked
 * (ancient claude-2 era) vs fiction (fable, opus 5+, claude 5+ —
 * hallucination contamination).
 */
export function detectClaudeModels(text: string): ModelDetection {
  const qualifying = new Map<string, ClaudeModelDef>();
  const blocked = new Map<string, BlockedModelHit>();
  const fiction = new Map<string, BlockedModelHit>();
  if (!text) return { qualifying: [], blocked: [], fiction: [], blockedOnly: false, fictionOnly: false };
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
    blocked.set(id, { id, label, version: v, reason: `Claude ${v}-era model — real but ancient, worthless as a 2026 hunting target` });
  };
  const addFiction = (id: string, family: ModelFamily, v: number) => {
    const label = `${buildLabel(family, Math.floor(v), v % 1 ? Number(String(v).split(".")[1]) : null)} (fictional)`;
    fiction.set(id, { id, label, version: v, reason: `"${id}" is not a real Anthropic model — flagged as hallucination contamination` });
  };

  const handle = (family: ModelFamily, maj: number, min: number | null) => {
    // Sanitization against prose false positives: only plausible version numbers — maj 1-9, min 0-9.
    if (!Number.isInteger(maj) || maj < 1 || maj > 9) return;
    if (min != null && (!Number.isInteger(min) || min < 0 || min > 9)) return;
    const v = fmtVersion(maj, min);
    const id = buildId(family, maj, min);
    const { qualifying: ok, fiction: fic } = classifyVersion(v, family);
    if (ok) addQual(id, family, v);
    else if (fic) addFiction(id, family, v);
    else addBlocked(id, family, v);
  };

  // claude-opus-4-5 / claude_opus_4_5 / claude opus 4.5 / claude-opus-4-5-20251101
  // Round 9 — plural-tolerant families: "Claude Fables 5" / "fables 5.1" bypassed the
  // fiction gate before (the s between family and version broke every regex). The
  // family stays a CAPTURING group (m[1]) — the handler indexes by capture position.
  const re1 = /claude[-_ ]?(opus|sonnet|haiku|fable)s?[-_ ]?(\d{1,2})(?!\d)(?:[-_. ,](\d{1,2}))?(?!\d)/gi;
  // claude-3-5-sonnet / claude-3-7-sonnet-20250219 / claude-5-5
  const re2 = /claude[-_ ](\d{1,2})(?!\d)[-_. ](\d{1,2})(?!\d)(?:[-_ ]?(opus|sonnet|haiku|fable)s?)?/gi;
  // opus 4.5 / opus-4.5 / sonnet-4-5 (also without the claude prefix) — including the decimal comma "opus 4,5"
  const re3 = /\b(opus|sonnet|haiku|fable)s?[-_ ]?(\d{1,2})(?!\d)(?:[-_. ,](\d{1,2}))?(?!\d)/gi;
  // claude-3 / claude 4 — a generic model mention without a family.
  const re4 = /claude[-_ ](\d{1,2})(?!\d)/gi;

  let m: RegExpExecArray | null;
  while ((m = re1.exec(lower))) handle(m[1] as ModelFamily, Number(m[2]), m[3] != null ? Number(m[3]) : null);
  while ((m = re2.exec(lower))) {
    const fam = (m[3] as ModelFamily | undefined) ?? "generic";
    handle(fam, Number(m[1]), Number(m[2]));
  }
  while ((m = re3.exec(lower))) {
    const fam = m[1] as ModelFamily;
    // Standalone family phrasing without the claude/anthropic prefix requires an
    // explicit minor (X.Y): "opus 4.5" is a pin, bare "opus 4" is usually prose
    // ("opus 4 chapters"). Prefix-form is covered by re1.
    if (m[3] == null) continue;
    handle(fam, Number(m[2]), Number(m[3]));
  }
  while ((m = re4.exec(lower))) handle("generic", Number(m[1]), null);

  // "fable" context mentions (claude fable / fables / fable model / model: fable)
  // are FICTION hits — the word never names a real model. Contamination is tracked,
  // never credited. Round 9 — plural forms ("Claude Fables", "fables model") join
  // the same gate; before, "fables" slipped every context check (\bfable\b boundary).
  if (
    /\b(?:claude|anthropic)[^\w]{0,3}fables?\b/.test(lower) ||
    /\bfables?[^\w]{0,3}(?:model|models|claude|anthropic)\b/.test(lower) ||
    /\bmodel[^\w]{0,4}fables?\b/.test(lower)
  ) {
    fiction.set("claude-fable", {
      id: "claude-fable",
      label: "Fable (fictional)",
      version: 0,
      reason: `"fable" is not a real Anthropic model family — flagged as hallucination contamination`,
    });
  }

  // De-duplication: remove a qualifying model that is a prefix of a longer qualifying one from the same family
  const qList0 = Array.from(qualifying.values()).filter(
    (a) => !Array.from(qualifying.values()).some((b) => b !== a && b.id.startsWith(`${a.id}-`))
  );
  // Hardening: remove a generic qualifying model (e.g. claude-3) if a family qualifying model with the same version exists
  const qList = qList0.filter(
    (a) => !(a.family === "generic" && qList0.some((b) => b.family !== "generic" && b.version === a.version))
  );
  const bList = Array.from(blocked.values()).filter(
    (a) => !qList.some((q) => q.id.startsWith(a.id)) && !Array.from(blocked.values()).some((b) => b !== a && b.id.startsWith(`${a.id}-`))
  );
  const fList = Array.from(fiction.values());

  return {
    qualifying: qList.sort((a, b) => b.weight - a.weight),
    blocked: bList.sort((a, b) => b.version - a.version),
    fiction: fList,
    blockedOnly: qList.length === 0 && bList.length > 0,
    fictionOnly: qList.length === 0 && fList.length > 0,
  };
}

/**
 * Detects a model in a CONTROLLED model-field value (settings.json "model",
 * env ANTHROPIC_MODEL). The context is known: whatever the field holds IS a
 * model identifier. A bare family name resolves to that family's REAL
 * frontier model ("opus" → Opus 4.5) — that is how Claude Code aliases work.
 * A fictional value ("fable", "opus-5-5") returns null: no real model pinned.
 */
export function detectModelFieldValue(s: string): ClaudeModelDef | null {
  const v = s.trim().toLowerCase();
  if (!v) return null;
  // 1) A full registry id or search string: claude-opus-4-5 / opus 4.5
  const reg = QUALIFYING_MODELS.find(
    (m) => m.id === v || m.searchStrings.some((ss) => ss.toLowerCase() === v)
  );
  if (reg) return reg;
  // 2) A versioned family id without the claude- prefix: opus-4-5 / opus 4.5
  const det = detectClaudeModels(v);
  if (det.qualifying.length > 0) return det.qualifying[0];
  // 3) A bare family name → the family's real frontier model
  if (v === "opus" || v === "claude-opus") return QUALIFYING_MODELS.find((m) => m.id === "claude-opus-4-5") ?? null;
  if (v === "sonnet" || v === "claude-sonnet") return QUALIFYING_MODELS.find((m) => m.id === "claude-sonnet-4-5") ?? null;
  if (v === "haiku" || v === "claude-haiku") return QUALIFYING_MODELS.find((m) => m.id === "claude-haiku-4-5") ?? null;
  // 4) Fictional values fall through — they pin no real model
  return null;
}

/**
 * A strict check for a "model" string coming from the filters.
 * Returns true if the string describes NO real qualifying model — either an
 * ancient model or a fictional one. Fictional filters are blocked on the
 * server side too: searching for hallucinations wastes the code-search quota.
 */
export function isBlockedModelString(s: string): boolean {
  if (!s) return false;
  // A bare fiction family word ("fable" / "claude-fable") is fiction even without
  // a version — the filter must not send the quota hunting hallucinations.
  const v = s.trim().toLowerCase();
  const bare = v.replace(/^claude-/, "");
  if (FICTION_FAMILIES.has(bare)) return true;
  const det = detectClaudeModels(s);
  return det.blocked.length > 0 && det.qualifying.length === 0
    ? true
    : det.fiction.length > 0 && det.qualifying.length === 0;
}

/** Filter options for the UI — derived automatically from the REAL registry. */
export function qualifyingModelOptions(): { value: string; label: string }[] {
  const frontier = realFamilyFrontier();
  return QUALIFYING_MODELS.map((m) => {
    const isFrontier = frontier[m.family] === m.version;
    const spark = isFrontier ? "★ " : "";
    return { value: m.id, label: `${spark}${m.label}${isFrontier ? " — frontier" : ""}` };
  });
}
