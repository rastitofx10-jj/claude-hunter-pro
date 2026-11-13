import { NextRequest, NextResponse } from "next/server";
import { generateRepoIntel, IntelError } from "@/lib/ai-intel";
import type { AnalyzeResponse } from "@/lib/hunter-types";

export const dynamic = "force-dynamic";
// worst-case: 2 attempts × 110s through the serial LLM queue — previously not defined at all
// and in a hosted deployment the function was killed mid-AI-call (genesis sets 120; the same rule here).
export const maxDuration = 300; // round 9: 120 did not cover the real worst case (2 attempts × 110s + queue wait) — the route was killed mid-run and the payload lost wholesale

// POST /api/intel — AI intelligence report for an already-completed analysis result
export async function POST(req: NextRequest) {
  let body: AnalyzeResponse;
  try {
    body = (await req.json()) as AnalyzeResponse;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body?.repo?.fullName || typeof body?.score?.total !== "number") {
    return NextResponse.json(
      { error: "A valid analysis result is required — analyze the repo first and then run the intelligence report" },
      { status: 400 }
    );
  }
  // Prompt protection: a body without valid models/evidence flowed "undefined" into the prompt
  // and caused a generic 500 inside generateRepoIntel (previously: the prompt received "undefined/100" etc.)
  // round 8: only PRESENT-and-wrong fields were rejected — a body that simply OMITTED
  // models/evidence passed both checks and still crashed deep in repoDigest
  // (a.models.filter on undefined) with a misleading "the AI failed" 500.
  // Presence is now required: this route accepts analysis RESULTS, which always carry both.
  if (!Array.isArray(body.models)) {
    return NextResponse.json({ error: "The models field must be an array" }, { status: 400 });
  }
  if (!Array.isArray(body.evidence)) {
    return NextResponse.json({ error: "The evidence field must be an array" }, { status: 400 });
  }
  // Round 9 — the same presence discipline for the fields repoDigest dereferences
  // without guards (a.mentions.prices, a.commands, a.agents, a.mcpServers,
  // a.claudeFiles, a.languages): an omitting body crashed deep inside
  // generateRepoIntel with the same misleading "the AI failed" 500. An analysis
  // result always carries them; anything else is a caller contract violation.
  const structFields: [keyof AnalyzeResponse, string][] = [
    ["commands", "commands"],
    ["agents", "agents"],
    ["mcpServers", "mcpServers"],
    ["claudeFiles", "claudeFiles"],
    ["languages", "languages"],
  ];
  for (const [k, label] of structFields) {
    if (!Array.isArray(body[k])) {
      return NextResponse.json({ error: `The ${label} field must be an array` }, { status: 400 });
    }
  }
  if (!body.mentions || typeof body.mentions !== "object" || Array.isArray(body.mentions)) {
    return NextResponse.json({ error: "The mentions field must be an object" }, { status: 400 });
  }

  try {
    const intel = await generateRepoIntel(body);
    return NextResponse.json(intel);
  } catch (e) {
    if (e instanceof IntelError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    console.error("intel failed", e);
    return NextResponse.json({ error: "Failed to generate the intelligence report. Try again." }, { status: 500 });
  }
}
