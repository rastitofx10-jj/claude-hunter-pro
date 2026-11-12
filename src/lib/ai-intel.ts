// ============================================================
// AI intelligence engine — Claude Hunter
// Closes the loop: from "finding projects" to "product decisions".
// Runs on the server side only (z-ai-web-dev-sdk is forbidden on the client).
// ============================================================

import { extractJson, isTimeoutError, str, strArr } from "./ai-json";
import { llmComplete } from "./zai";
import type {
  AnalyzeResponse,
  BattleSynthesis,
  BetterMove,
  RepoIntel,
  StealIdea,
  SynthPattern,
  TopMove,
  WatchItem,
} from "./hunter-types";

export class IntelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntelError";
  }
}

const TIMEOUT_MS = 110_000;

const SYSTEM_ROLE = `You are a senior competitive-intelligence analyst on a product team building an innovative AI interface.
Your mission: turn raw GitHub evidence into a practical battle plan, in English.

Iron rules:
1. You are a JSON engine — return valid JSON and nothing beyond it. No code fences, no explanations, no markdown.
2. Every field in English only (technical names like CLAUDE.md / claude-opus-4-5 stay in English inside the text).
3. Never invent facts that are not in the evidence. No evidence for something? Write that no evidence was found, or skip it.
4. Model truth: only REAL Anthropic models count — Opus 4.5 is the strongest model that exists today, Sonnet 4.5 and Haiku 4.5 follow, and older real models (4.1/4/3.x) are worth proportionally less. "Fable", "opus 5.5", "opus 6" and any model above the real 4.5 frontier are FICTIONAL strings hallucinated by others — if the evidence contains them, flag it as hallucination contamination, give ZERO credit, and say so explicitly.
5. Always from the perspective of "what does this give our product" — not an academic review but operational orders.
6. Inside JSON string values, double quotes (") are forbidden — replace them with a single quote (').`;

// ---------- utilities ----------

const EFFORTS = new Set(["low", "medium", "high", "unknown"]);

function stealArr(v: unknown, max = 6): StealIdea[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x): StealIdea | null => {
      if (typeof x === "string") {
        const what = x.trim();
        return what ? { what, why: "", how: undefined } : null;
      }
      const o = (x ?? {}) as Record<string, unknown>;
      const what = str(o.what ?? o.idea ?? o.title);
      if (!what) return null;
      return { what, why: str(o.why ?? o.reason), how: str(o.how ?? o.implementation) || undefined };
    })
    .filter((x): x is StealIdea => !!x)
    .slice(0, max);
}
function betterArr(v: unknown, max = 6): BetterMove[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x): BetterMove | null => {
      const o = (x ?? {}) as Record<string, unknown>;
      const gap = str(o.gap ?? o.weakness ?? o.theyMiss);
      if (!gap) return null;
      return { gap, ourMove: str(o.ourMove ?? o.opportunity ?? o.howWeWin) };
    })
    .filter((x): x is BetterMove => !!x)
    .slice(0, max);
}

function moveArr(v: unknown, max = 7): TopMove[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const move = str(o.move ?? o.action ?? o.title);
      if (!move) return null;
      const eff = str(o.effort, "unknown");
      return { move, why: str(o.why ?? o.reason), effort: (EFFORTS.has(eff) ? eff : "unknown") as TopMove["effort"] };
    })
    .filter((x): x is TopMove => !!x)
    .slice(0, max);
}

function patternArr(v: unknown, max = 6): SynthPattern[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const pattern = str(o.pattern ?? o.title ?? o.theme);
      if (!pattern) return null;
      return { pattern, repos: strArr(o.repos, 12), insight: str(o.insight ?? o.meaning) };
    })
    .filter((x): x is SynthPattern => !!x)
    .slice(0, max);
}

const RETRY_HINT = `\n\n⚠️ Repair retry: your previous response was not valid JSON.
Return the same report again exactly, this time as strict JSON:
- Double quotes (") are forbidden inside string values — single quotes (') only
- No trailing commas before } or ]
- Return the JSON body only, nothing else.`;

