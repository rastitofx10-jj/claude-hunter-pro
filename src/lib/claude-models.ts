// ============================================================
// The model truth registry — Claude Hunter
//
// CORRECTION (2026-11-13): an earlier "truth migration" inverted this file. It
// was written against a stale picture of the lineup, declared Opus 4.5 the
// strongest model in existence and flagged Fable and everything above 4.5 as
// hallucinated "fiction" — while hard-blocking the models this tool exists to
// hunt. That is wrong. Anthropic's current lineup (Claude Platform docs) is:
//
//   Mythos tier  Claude Mythos 5.2 · Claude Fable 5.2 (same underlying model, extra
//                safeguards on Fable) — Fable 5 / 5.1 and Mythos 5 / 5.1 before it
//   Opus         Opus 5.5 (claude-opus-5-5)   — Opus 5, 4.8, 4.7, 4.6, 4.5 before it
//   Sonnet       Sonnet 5.5 (claude-sonnet-5-5) — Sonnet 5, 4.6, 4.5 before it
//   Haiku        Haiku 5.5 (claude-haiku-5-5)  — Haiku 4.5 before it
//
// The gate (enforced here, locked in code, not changeable from the UI):
//   ✔ QUALIFYING  — premium models: any Mythos-tier model (Fable / Mythos, v5+) and any
//                   Opus / Sonnet / Haiku at 5.5 or above. Weighted by capability tier.
//   ⛔ BLOCKED    — real but below the threshold: the whole 4.x family, Opus 5 / Sonnet 5,
//                   the 3.x family and the Claude 1/2 era. Detected and labeled, never
//                   credited, never used as a hunting target.
//   ⚠ UNVERIFIED  — pins ABOVE the known lineup (e.g. "opus 6"), unknown family words,
//                   or impossible versions. Not credited here: only the emerging-models
//                   radar can promote a new release, and only after an authoritative
//                   org:anthropics code-search hit — never on text mentions alone.
//                   (The field is still called `fiction` in ModelDetection for API
//                   stability; it now means "unverified", not "hallucinated".)
// ============================================================

export const MIN_QUALIFYING_VERSION = 5.5; // Opus / Sonnet / Haiku at 5.5+; Mythos-tier families qualify from v5
export const THRESHOLD_LABEL = "5.5+";
export const THRESHOLD_RULE_TEXT =
  "Only premium Claude models count: Mythos-tier models (Fable, Mythos) and Opus / Sonnet / Haiku 5.5 and above. The 4.x family, Opus 5 / Sonnet 5 and everything older are blocked. Versions above the known lineup stay unverified until Anthropic's own repos confirm them.";

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "mythos" | "generic";

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
  /** real models below the threshold (4.x, Opus 5, Sonnet 5, 3.x, Claude 1/2) — detected, never credited */
  blocked: BlockedModelHit[];
  /** UNVERIFIED pins: above the known lineup or an unknown family — zero credit until authority-confirmed */
  fiction: BlockedModelHit[];
  /** true if only blocked (below-threshold) models were detected and no qualifying model */
  blockedOnly: boolean;
  /** true if only unverified pins were detected and no qualifying model */
  fictionOnly: boolean;
}

const FAMILY_LABEL: Record<ModelFamily, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  mythos: "Mythos",
  generic: "Claude",
};

/** Families that belong to the Mythos tier: qualifying from version 5 on, no 4.x exists. */
const MYTHOS_TIER = new Set<ModelFamily>(["fable", "mythos"]);

/** Family words that never name a real model (none today — kept as an explicit extension point). */
const FICTION_FAMILIES = new Set<string>();

function def(
  family: ModelFamily,
  major: number,
  minor: number | null,
  weight: number,
  extra: string[] = []
): ClaudeModelDef {
  const v = minor == null ? major : Number(`${major}.${minor}`);
  const dash = minor == null ? `${major}` : `${major}-${minor}`;
  const dot = minor == null ? `${major}` : `${major}.${minor}`;
  const id = `claude-${family}-${dash}`;
  const fam = family;
  return {
    id,
    label: `${FAMILY_LABEL[family]} ${dot}`,
    family,
    version: v,
    weight,
    searchStrings: [id, `claude-${fam}-${dot}`, `claude ${fam} ${dot}`, `${fam} ${dot}`, ...extra],
  };
}

