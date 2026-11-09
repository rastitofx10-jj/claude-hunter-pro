import { NextRequest, NextResponse } from "next/server";
import { generateRepoIntel, IntelError } from "@/lib/ai-intel";
import type { AnalyzeResponse } from "@/lib/hunter-types";

export const dynamic = "force-dynamic";
// worst-case: 2 attempts × 110s through the serial LLM queue — previously not defined at all
// and in a hosted deployment the function was killed mid-AI-call (genesis sets 120; the same rule here).
export const maxDuration = 120;

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
  if (body.models !== undefined && !Array.isArray(body.models)) {
    return NextResponse.json({ error: "The models field must be an array" }, { status: 400 });
  }
  if (body.evidence !== undefined && !Array.isArray(body.evidence)) {
    return NextResponse.json({ error: "The evidence field must be an array" }, { status: 400 });
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
