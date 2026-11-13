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

  // --- Gate 1: substance (0..0.35) ---
  let hardReject = false;
  if (content.length < MIN_GENE_BYTES) {
    hardReject = true;
    reasons.push(`stub: ${content.length}B < ${MIN_GENE_BYTES}B floor`);
  }
  // log-scaled: floor→0, ~8KB→max
  const substance = Math.min(
    1,
    Math.log10(content.length / MIN_GENE_BYTES + 1) / Math.log10(8_000 / MIN_GENE_BYTES + 1)
  );

  // --- Gate 2: structure (0..0.35) ---
  let structure = 0;
  if (a.kind === "mcp-config") {
    if (a.truncated) {
      // Round 9: a config cut at the 12KB mining cap can never parse (the cut
      // is mid-JSON by definition) — grading it "not valid JSON" hard-rejected
      // every real >12KB .mcp.json and two such mines strike-banned the repo.
      // A file that reached the byte cap is real config mass: partial structure
      // credit, and the reason is reported so the transparency survives.
      reasons.push("mcp-config truncated at the mining cap — JSON validity not gradeable");
      structure = 0.5;
    } else {
      try {
        JSON.parse(content);
        structure = 1;
      } catch {
        hardReject = true;
        reasons.push("mcp-config: content is not valid JSON");
      }
    }
  } else {
    const hasFrontmatter = /^---\r?\n[\s\S]*?\r?\n---/.test(content);
    const hasDescription = !!a.description && a.description.trim().length >= 10;
    const hasSections = /^##\s+\S/m.test(content);
    if (hasFrontmatter) structure += 0.4;
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
  const signal = Math.min(1, fences * 0.25 + listItems * 0.04 + numbered * 0.06);

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
  /** Round 9 — artifacts whose download failed (rate limit / 5xx / timeout).
   *  Reported separately from quality rejections: their content is UNKNOWN,
   *  not bad. Callers use this to avoid strike-blaming the repo and to keep the
   *  "stub" KPI honest (a network error was previously counted as a stub). */
  downloadErrors: { path: string; error: string }[];
  /** Average score of the KEPT genes (null when nothing survived) */
  avgScore: number | null;
}

/** Run the whole mined batch through the gate — the single ingestion checkpoint */
export function gateArtifacts(artifacts: MinedArtifact[]): GateResult {
  const kept: MinedArtifact[] = [];
  const rejected: QualityRejection[] = [];
  const downloadErrors: { path: string; error: string }[] = [];
  let scoreSum = 0;
  for (const a of artifacts) {
    if (a.downloadError) {
      // Unknown, not bad — never graded, never a "stub", never a strike.
      downloadErrors.push({ path: a.path, error: a.downloadError });
      continue;
    }
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
    downloadErrors,
    avgScore: kept.length > 0 ? Number((scoreSum / kept.length).toFixed(2)) : null,
  };
}
