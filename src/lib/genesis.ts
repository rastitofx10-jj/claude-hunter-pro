// ============================================================
// Genesis engine — the top loop: from raw DNA to a creation ready for execution.
// Takes real artifacts from elite repos and produces:
// 1. A chimera — a merged best-of-breed SKILL.md ready for injection into .claude/skills
// 2. Concrete work orders for our product (work orders for Claude)
// 3. One breakthrough idea — the next "crazy" thing to build
// Runs on the server side only.
// ============================================================

import type { MinedArtifact } from "./dna-miner";
import { extractJson, isTimeoutError, sanitizeSlug, str, strArr } from "./ai-json";
import { llmComplete } from "./zai";
import { detectClaudeModels } from "./claude-models";
import { db } from "./db";

export class GenesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenesisError";
  }
}

export interface WorkOrder {
  title: string;
  spec: string;
  claudePrompt: string;
  effort: string;
}

export interface ChimeraResult {
  chimeraName: string;
  oneLiner: string;
  skillMd: string;
  principles: string[];
  workOrders: WorkOrder[];
  breakthrough: string;
  sources: string[];
  generatedAt: string;
  /** Set when the synthesis still carried fictional/unconfirmed model strings after
   *  a feedback retry — the skillMd then ends with a self-documenting truth notice. */
  truthNotice?: string;
}

const TIMEOUT_MS = 110_000;

// ---------- post-birth model-truth gate (born 2026-11-13, after chimera #5) ----------
// Field fact: chimera #5 was synthesized with a routing block that routed work to
// "Fable 5.1" (fiction) and "Sonnet 5.5" (single-source unconfirmed signal). The
// synthesis prompt now forbids it in advance — this gate verifies it after birth:
// scan the output; on contamination, ONE feedback retry; if still contaminated, the
// record carries its own retraction (truth notice appended to skillMd).

/** Fiction ids the radar has authority-confirmed as REAL waves (org:anthropics hit) —
 *  those may be referenced as pending adoption; they are not contamination. */
async function authorityConfirmedWaveIds(): Promise<Set<string>> {
  try {
    const row = await db.setting.findUnique({ where: { key: "frontierLedger" } });
    if (!row) return new Set();
    const entries = JSON.parse(row.value) as Array<{ id?: string; confirmed?: boolean }>;
    if (!Array.isArray(entries)) return new Set();
    return new Set(entries.filter((e) => e?.confirmed && typeof e.id === "string").map((e) => e.id as string));
  } catch {
    return new Set(); // a unreadable ledger never widens the contamination filter
  }
}

/** Scan every output field for fictional/unconfirmed model strings.
 *  Returns the offending ids (fiction minus authority-confirmed waves). */
function scanChimeraContamination(text: string, confirmedWaves: Set<string>): string[] {
  const det = detectClaudeModels(text);
  return det.fiction.map((f) => f.id).filter((id) => !confirmedWaves.has(id));
}

/** The self-documenting retraction appended when retries did not clean the output. */
function modelTruthNotice(ids: string[]): string {
  return `\n\n---\n\n## MODEL TRUTH NOTICE (post-birth gate)\n\nThe synthesis above contained references to fictional or unconfirmed model ids:\n${ids.map((id) => `- \`${id}\` — not a real available model (fiction or unconfirmed single-source signal)`).join("\n")}\n\nPer the real-model gate: only REAL Anthropic models may be routed to — Opus 4.5 is the strongest that exists today; Sonnet 4.5 and Haiku 4.5 are real; the 4.x family is the real premium tier. Treat every routing line above that names a listed id as if it named the real registry ladder instead. The radar (org:anthropics authority) is the only path by which a wave above 4.5 becomes adoptable — day-one, automatically.\n`;
}

const GENESIS_ROLE = `You are a supreme AI-capabilities architect (Skills Architect) on an elite team.
Your mission: take real DNA — SKILL.md files, commands, agents, and CLAUDE.md — mined from the world's most expensive and successful Claude projects,
and merge it into a single superior creation (a chimera) that will be upgraded into our .claude/skills, and produce precise work orders for our product.

