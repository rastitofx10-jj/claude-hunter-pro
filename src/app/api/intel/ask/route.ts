import { NextRequest, NextResponse } from "next/server";
import { askHunter, ChatIntelError } from "@/lib/chat-intel";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/intel/ask — the sharp answer organ. Grounded in the DNA library
 * (mined genes + field genes + operator-chat genes), answers in the language
 * of the question.
 */
export async function POST(req: NextRequest) {
  let body: { question?: unknown };
  try {
    body = (await req.json()) as { question?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question : "";
  if (!question.trim()) {
    return NextResponse.json({ error: "A question is required" }, { status: 400 });
  }
  try {
    const result = await askHunter(question);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ChatIntelError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("intel/ask POST failed:", e);
    return NextResponse.json({ error: "Failed to produce the answer" }, { status: 500 });
  }
}
