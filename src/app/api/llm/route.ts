import { NextResponse } from "next/server";
import { llmConfigured, llmStats, llmTransport, modelForTier, type LlmTier } from "@/lib/llm";

export const dynamic = "force-dynamic";

/**
 * GET /api/llm — Claude layer status. Never calls the API (costs nothing): reports whether
 * a key is configured, the active transport, the model per tier, and this process's
 * usage/cost counters.
 */
export async function GET() {
  const tiers: LlmTier[] = ["frontier", "deep", "balanced", "fast"];
  const configured = llmConfigured();
  return NextResponse.json({
    configured,
    transport: llmTransport(),
    models: Object.fromEntries(tiers.map((t) => [t, modelForTier(t)])),
    concurrency: Number(process.env.HUNTER_LLM_CONCURRENCY) || 4,
    stats: llmStats(),
    hint: configured
      ? null
      : "No ANTHROPIC_API_KEY set — calls are served by the hosted gateway fallback (tier/effort knobs are prompt-level intent there; reported model is the gateway marker, never an unverified Claude id). Set ANTHROPIC_API_KEY in .env for the direct Claude API tier ladder.",
  });
}