Iron rules:
1. You are a JSON engine — return valid JSON and nothing beyond it. No code fences, no explanations.
2. Every field in English, including the skillMd body, which is written in technical English (it is a file Claude Code will read).
3. Never invent content that is not derived from the provided DNA — but improving, unifying, and sharpening existing patterns is allowed and encouraged.
4. skillMd must be a complete, valid SKILL.md file: frontmatter with name and description, followed by operative instructions.
5. Inside JSON string values, double quotes (") are forbidden — use a single quote (') only.
   Inside skillMd you may use markdown quotes (""" or backticks) — be careful with direct double quotes.`;

const EFFORTS = new Set(["minutes", "hour", "day", "week"]);
function workOrderArr(v: unknown, max = 6): WorkOrder[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const title = str(o.title ?? o.name);
      if (!title) return null;
      const eff = str(o.effort, "hour");
      return {
        title,
        spec: str(o.spec ?? o.description),
        claudePrompt: str(o.claudePrompt ?? o.prompt ?? o.instructions),
        effort: (EFFORTS.has(eff) ? eff : "hour") as WorkOrder["effort"],
      };
    })
    .filter((x): x is WorkOrder => !!x)
    .slice(0, max);
}

/** Builds the AI's DNA ration: limits the content per artifact to keep the context reasonable */
function dnaDigest(sources: { repo: string; artifacts: MinedArtifact[] }[]): string {
  return sources
    .map(({ repo, artifacts }) => {
      const body = artifacts
        .slice(0, 8)
        .map((a) => {
          const head = `### ${a.kind}: ${a.name} (${a.path})${a.description ? `\nDescription: ${a.description}` : ""}`;
          const content = (a.content ?? "").slice(0, 3500);
          return `${head}\n\`\`\`\n${content}\n\`\`\``;
        })
        .join("\n\n");
      return `════ Source repo: ${repo} ════\n${body}`;
    })
    .join("\n\n");
}

/**
 * Creates the chimera: merging DNA from several elite repos into one superior creation + work orders.
 */
export async function generateChimera(
  sources: { repo: string; artifacts: MinedArtifact[] }[],
  productContext: string
): Promise<ChimeraResult> {
  const digest = dnaDigest(sources);
  const repoList = sources.map((s) => s.repo).join(", ");
  const confirmedWaves = await authorityConfirmedWaveIds();

  const prompt = `The mined DNA (real capability files, real-model truth gate):

${digest}

Our product context: ${productContext}

MODEL TRUTH GATE (hard constraint, verified post-birth): only REAL Anthropic models may
appear in skillMd / workOrders / principles. Opus 4.5 is the strongest model that exists
today; Sonnet 4.5 and Haiku 4.5 are real; the 4.x family is the real premium tier. Frontier
waves above 4.5 (e.g. Opus 4.6/4.7/5.5) may be referenced ONLY as pending org:anthropics
authority confirmation — never as an available model. Fictional or unconfirmed names that
appear in the source DNA (Fable, Fable 5.1, Sonnet 5.5, claude 5/6/7) must NEVER be routed
to, recommended, or implied to exist — if the DNA routes work to them, translate that
routing onto the real registry ladder instead. Field fact: chimera #5 was born (2026-11-13)
with a Fable-5.1 routing block and had to be surgically patched — this clause exists so
no chimera is ever born contaminated again.

Perform the supreme merge. Return JSON exactly in the following structure:
{
  "chimeraName": "An English kebab-case name for the merged creation, e.g. elite-parallel-orchestrator",
  "oneLiner": "One sentence in English: what the chimera does and why it is superior to each source individually",
  "skillMd": "A complete SKILL.md file in English: frontmatter (name, description) + merged operative instructions from all the sources — the best of all of them, phrased in a uniform, sharp way. Minimum 40 lines of practical content.",
  "principles": ["4-7 design principles extracted from the DNA that hold true across projects"],
  "workOrders": [{"title": "what to build in our product", "spec": "a short, sharp spec", "claudePrompt": "a prompt ready to paste into Claude Code to execute this on our codebase", "effort": "minutes | hour | day | week"}],
  "breakthrough": "The single most breakthrough idea that can be inferred from this DNA — what we should build that none of the sources has done yet, and why it gives superiority"
}
Return 3-5 work orders, sorted by value to the product.`;

  let lastErr: unknown = null;
  let truthFeedback = ""; // set when a valid-JSON response carried fiction — the next attempt gets it
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // The global queue (zai.ts) — concurrency 1 + 429 retry. The chimera is
      // the heaviest AI call in the system (a large DNA digest) — without the queue,
      // any other concurrent call would knock it over with a 429.
      const { content: raw } = await llmComplete(
        [
          { role: "system", content: GENESIS_ROLE },
          {
            role: "user",
            content:
              prompt +
              (attempt === 0
                ? ""
                : truthFeedback
                  ? `\n\n⚠️ MODEL TRUTH GATE REJECT — your previous response (valid JSON) still contained these fictional/unconfirmed model ids: ${truthFeedback}. Rewrite skillMd/principles/workOrders so every model reference uses the real registry ladder (Opus 4.5 strongest, Sonnet 4.5, Haiku 4.5). Return the full corrected JSON only.`
                  : "\n\n⚠️ The previous response was not valid JSON — fix double quotes and trailing commas and return JSON only."),
          },
        ],
        { timeoutMs: TIMEOUT_MS, timeoutLabel: "Chimera generation", timeoutError: GenesisError }
      );
      if (!raw.trim()) {
        lastErr = new GenesisError("The AI returned an empty response");
        continue;
      }
      const j = extractJson(raw, GenesisError);
      const skillMd = str(j.skillMd);
      if (!skillMd) {
        lastErr = new GenesisError("The AI did not return skillMd");
        continue;
      }
      // post-birth truth scan over EVERY output field (not just skillMd — the
      // contamination in chimera #5 sat in a routing block, but workOrders carry
      // claudePrompt strings too)
      const wholeOutput = JSON.stringify([j.skillMd, j.oneLiner, j.principles, j.workOrders, j.breakthrough]);
      const contamination = scanChimeraContamination(wholeOutput, confirmedWaves);
      if (contamination.length > 0 && attempt < 2) {
        truthFeedback = contamination.join(", ");
        lastErr = new GenesisError(`Model-truth gate: fictional/unconfirmed ids in output (${contamination.join(", ")})`);
        continue; // one feedback retry with the offending ids quoted
      }
      const truthNotice = contamination.length > 0 ? modelTruthNotice(contamination) : undefined;
      return {
        chimeraName: sanitizeSlug(j.chimeraName, "elite-chimera"),
        oneLiner: str(j.oneLiner),
        skillMd: truthNotice ? skillMd + truthNotice : skillMd,
        principles: strArr(j.principles),
        workOrders: workOrderArr(j.workOrders),
        breakthrough: str(j.breakthrough),
        sources: sources.map((s) => s.repo),
        generatedAt: new Date().toISOString(),
        truthNotice: truthNotice ? `fictional/unconfirmed ids retained after retry: ${contamination.join(", ")} — retraction appended to skillMd` : undefined,
      };
    } catch (e) {
      if (isTimeoutError(e)) throw e; // timeout — no retry (up to 110 seconds per attempt)
      if (e instanceof GenesisError) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new GenesisError("Chimera generation failed");
}

/** Builds a full injection bundle (.claude bundle) for download */
export function buildInjectBundle(r: ChimeraResult): string {
  const files: string[] = [];
  files.push(`# 🧬 Genesis Inject Bundle — ${r.chimeraName}`);
  files.push(`> Generated by Claude Hunter · Sources: ${r.sources.join(", ")} · ${new Date(r.generatedAt).toLocaleString("en-US")}`);
  files.push(`\n## Installation\n\nCopy the following file to:\n\`.claude/skills/${r.chimeraName}/SKILL.md\`\n`);
  files.push(`## .claude/skills/${r.chimeraName}/SKILL.md\n\n\`\`\`markdown\n${r.skillMd}\n\`\`\``);
  if (r.principles.length) {
    files.push(`## Extracted principles\n\n${r.principles.map((p) => `- ${p}`).join("\n")}`);
  }
  if (r.workOrders.length) {
    files.push(
      `## Work orders for our product\n\n${r.workOrders
        .map((w, i) => `### ${i + 1}. ${w.title} (effort: ${w.effort})\n**Spec:** ${w.spec}\n\n**Claude Code prompt:**\n\`\`\`\n${w.claudePrompt}\n\`\`\``)
        .join("\n\n")}`
    );
  }
  if (r.breakthrough) {
    files.push(`## 🚀 The next breakthrough\n\n${r.breakthrough}`);
  }
  return files.join("\n\n---\n\n");
}
