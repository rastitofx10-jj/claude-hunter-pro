import { NextRequest, NextResponse } from "next/server";
import { generateBattleSynthesis, IntelError } from "@/lib/ai-intel";
import type { WatchItem } from "@/lib/hunter-types";

export const dynamic = "force-dynamic";
// worst-case: 2 attempts × 110s through the serial LLM queue — previously not defined at all
export const maxDuration = 120;

// POST /api/synthesis — cross-repo battle synthesis from the watchlist
export async function POST(req: NextRequest) {
  let body: { items?: WatchItem[] };
  try {
    body = (await req.json()) as { items?: WatchItem[] };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // round 8: a null body or non-array items ({"items":"abc"}) crashed on `.filter`
  // OUTSIDE the route's try — a raw framework 500 broke the JSON error contract.
  if (!body || !Array.isArray(body.items ?? [])) {
    return NextResponse.json({ error: "items must be an array" }, { status: 400 });
  }

  // Full validation before the prompt: previously non-numeric fields flowed into the prompt as "score undefined/100"
  const items = (body.items ?? []).filter(
    (i) =>
      i &&
      typeof i.fullName === "string" &&
      i.fullName.includes("/") &&
      (i.score === undefined || typeof i.score === "number") &&
      (i.stars === undefined || typeof i.stars === "number")
  );
  if (items.length < 2) {
    return NextResponse.json(
      { error: "Battle synthesis requires at least 2 repos in the watchlist — save more targets and then run it" },
      { status: 400 }
    );
  }
  if (items.length > 20) {
    return NextResponse.json({ error: "Up to 20 repos are allowed per synthesis" }, { status: 400 });
  }

  try {
    const synthesis = await generateBattleSynthesis(items);
    return NextResponse.json(synthesis);
  } catch (e) {
    if (e instanceof IntelError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    console.error("synthesis failed", e);
    return NextResponse.json({ error: "Failed to generate the battle synthesis. Try again." }, { status: 500 });
  }
}
