// ============================================================
// Quality Gate — chimera #2 "elite-dna-hunter-orchestrator" injection (WO3:
// Quality Validation System). Multi-stage validation of every gene BEFORE it
// enters the library, with a 0..1 score and explicit rejection reasons.
//
// Gates (adapted from the chimera's DNA Validation Criteria):
//  1. Substance   (0..0.35) — content mass beyond the stub floor, log-scaled
//  2. Structure   (0..0.35) — frontmatter / description / ## sections (md),
//                             valid JSON (mcp-config)
//  3. Uniqueness  (0..0.15) — the gene's name is not a generic placeholder
//  4. Signal      (0..0.15) — actionable markers: code fences, lists, steps
//
// Hard rejects regardless of score: stubs (below the byte floor) and
// unparseable mcp-configs — the exact defect classes seen in the field
// (gene #133 entered with 11 bytes; a Go test file entered as mcp-config).
// ============================================================

import type { MinedArtifact } from "./dna-miner";
// round 12 (LOW-9): the frontmatter law is ONE law (skill-md.ts). This was an
// inline copy of the regex — identical behavior today, guaranteed drift tomorrow.
import { hasFrontmatter } from "./skill-md";

export interface GeneQuality {
  /** 0..1 — weighted gate sum */
  score: number;
  verdict: "pass" | "reject";
  /** Human-readable failure reasons (empty on a clean pass) */
  reasons: string[];
}

/** The hard byte floor — a file below this is a stub, not a gene */
export const MIN_GENE_BYTES = 200;

/**
 * Pass threshold. The chimera's aspirational 0.8 proved too aggressive for
 * short-but-real genes (a tight 300B command with perfect structure scores
 * ~0.55); 0.6 keeps every structured gene and rejects stubs/fluff.
 */
export const QUALITY_THRESHOLD = 0.6;

/** Names that carry no capability identity — mining them adds noise, not DNA */
const GENERIC_NAME_RE = /^(readme|index|main|test|tests?|spec|example|sample|template|boilerplate|untitled|new|copy|draft|notes?|todo)$/i;

/** Score one mined artifact against the four gates */
export function scoreGene(a: MinedArtifact): GeneQuality {
  const reasons: string[] = [];
  const content = a.content ?? "";

  // --- round 12 (MEDIUM-5): transport failure is NOT a quality verdict ---
  // A 403/429/5xx on the contents API left content=null and the artifact fell
  // into the stub branch below — "stub: 0B < 200B floor" — a fabricated quality
  // judgment about a file we never saw. Now the true reason is reported and the
  // strike logic upstream can tell "empty repo" from "GitHub refused the call".
  if (a.downloadError) {
    return {
      score: 0,
      verdict: "reject",
      reasons: [`download failed (${a.downloadError}) — transport error, not a stub; no quality verdict on unseen content`],
    };
  }

  // --- Gate 1: substance (0..0.35) ---
  // Manifests and hook configs are small by nature (a real plugin.json is often ~150 B): they get
  // a lower stub floor and a linear substance curve instead of the log curve built for prose.
  const compact = a.kind === "plugin-manifest" || a.kind === "hook-config";
  const floor = compact ? 60 : MIN_GENE_BYTES;
  let hardReject = false;
  if (content.length < floor) {
    hardReject = true;
    reasons.push(`stub: ${content.length}B < ${floor}B floor`);
  }
  // log-scaled: floor→0, ~8KB→max (compact kinds: linear, full marks at 600 B)
  const substance = compact
    ? Math.min(1, content.length / 600)
    : Math.min(1, Math.log10(content.length / MIN_GENE_BYTES + 1) / Math.log10(8_000 / MIN_GENE_BYTES + 1));

  // --- Gate 2: structure (0..0.35) ---
  let structure = 0;
  if (a.kind === "mcp-config" || a.kind === "plugin-manifest" || a.kind === "hook-config") {
    try {
      JSON.parse(content);
      structure = 1;
    } catch {
      hardReject = true;
      reasons.push(`${a.kind}: content is not valid JSON`);
    }
  } else if (a.kind === "skill-ref") {
    // Reference docs carry no frontmatter by design — judge them on sections, not on skill structure.
    structure = /^#{1,3}\s+\S/m.test(content) ? 1 : 0.4;
    if (structure < 1) reasons.push("no headings");
  } else {
    // round 12 (LOW-9): the canonical law from skill-md.ts — requires a TERMINATED
    // block (opener + `---` closer + end/newline), not just any `\n---` substring.
    const front = hasFrontmatter(content);
    const hasDescription = !!a.description && a.description.trim().length >= 10;
    const hasSections = /^##\s+\S/m.test(content);
    if (front) structure += 0.4;
    else reasons.push("no frontmatter");
    if (hasDescription) structure += 0.3;
    else reasons.push("no meaningful description");
    if (hasSections) structure += 0.3;
    else reasons.push("no ## sections");
  }

  // --- Gate 3: uniqueness (0..0.15) ---
  let uniqueness = 0.15;
  const name = (a.name ?? "").trim();
  if (GENERIC_NAME_RE.test(name)) {
    uniqueness = 0;
    reasons.push(`generic name: "${name}"`);
  } else if (name.length < 3) {
    uniqueness = 0.05;
    reasons.push(`suspiciously short name: "${name}"`);
  }

  // --- Gate 4: signal (0..0.15) ---
  const fences = Math.floor((content.match(/```/g) ?? []).length / 2);
  const listItems = (content.match(/^\s*[-*]\s+\S/gm) ?? []).length;
  const numbered = (content.match(/^\s*\d+[.)]\s+\S/gm) ?? []).length;
  let signal = Math.min(1, fences * 0.25 + listItems * 0.04 + numbered * 0.06);
  if (compact) {
    // for JSON contracts the actionable marker is a populated object, not bullet lists
    try {
      const o: unknown = JSON.parse(content);
      const keys = o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o as object).length : 0;
      signal = Math.min(1, keys / 4);
    } catch {
      signal = 0;
    }
  }

  const score = Number(
    (substance * 0.35 + structure * 0.35 + uniqueness + signal * 0.15).toFixed(3)
  );
  const verdict: GeneQuality["verdict"] =
    hardReject || score < QUALITY_THRESHOLD ? "reject" : "pass";
  return { score, verdict, reasons };
}

export interface QualityRejection {
  path: string;
  name: string;
  score: number;
  reasons: string[];
}

export interface GateResult {
  kept: MinedArtifact[];
  rejected: QualityRejection[];
  /** Average score of the KEPT genes (null when nothing survived) */
  avgScore: number | null;
}

/** Run the whole mined batch through the gate — the single ingestion checkpoint */
export function gateArtifacts(artifacts: MinedArtifact[]): GateResult {
  const kept: MinedArtifact[] = [];
  const rejected: QualityRejection[] = [];
  let scoreSum = 0;
  for (const a of artifacts) {
    const q = scoreGene(a);
    if (q.verdict === "pass") {
      kept.push(a);
      scoreSum += q.score;
    } else {
      rejected.push({ path: a.path, name: a.name, score: q.score, reasons: q.reasons });
    }
  }
  return {
    kept,
    rejected,
    avgScore: kept.length > 0 ? Number((scoreSum / kept.length).toFixed(2)) : null,
  };
}