/**
 * The registry of QUALIFYING (premium) models, exactly as Anthropic ships them.
 * Weight ladder = capability tier, capped at 45: Mythos tier > Opus > Sonnet > Haiku.
 */
export const QUALIFYING_MODELS: ClaudeModelDef[] = [
  def("mythos", 5, 2, 45),
  def("fable", 5, 2, 45),
  def("mythos", 5, 1, 44),
  def("fable", 5, 1, 44),
  def("mythos", 5, null, 43),
  def("fable", 5, null, 43),
  def("opus", 5, 5, 42),
  def("sonnet", 5, 5, 36),
  def("haiku", 5, 5, 28),
];

/**
 * Real models BELOW the threshold. They are recognized (so a repo pinning claude-opus-4-5
 * shows up as "Opus 4.5 — below threshold" instead of noise) but never credited.
 */
const LEGACY_LABELS: Record<string, string> = {
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-5": "Opus 4.5",
  "claude-opus-4-1": "Opus 4.1",
  "claude-opus-4": "Opus 4",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-sonnet-4": "Sonnet 4",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-3-7-sonnet": "Sonnet 3.7",
  "claude-3-5-sonnet": "Sonnet 3.5",
  "claude-3-5-haiku": "Haiku 3.5",
  "claude-3-opus": "Opus 3",
  "claude-3-sonnet": "Sonnet 3",
  "claude-3-haiku": "Haiku 3",
};

/** The known frontier per family — the highest version Anthropic actually ships. */
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
 * The frontier line for QUERY GENERATION — the hunt budget. Only the model at each
 * family's frontier (Mythos 5.2, Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5) generates hunt
 * queries; older registry entries keep their roles in detection and scoring but never steer
 * the budget. When the registry registers a new release the frontier line moves with it.
 */
export function frontierModels(): ClaudeModelDef[] {
  const frontier = realFamilyFrontier();
  return QUALIFYING_MODELS.filter(
    (m) => m.family !== "generic" && m.version >= (frontier[m.family] ?? Infinity)
  );
}

/** Labels for ancient (Claude 1/2 era) models. */
const KNOWN_BLOCKED_LABELS: Record<string, string> = {
  ...LEGACY_LABELS,
  "claude-2": "Claude 2",
  "claude-2-1": "Claude 2.1",
  "claude-2-0": "Claude 2",
  "claude-1": "Claude 1",
  "claude-instant": "Claude Instant",
};

/**
 * True when the id is RESOLVED by the current registry — either a qualifying
 * (premium) model or a real below-threshold one. Used by the frontier radar to
 * drop ledger rows that the old (inverted) registry once filed as "above the
 * lineup" but the current registry now fully knows: opus-4-6/4-7 are real
 * below-threshold models, opus-5-5 IS the frontier. A row like that is not
 * "emerging" anymore — showing it as above-registry would be a lie.
 */
export function isRegistryKnownModelId(id: string): boolean {
  return QUALIFYING_MODELS.some((m) => m.id === id) || id in KNOWN_BLOCKED_LABELS;
}

/**
 * Classification by version against the known lineup:
 *  - Mythos-tier family (fable / mythos): v >= 5 → qualifying (registered weight, else 40
 *    for a version at/under the frontier); above the frontier → UNVERIFIED; v < 5 → UNVERIFIED
 *    (no such model exists).
 *  - opus / sonnet / haiku: >= 5.5 and registered → qualifying; above the frontier →
 *    UNVERIFIED (only the authority-gated radar may promote a real release); below 5.5 →
 *    real but BLOCKED (below threshold).
 *  - generic "claude X": 5.5 <= v < 6 → qualifying at low weight; >= 6 → UNVERIFIED; else blocked.
 *  - unknown family words → UNVERIFIED.
 */
