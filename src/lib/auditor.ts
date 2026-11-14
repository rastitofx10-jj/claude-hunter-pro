// ============================================================
// Adversarial audit module — the system audits itself ruthlessly.
// Stage A (deterministic, live): for every leading elite finding — a code search
//   in the repo itself with the claimed evidence string. 0 files = hidden
//   evidence. This exposes exactly the falsehoods of the type
//   "mentioned in the description, absent from the code".
// Stage B (LLM anti-slop): a critical prompt that receives the briefing +
//   Stage A results and must locate unsupported claims, generic slop,
//   and invented numbers.
// The result is saved on the sweep-run row itself — no excuses possible,
//   only fixes.
// Server-side only.
// ============================================================

import { db } from "./db";
import { extractJson, safeJsonParse, str, strArr } from "./ai-json";
import { llmComplete } from "./llm";
import { ghFetch, ghFetchRaw, ghSearchWithBackoff, GhError } from "./github";
import { QUALIFYING_MODELS } from "./claude-models";
import { resolveToken } from "./server-token";
import type { NextRequest } from "next/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- types ----------

export interface EvidenceCheck {
  fullName: string;
  claimed: string;
  filesFound: number;
  verified: boolean;
  /** Ground truth: the exact file in which the string was found */
  proofFile?: string;
  error?: string;
}

export interface SlopFlag {
  claim: string;
  why: string;
}

export interface AuditResult {
  status: "running" | "done" | "failed";
  stage: string;
  evidenceChecks: EvidenceCheck[];
  precision: number; // percentage of verified evidence out of those conclusively checked
  specificityScore: number; // 0-100 anti-slop
  slopFlags: SlopFlag[];
  refutedClaims: SlopFlag[];
  verdict: string;
  llmCalls: number;
  error?: string;
  auditedAt?: string;
}

interface FindingLike {
  fullName: string;
  stars: number;
  verdict: string | null;
  evidence: string;
  contentEvidence?: string[];
  textEvidence?: string[];
  investment?: number | null;
  signature?: string | null;
}

const AUDIT_TOP_N = 10;

const AUDITOR_ROLE = `You are a hostile internal (red-team) reviewer in an intelligence unit. Your job is to expose slop, fabrications, and bloat — but only where they truly exist.
Iron rules:
1. JSON engine only — no code fences, no text outside the JSON.
2. English. Double quotes (") are forbidden inside string values — use a single quote (').
3. Evidence-based suspicion: a refutation must quote the exact claim and point at the contradicting datum from the data in front of you. If there is no real contradiction — return an empty array. It is absolutely forbidden to invent refutations, strings that never appeared (such as undefined), or contradictions when everything is verified.
4. A lawful distinction: the investment score (inv) and moneyLevel are marked professional estimates produced by the system — not facts. Do not flag them as fabrications. A fabrication = a concrete fact (star count, date, file name, quote, size) that does not appear in the data.
5. Defined system terminology is not slop: hard evidence = a REAL model string (e.g. claude-opus-4-5) verified inside real file content, usually with an attached path. Do not flag the term itself.
6. Real slop = a generic sentence that fits any AI project without an identifying detail, or a number/fact that does not exist in the data.`;

async function llmJson(prompt: string): Promise<Record<string, unknown>> {
  // The global queue (llm.ts) — bounded concurrency + retry with backoff; a real "system" role
  const { content: raw } = await llmComplete(
    [
      { role: "system", content: AUDITOR_ROLE },
      { role: "user", content: prompt },
    ],
    { timeoutMs: 300_000, timeoutLabel: "AI audit" , tier: "deep", effort: "high", maxTokens: 16_000 }
  );
  if (!raw.trim()) throw new Error("The AI returned an empty response");
  return extractJson(raw, Error);
}

// ---------- Stage A: live evidence verification ----------

/** Ground truth: fetch the raw file and grep for the strings. It used to receive only the
 * strings of the last claim — when the claims were two different models, the file was
 * grepped with the second model's strings and could fail falsely
 * ("refuted" even though the evidence was real).
 * round 8: a transport failure (403 rate-limit on the contents API, timeout, 5xx) was
 * swallowed into `return null` — the check then landed in `refuted` (verified:false,
 * NO error field) and was fed to the anti-slop LLM as "ground truth that cannot be
 * disputed": a legitimate repo's evidence got permanently marked refuted for a
 * failure of the auditor's own network call. Now only a 404/422 (file gone) or a
 * clean miss refutes; everything else THROWS and the caller records check.error. */
