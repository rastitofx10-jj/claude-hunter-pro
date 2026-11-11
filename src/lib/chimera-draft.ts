// ============================================================
// Chimera draft store + batch validation — chimera #3 (verified-mutation-
// flywheel) WO3 live injection: "Draft → Validate → Publish".
//
// WHY: until now POST /api/genesis/synthesize wrote the new chimera straight
// into the library (db.chimera.create). Nothing live existed between
// "the LLM finished generating" and "the library mutated". WO3 stages every
// mutation as a DRAFT FILE (reports/state/chimera-drafts/) — nothing live.
// Batch validation runs ALL gates in one pass and reports every failure at
// once (never one-at-a-time). Publishing requires an explicit second call
// that re-validates; undo is delete-draft. Faithful to the parent DNA:
//   - spotify/ads-agentic-tools build-campaign: draft → validate → publish,
//     batch validation, easy undo
//   - itz4blitz/agentful validation: stack-agnostic quality gates
//   - InvestSkill Bear Case: every figure carries its evidence
// Server-side only.
// ============================================================

import { db } from "./db";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
// type-only — erased at compile time, no runtime cycle with genesis
import type { WorkOrder } from "./genesis";

const DRAFT_DIR = path.join(process.cwd(), "reports", "state", "chimera-drafts");

/** A principle / work-order entry — the generator emits strings or {title, spec} objects.
 *  WorkOrder (genesis) is named explicitly: an interface without an index signature
 *  is not assignable to Record<string, unknown> — a known TS strictness rule that
 *  previously broke the draft path's typecheck (ChimeraResult → ChimeraCandidate). */
export type PrincipleOrOrder = string | WorkOrder | Record<string, unknown>;

/** The chimera shape produced by generateChimera (src/lib/genesis.ts) */
export type ChimeraCandidate = {
  chimeraName: string;
  oneLiner?: string | null;
  sources: string[];
  principles: PrincipleOrOrder[];
  workOrders: PrincipleOrOrder[];
  breakthrough?: string | null;
  skillMd: string;
};

export type DraftRecord = ChimeraCandidate & {
  draftId: string;
  createdAt: string;
  validation: ValidationResult;
};

export type GateResult = { gate: string; ok: boolean; detail: string };
export type ValidationResult = {
  passed: boolean;
  checkedAt: string;
  gates: GateResult[];
};

/** Flatten a principle/work-order entry to its substance length, shape-agnostic */
function substanceLen(p: unknown): number {
  if (typeof p === "string") return p.trim().length;
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    return String(o.headline ?? o.title ?? "").trim().length + String(o.detail ?? o.spec ?? o.description ?? "").trim().length;
  }
  return 0;
}

// ------------------------------------------------------------
// The batch validator — all gates, one pass, every failure reported
// ------------------------------------------------------------
export async function validateChimeraCandidate(c: ChimeraCandidate): Promise<ValidationResult> {
  const gates: GateResult[] = [];

  // G1 — identity: non-empty unique name
  const nameOk = typeof c.chimeraName === "string" && c.chimeraName.trim().length >= 3;
  let nameDetail = `name="${c.chimeraName}"`;
  if (nameOk) {
    const clash = await db.chimera.findFirst({ where: { name: c.chimeraName } });
    if (clash) {
      gates.push({ gate: "G1-identity", ok: false, detail: `${nameDetail} — COLLIDES with chimera #${clash.id}` });
    } else {
      gates.push({ gate: "G1-identity", ok: true, detail: nameDetail });
    }
  } else {
    gates.push({ gate: "G1-identity", ok: false, detail: `${nameDetail} — too short/empty` });
  }

  // G2 — provenance: ≥2 distinct sources, each with mined DNA in the library
  const distinct = [...new Set((c.sources ?? []).map((s) => s.trim()).filter(Boolean))];
  if (distinct.length >= 2) {
    const withDna: string[] = [];
    for (const repo of distinct) {
      const n = await db.dnaArtifact.count({ where: { sourceRepo: repo } });
      if (n > 0) withDna.push(repo);
    }
    gates.push({
      gate: "G2-provenance",
      ok: withDna.length === distinct.length,
      detail: `${withDna.length}/${distinct.length} sources have mined DNA (${distinct.join(", ")})`,
    });
  } else {
    gates.push({ gate: "G2-provenance", ok: false, detail: `only ${distinct.length} distinct source(s) — need ≥2` });
  }

  // G3 — principles: ≥3, each substantive. The generator emits two shapes
  // (plain strings, or {headline, detail} objects) — the gate measures
  // SUBSTANCE, not shape: string ≥30 chars, or headline+detail with body.
  const pr = (c.principles ?? []).filter((p) => substanceLen(p) >= 30);
  gates.push({
    gate: "G3-principles",
    ok: pr.length >= 3,
    detail: `${pr.length}/${(c.principles ?? []).length} principles with substance`,
  });

  // G4 — work orders: ≥3 actionable orders (title ≥5 + spec ≥40, or string ≥20)
  const wo = (c.workOrders ?? []).filter((w) => {
    if (typeof w === "string") return w.trim().length >= 20;
    const o = w as { title?: unknown; spec?: unknown; detail?: unknown };
    const title = String(o.title ?? "").trim();
    const spec = String(o.spec ?? o.detail ?? "").trim();
    return title.length >= 5 && spec.length >= 40;
  });
  gates.push({
    gate: "G4-work-orders",
    ok: wo.length >= 3,
    detail: `${wo.length}/${(c.workOrders ?? []).length} work orders with actionable substance`,
  });

  // G5 — skill body: frontmatter + length, no placeholder junk
  const md = c.skillMd ?? "";
  const hasFront = /^---\n[\s\S]*?\n---/.test(md);
  const noJunk = !/(TODO|XXX|FIXME|【|undefined)/.test(md);
  gates.push({
    gate: "G5-skill-md",
    ok: md.length >= 800 && hasFront && noJunk,
    detail: `${md.length} chars, frontmatter=${hasFront}, placeholders=${!noJunk}`,
  });

  // G6 — breakthrough: the idea that exists nowhere else, stated with substance
  const bt = (c.breakthrough ?? "").trim();
  gates.push({
    gate: "G6-breakthrough",
    ok: bt.length >= 40,
    detail: `${bt.length} chars: "${bt.slice(0, 60)}…"`,
  });

  return { passed: gates.every((g) => g.ok), checkedAt: new Date().toISOString(), gates };
}