async function llmJson(userPrompt: string): Promise<Record<string, unknown>> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // The global queue in zai.ts (concurrency 1 + 429 retry) — see the documentation there
      const { content: raw } = await llmComplete(
        [
          { role: "system", content: SYSTEM_ROLE },
          { role: "user", content: attempt === 0 ? userPrompt : userPrompt + RETRY_HINT },
        ],
        { timeoutMs: TIMEOUT_MS, timeoutLabel: "AI call", timeoutError: IntelError }
      );
      if (!raw.trim()) {
        lastErr = new IntelError("The AI returned an empty response — try again");
        continue;
      }
      return extractJson(raw, IntelError);
    } catch (e) {
      if (isTimeoutError(e)) throw e; // timeout — a retry would waste another 110 seconds
      if (e instanceof IntelError) {
        lastErr = e;
        continue; // parse failure → retry with repair hint
      }
      throw e; // network — no point retrying within same request
    }
  }
  throw lastErr instanceof Error ? lastErr : new IntelError("Report generation failed");
}

// ---------- digest builders ----------

function repoDigest(a: AnalyzeResponse): string {
  const qual = a.models.filter((m) => m.qualifying);
  const blocked = a.models.filter((m) => !m.qualifying);
  return [
    `Repo: ${a.repo.fullName}`,
    `Description: ${a.repo.description ?? "none"}`,
    `Stars: ${a.repo.stars} · forks: ${a.repo.forks} · contributors: ${a.contributors} · primary language: ${a.repo.language ?? "?"}`,
    `Investment score: ${a.score.total}/100 (models ${a.score.modelScore}/45, payment ${a.score.paidScore}/30, traction ${a.score.tractionScore}/25, usage ${a.score.usageScore}/15)`,
    `Meets the 5.5+ threshold: ${a.score.meetsModelThreshold ? "yes" : "no"}`,
    qual.length ? `Qualifying models (5.5+): ${qual.map((m) => `${m.label}${m.hits ? ` [${m.hits} files]` : ""} (sources: ${m.sources.join("/")})`).join("; ")}` : "Qualifying models: none",
    blocked.length ? `Blocked models found (4.x and below, weight 0): ${blocked.map((m) => m.label).join(", ")}` : "",
    a.evidence.length ? `Payment evidence: ${a.evidence.map((e) => e.label).join("; ")}` : "Payment evidence: none",
    a.commands.length ? `Claude Code commands: /${a.commands.join(", /")}` : "",
    a.agents.length ? `Subagents: ${a.agents.join(", ")}` : "",
    a.mcpServers.length ? `MCP servers: ${a.mcpServers.join(", ")}` : "",
    a.mentions.prices.length ? `Price mentions in README: ${a.mentions.prices.join(", ")}` : "",
    a.mentions.tokens.length ? `Token mentions in README: ${a.mentions.tokens.join(", ")}` : "",
    `"Built with Claude" declaration: ${a.mentions.builtWithClaude ? "yes" : "no"}`,
    a.claudeFiles.length ? `Claude files: ${a.claudeFiles.slice(0, 20).map((f) => f.path).join(", ")}` : "Claude files: none",
    a.languages.length ? `Languages: ${a.languages.map((l) => `${l.name} ${l.pct}%`).join(", ")}` : "",
    `README excerpt (up to 1800 chars):\n${(a.readmeExcerpt ?? "").slice(0, 1800) || "none"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- public API ----------

/** An AI intelligence report for a single repo — from an existing analysis result */
export async function generateRepoIntel(a: AnalyzeResponse): Promise<RepoIntel> {
  const prompt = `An evidence package from our automatic scan:

${repoDigest(a)}

Build a competitive-intelligence report for our product (an AI interface). Return JSON exactly in the following structure:
{
  "verdict": "A strategic verdict in 1-2 sentences: whether, and what, is worth learning from this project",
  "moneyVerdict": "A judgment of the depth of investment in tokens and expensive models, with a short rationale based solely on the evidence",
  "moneyLevel": "exactly one: certain | likely | weak | unknown",
  "whatTheyBuilt": ["3-5 facts about what the project does, from the evidence only"],
  "brilliant": ["2-5 brilliant/clever things in their approach, or [] if there are none"],
  "stealThis": [{"what": "what to adopt into our interface", "why": "why it works for them", "how": "how we would implement it on our side, in general terms"}],
  "doBetter": [{"gap": "a real weakness/gap of theirs", "ourMove": "how we win there"}],
  "actionItems": ["3-6 concrete, measurable steps for our next sprint"],
  "riskNotes": ["Caveats: what the evidence does not prove, copy risks, license, etc."]
}
If there is not enough evidence for a field — return an empty array or "unknown"; do not invent.`;

  const j = await llmJson(prompt);
  const level = str(j.moneyLevel, "unknown");
  const levels = ["certain", "likely", "weak", "unknown"] as const;
  return {
    verdict: str(j.verdict, "No verdict received"),
    moneyVerdict: str(j.moneyVerdict),
    moneyLevel: (levels as readonly string[]).includes(level) ? (level as RepoIntel["moneyLevel"]) : "unknown",
    whatTheyBuilt: strArr(j.whatTheyBuilt),
    brilliant: strArr(j.brilliant),
    stealThis: stealArr(j.stealThis),
    doBetter: betterArr(j.doBetter),
    actionItems: strArr(j.actionItems),
    riskNotes: strArr(j.riskNotes),
    generatedAt: new Date().toISOString(),
  };
}

/** Battle synthesis — cross-repo intelligence from the entire watchlist */
export async function generateBattleSynthesis(items: WatchItem[]): Promise<BattleSynthesis> {
  const list = items
    .slice(0, 20)
    .map((w, i) => {
      const models = (w.models ?? "").split(",").filter(Boolean).join(", ") || "none detected";
      let notes = "";
      if (w.evidence) {
        try {
          const ev = JSON.parse(w.evidence) as { label?: string }[];
          if (Array.isArray(ev)) notes = ev.map((e) => e.label).filter(Boolean).slice(0, 4).join("; ");
        } catch {
          // ignore malformed evidence
        }
      }
      return [
        `[${i + 1}] ${w.fullName} — score ${w.score}/100, ⭐${w.stars}`,
        `Description: ${w.description ?? "none"}`,
        `Models detected: ${models}`,
        notes ? `Evidence: ${notes}` : "",
        w.notes ? `Our analyst notes: ${w.notes.slice(0, 400)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n---\n");

  const prompt = `Our watchlist (${items.length} repos identified as paid-Claude projects, model threshold 5.5+):

${list}

Perform a cross-project intelligence synthesis. Do not look at each repo separately — find the connecting thread. Return JSON exactly in the structure:
{
  "execSummary": "A strategic situation picture in 3-4 sentences: where the premium Claude-projects market is heading according to the patterns here",
  "patterns": [{"pattern": "the pattern's name", "repos": ["owner/name of the repos where it appeared"], "insight": "what it means for our product"}],
  "stackConsensus": ["technologies/approaches that repeat across projects"],
  "topMoves": [{"move": "a recommended move for our product", "why": "based on which evidence", "effort": "low | medium | high"}],
  "differentiators": ["3-5 differentiation opportunities — what none of them has done yet"],
  "battlePlan": ["an ordered action plan of 4-7 items, what comes first and why"]
}
If the list is small and insufficient for patterns — be honest about it in execSummary and do not invent patterns.`;

  const j = await llmJson(prompt);
  return {
    execSummary: str(j.execSummary, "No summary received"),
    patterns: patternArr(j.patterns),
    stackConsensus: strArr(j.stackConsensus),
    topMoves: moveArr(j.topMoves),
    differentiators: strArr(j.differentiators),
    battlePlan: strArr(j.battlePlan),
    generatedAt: new Date().toISOString(),
  };
}