async function grepRawFile(
  fullName: string,
  path: string,
  needles: string[],
  token: string | null
): Promise<string | null> {
  let content: string;
  try {
    content = await ghFetchRaw(
      `/repos/${fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
      token
    );
  } catch (e) {
    const status = e instanceof GhError ? e.status : 0;
    if (status === 404 || status === 422) return null; // file deleted/renamed — a clean miss
    throw e; // 403/429/5xx/network — an API error is not a refutation
  }
  const lower = content.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n)) return path;
  }
  return null;
}

/** Live verification: is the evidence string actually in the repo's files? (Definition: code search matches file content) */
export async function verifyEvidenceLive(
  findings: FindingLike[],
  token: string | null,
  onProgress?: (done: number, total: number, check: EvidenceCheck) => Promise<void> | void
): Promise<EvidenceCheck[]> {
  const targets = findings.filter((f) => f.verdict === "elite").slice(0, AUDIT_TOP_N);
  const checks: EvidenceCheck[] = [];
  for (let i = 0; i < targets.length; i++) {
    const f = targets[i] as FindingLike & { evidencePaths?: string[] };
    const claimed = (f.contentEvidence && f.contentEvidence.length > 0 ? f.contentEvidence[0] : null) ?? null;
    if (!claimed) {
      const check: EvidenceCheck = { fullName: f.fullName, claimed: "(no content evidence)", filesFound: 0, verified: false };
      checks.push(check);
      await onProgress?.(i + 1, targets.length, check);
      continue;
    }
    let check: EvidenceCheck;
    try {
      // We verify up to 2 claimed strings per repo — not just the first one
      const claims = (f.contentEvidence ?? []).slice(0, 2);
      let filesFound = 0;
      let verifiedAny = false;
      for (const claim of claims) {
        const resp = await ghSearchWithBackoff<{ total_count: number }>(
          `/search/code?q=${encodeURIComponent(`${claim} repo:${f.fullName}`)}&per_page=1`,
          token
        );
        filesFound += resp.total_count ?? 0;
        if ((resp.total_count ?? 0) > 0) verifiedAny = true;
        // Code search quota = 10/minute — 6.5s between verification queries (the previous 2.1s
        // burned the quota and caused 403s on the follow-up queries — elite evidence was
        // falsely rejected)
        await sleep(6_500);
      }
      check = { fullName: f.fullName, claimed: claims.join(" + "), filesFound, verified: verifiedAny };
      // Ground truth: if the index misses (0 files) — a direct grep of the file discovered
      // during the scan. The grep uses the union of all claims' strings — previously only
      // the last claim's (searching model B's strings in a file discovered via model A → a
      // false refutation).
      if (!check.verified) {
        const unionNeedles = claims.flatMap((c) =>
          (QUALIFYING_MODELS.find((m) => m.id === c)?.searchStrings ?? [c]).map((s) => s.toLowerCase())
        );
        const paths = f.evidencePaths ?? [];
        for (const p of paths) {
          const proof = await grepRawFile(f.fullName, p, unionNeedles, token);
          if (proof) {
            check = { fullName: f.fullName, claimed: claims.join(" + "), filesFound: 1, verified: true, proofFile: proof };
            break;
          }
        }
      }
      // round 8 note: grepRawFile now THROWS on transport errors — the catch below marks
      // the check with error ("technical failure", not refuted) instead of letting a
      // rate-limited contents-API call silently refute real evidence.
    } catch (e) {
      check = {
        fullName: f.fullName,
        claimed,
        filesFound: 0,
        verified: false,
        error: e instanceof Error ? e.message : "Verification error",
      };
    }
    checks.push(check);
    await onProgress?.(i + 1, targets.length, check);
    await sleep(6_500); // code search quota pacing (10 per minute)
  }
  return checks;
}

// ---------- Stage B: anti-slop ----------

function parseFlags(v: unknown, max = 8): SlopFlag[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x): SlopFlag | null => {
      if (typeof x === "string") return { claim: x.slice(0, 300), why: "" };
      const o = (x ?? {}) as Record<string, unknown>;
      const claim = str(o.claim ?? o.statement ?? o.quote);
      if (!claim) return null;
      return { claim: claim.slice(0, 300), why: str(o.why ?? o.reason).slice(0, 300) };
    })
    .filter((x): x is SlopFlag => !!x)
    .slice(0, max);
}

export async function antiSlopAudit(
  briefing: Record<string, unknown> | null,
  checks: EvidenceCheck[],
  findings: FindingLike[]
): Promise<{ specificityScore: number; slopFlags: SlopFlag[]; refutedClaims: SlopFlag[]; verdict: string }> {
  // A lawful separation: an API error is not a refutation. Previously a "refuted" row was
  // counted even when verification failed technically (rate limit/network) — and it was
  // fed to the LLM as ground truth that the evidence was false, dragging precision down
  // for a failure of the system, not of the finding.
  const errored = checks.filter((c) => !!c.error);
  const refuted = checks.filter((c) => !c.verified && !c.error);
  const briefSample = JSON.stringify(briefing ?? {}).slice(0, 4500);
  const refutedList = refuted.length
    ? refuted.map((r) => `— ${r.fullName}: claimed "${r.claimed}" but 0 files in the repo contain it`).join("\n")
    : "(no evidence was refuted in the deterministic stage)";
  const erroredList = errored.length
    ? errored.map((r) => `— ${r.fullName}: claim "${r.claimed}" — verification failed technically (${r.error})`).join("\n")
    : "";
  const topFindings = findings
    .slice(0, 10)
    .map((f) => `— ${f.fullName}: inv=${f.investment ?? "?"} signature: ${(f.signature ?? "").slice(0, 120)}`)
    .join("\n");

  const prompt = `Anti-slop audit of an intelligence briefing generated by the system.

1) Live verification results (deterministic) for the elite evidence — the ground truth that cannot be disputed:
${checks.map((c) => `— ${c.fullName}: claimed "${c.claimed}" → ${c.filesFound} files found ${c.error ? "⚠️ not checked (verification error — do not interpret as a refutation!)" : c.verified ? `✓ verified${c.proofFile ? ` (proof file: ${c.proofFile})` : ""}` : "✗ refuted"}`).join("\n")}

2) Refuted evidence (0 files — ground truth):
${refutedList}

2b) Evidence with no conclusion drawn (API error — no information; do not interpret as either refutation or verification):
${erroredList || "(none)"}