// ------------------------------------------------------------
// Draft file store — atomic writes, same tmp+rename discipline as snapshots
// ------------------------------------------------------------
function draftPath(draftId: string) {
  return path.join(DRAFT_DIR, `${draftId}.json`);
}

export async function saveDraft(c: ChimeraCandidate): Promise<DraftRecord> {
  const validation = await validateChimeraCandidate(c);
  const rec: DraftRecord = {
    draftId: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    chimeraName: c.chimeraName,
    oneLiner: c.oneLiner ?? null,
    sources: c.sources,
    principles: c.principles,
    workOrders: c.workOrders,
    breakthrough: c.breakthrough ?? null,
    skillMd: c.skillMd,
    validation,
  };
  await mkdir(DRAFT_DIR, { recursive: true });
  const tmp = draftPath(rec.draftId) + ".tmp";
  await writeFile(tmp, JSON.stringify(rec, null, 1), "utf8");
  await rename(tmp, draftPath(rec.draftId));
  return rec;
}

export async function listDrafts(): Promise<DraftRecord[]> {
  try {
    const files = (await readdir(DRAFT_DIR)).filter((f) => f.endsWith(".json"));
    const drafts = await Promise.all(
      files.map(async (f) => JSON.parse(await readFile(path.join(DRAFT_DIR, f), "utf8")) as DraftRecord)
    );
    return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function getDraft(draftId: string): Promise<DraftRecord | null> {
  try {
    return JSON.parse(await readFile(draftPath(draftId), "utf8")) as DraftRecord;
  } catch {
    return null;
  }
}

/** Undo path — delete-draft. Nothing live ever existed. */
export async function deleteDraft(draftId: string): Promise<boolean> {
  try {
    await rm(draftPath(draftId));
    return true;
  } catch {
    return false;
  }
}

/** Publish: re-validate (batch, all gates, fresh) then create the live row. */
export async function publishDraft(draftId: string): Promise<
  { ok: true; id: number; validation: ValidationResult } | { ok: false; error: string; validation?: ValidationResult }
> {
  const draft = await getDraft(draftId);
  if (!draft) return { ok: false, error: `draft ${draftId} not found` };

  // batch re-validation — the ratchet: the same gates, checked again NOW
  const validation = await validateChimeraCandidate(draft);
  if (!validation.passed) {
    return { ok: false, error: "re-validation failed — draft stale or invalid", validation };
  }

  const saved = await db.chimera.create({
    data: {
      name: draft.chimeraName,
      oneLiner: draft.oneLiner ?? null,
      sources: draft.sources.join(","),
      skillMd: draft.skillMd,
      principles: JSON.stringify(draft.principles),
      workOrders: JSON.stringify(draft.workOrders),
      breakthrough: draft.breakthrough ?? null,
    },
  });
  await deleteDraft(draftId);
  return { ok: true, id: saved.id, validation };
}
