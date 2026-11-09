import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Single artifact details including the full content — read only on expanded view (on demand) */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  // >0 like all the siblings — previously negative identifiers passed with a 404 instead of a 400
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "Invalid identifier" }, { status: 400 });
  }
  try {
    const row = await db.dnaArtifact.findUnique({ where: { id: numId } });
    if (!row) return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    return NextResponse.json(row);
  } catch (e) {
    console.error("dna-library/[id] GET failed", e);
    return NextResponse.json({ error: "Failed to load the artifact" }, { status: 500 });
  }
}