3) The top findings as reported:
${topFindings}

4) The briefing under audit (excerpt):
${briefSample}

Audit zealously but honestly:
a. Claims in the briefing that contradict the live verification — only if there is a literal contradiction between a quoted claim and a quoted datum.
b. Concrete numbers/facts that do not appear in the data (fabrications) — not estimates marked as such, like inv.
c. Generic slop — a sentence that fits any report without an identifying detail.
If there are no real problems in a category — return an empty array. Do not invent.
Return exactly this JSON:
{"specificityScore": 0-100, "slopFlags": [{"claim": "...", "why": "..."}], "refutedClaims": [{"claim": "...", "why": "..."}], "verdict": "2-3 sentences: how trustworthy the report is and what must be fixed"}`;

  const j = await llmJson(prompt);
  const score = Number(j.specificityScore ?? j.score ?? 50);
  return {
    specificityScore: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 50,
    slopFlags: parseFlags(j.slopFlags),
    refutedClaims: parseFlags(j.refutedClaims),
    verdict: str(j.verdict, "No audit verdict received"),
  };
}

// ---------- running a full audit ----------

const activeAudits = new Set<number>();

/** Reaping stuck audits: a "running" audit that has not been updated beyond this = the
 * server died mid-run. Previously: a lock stuck forever — the button disabled and every
 * retry returned 409 forever. */
const STALE_AUDIT_MS = 15 * 60_000;

async function writeAudit(id: number, audit: AuditResult): Promise<void> {
  try {
    await db.sweepRun.update({ where: { id }, data: { audit: JSON.stringify(audit) } });
  } catch {
    // the run was deleted
  }
}

async function executeAudit(runId: number, token: string | null): Promise<void> {
  activeAudits.add(runId);
  try {
    const row = await db.sweepRun.findUnique({ where: { id: runId } });
    if (!row) throw new Error("Sweep run not found");
    const findings = safeJsonParse<FindingLike[]>(row.findings, []);
    if (findings.length === 0) throw new Error("No findings to audit — the run did not complete");
    const briefing = safeJsonParse<Record<string, unknown> | null>(row.briefing, null);

    // Stage A
    await writeAudit(runId, {
      status: "running", stage: "evidence", evidenceChecks: [], precision: 0,
      specificityScore: 0, slopFlags: [], refutedClaims: [], verdict: "", llmCalls: 0,
    });
    const checks = await verifyEvidenceLive(findings, token);
    // Precision = verified out of only the conclusively checked — API errors are not
    // counted in the denominator (previously they were, lowering precision for a failure
    // of the system, not of the finding)
    const conclusive = checks.filter((c) => !c.error);
    const verifiedCount = conclusive.filter((c) => c.verified).length;
    const precision = conclusive.length ? Math.round((verifiedCount / conclusive.length) * 100) : 0;

    // Stage B
    await writeAudit(runId, {
      status: "running", stage: "antislop", evidenceChecks: checks, precision,
      specificityScore: 0, slopFlags: [], refutedClaims: [], verdict: "", llmCalls: 0,
    });
    const slop = await antiSlopAudit(briefing, checks, findings);

    const result: AuditResult = {
      status: "done",
      stage: "done",
      evidenceChecks: checks,
      precision,
      specificityScore: slop.specificityScore,
      slopFlags: slop.slopFlags,
      refutedClaims: slop.refutedClaims,
      verdict: slop.verdict,
      llmCalls: 1,
      auditedAt: new Date().toISOString(),
    };
    await writeAudit(runId, result);
  } catch (e) {
    await writeAudit(runId, {
      status: "failed",
      stage: "failed",
      evidenceChecks: [],
      precision: 0,
      specificityScore: 0,
      slopFlags: [],
      refutedClaims: [],
      verdict: "",
      llmCalls: 0,
      error: e instanceof Error ? e.message : "Audit error",
    });
  } finally {
    activeAudits.delete(runId);
  }
}

/** Start an audit in the background */
export async function startAudit(req: NextRequest, runId: number): Promise<void> {
  // The lock is truly taken before any await — previously the first findUnique ran before
  // the lock check, leaving a millisecond window where two parallel POSTs both passed
  // (a double audit).
  if (activeAudits.has(runId)) {
    const err = new Error("An audit is already running for this sweep run");
    (err as Error & { status?: number }).status = 409;
    throw err;
  }
  activeAudits.add(runId);
  try {
    const row = await db.sweepRun.findUnique({ where: { id: runId }, select: { id: true, audit: true, updatedAt: true } });
    if (!row) {
      const err = new Error("Sweep run not found");
      (err as Error & { status?: number }).status = 404;
      throw err;
    }
    const running = safeJsonParse<{ status?: string }>(row.audit, {});
    if (running.status === "running") {
      // Reaping: running without an update for > 15 minutes = the server died mid-audit —
      // previously this was a lock stuck forever (409 forever, button disabled).
      const ageMs = row.updatedAt ? Date.now() - new Date(row.updatedAt).getTime() : Infinity;
      if (ageMs < STALE_AUDIT_MS) {
        const err = new Error("An audit is already running for this sweep run");
        (err as Error & { status?: number }).status = 409;
        throw err;
      }
      await writeAudit(runId, {
        status: "failed",
        stage: "failed",
        evidenceChecks: [],
        precision: 0,
        specificityScore: 0,
        slopFlags: [],
        refutedClaims: [],
        verdict: "",
        llmCalls: 0,
        error: "The audit was interrupted (the server was restarted) — automatically marked",
      });
    }
    const token = await resolveToken(req);
    void executeAudit(runId, token);
  } catch (e) {
    activeAudits.delete(runId); // early failure — release the lock
    throw e;
  }
}

export function parseAudit(raw: string | null): AuditResult | null {
  return safeJsonParse<AuditResult | null>(raw, null);
}