export function classifyVersion(
  v: number,
  family: ModelFamily
): { qualifying: boolean; weight: number; fiction: boolean } {
  if (!Number.isFinite(v)) return { qualifying: false, weight: 0, fiction: false };
  if (FICTION_FAMILIES.has(family)) return { qualifying: false, weight: 0, fiction: true };
  if (family === "generic") {
    if (v >= 6) return { qualifying: false, weight: 0, fiction: true };
    if (v >= MIN_QUALIFYING_VERSION) return { qualifying: true, weight: 8, fiction: false };
    return { qualifying: false, weight: 0, fiction: false };
  }
  const frontier = realFamilyFrontier()[family];
  if (frontier === undefined) return { qualifying: false, weight: 0, fiction: true };
  if (MYTHOS_TIER.has(family)) {
    if (v < 5 || v > frontier) return { qualifying: false, weight: 0, fiction: true };
    const reg = QUALIFYING_MODELS.find((m) => m.family === family && m.version === v);
    return { qualifying: true, weight: reg?.weight ?? 40, fiction: false };
  }
  if (v > frontier) return { qualifying: false, weight: 0, fiction: true };
  if (v < MIN_QUALIFYING_VERSION) return { qualifying: false, weight: 0, fiction: false };
  const reg = QUALIFYING_MODELS.find((m) => m.family === family && m.version === v);
  if (!reg) return { qualifying: false, weight: 0, fiction: false }; // unregistered noise inside the known range
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
 * Three-way separation: qualifying (premium, registered) vs blocked (real but below
 * the 5.5+ threshold) vs fiction (= UNVERIFIED: ahead of the lineup or an unknown family).
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
    blocked.set(id, { id, label, version: v, reason: `${label} is a real model but below the 5.5+ threshold — detected, never credited` });
  };
  const addFiction = (id: string, family: ModelFamily, v: number) => {
    const label = `${buildLabel(family, Math.floor(v), v % 1 ? Number(String(v).split(".")[1]) : null)} (unverified)`;
    fiction.set(id, { id, label, version: v, reason: `"${id}" is not in the verified lineup — zero credit until an Anthropic repo confirms it` });
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
  const re1 = /claude[-_ ]?(opus|sonnet|haiku|fable|mythos)[-_ ]?(\d{1,2})(?!\d)(?:[-_. ,](\d{1,2}))?(?!\d)/gi;
  // claude-3-5-sonnet / claude-3-7-sonnet-20250219 / claude-5-5
  const re2 = /claude[-_ ](\d{1,2})(?!\d)[-_. ](\d{1,2})(?!\d)(?:[-_ ]?(opus|sonnet|haiku|fable|mythos))?/gi;
  // opus 4.5 / opus-4.5 / sonnet-4-5 (also without the claude prefix) — including the decimal comma "opus 4,5"
  const re3 = /\b(opus|sonnet|haiku|fable|mythos)[-_ ]?(\d{1,2})(?!\d)(?:[-_. ,](\d{1,2}))?(?!\d)/gi;
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
 * frontier model ("opus" → Opus 5.5) — that is how Claude Code aliases work.
 * A below-threshold or unverified value ("opus-4-5", "opus-6") returns null: no qualifying model pinned.
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
  // 3) A bare family name → the family's frontier model (how Claude Code aliases work)
  const alias: Record<string, string> = {
    opus: "claude-opus-5-5",
    sonnet: "claude-sonnet-5-5",
    haiku: "claude-haiku-5-5",
    fable: "claude-fable-5-2",
    mythos: "claude-mythos-5-2",
  };
  const bare = v.replace(/^claude-/, "");
  if (alias[bare]) return QUALIFYING_MODELS.find((m) => m.id === alias[bare]) ?? null;
  // 4) Unverified / below-threshold values fall through — they pin no qualifying model
  return null;
}

/**
 * A strict check for a "model" string coming from the filters.
 * Returns true if the string describes NO real qualifying model — either an
 * below-threshold model or an unverified one. Such filters are blocked on the
 * server side too: searching for them wastes the code-search quota.
 */
export function isBlockedModelString(s: string): boolean {
  if (!s) return false;
  // A bare fiction family word ("fable" / "claude-fable") is fiction even without
  // a version — the filter must not send the quota hunting non-models.
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
