import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** History of created chimeras.
 * Returns exactly the same shape as POST /api/genesis/synthesize
 * (chimeraName/oneLiner/generatedAt) — previously: different fields (name/createdAt) and the UI
 * showed empty titles and downloaded genesis-undefined.md when clicking in the history. */
export async function GET() {
  try {
    const rows = await db.chimera.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
    return NextResponse.json({
      items: rows.map((r) => ({
        id: r.id,
        // The field names the UI expects (ChimeraResponse)
        chimeraName: r.name,
        // The real value saved at creation; breakthrough only as a fallback for old rows
        // (previously: oneLiner was faked from breakthrough — the title the AI wrote was lost).
        oneLiner: r.oneLiner ?? r.breakthrough ?? "",
        skillMd: r.skillMd,
        principles: safeArr(r.principles),
        workOrders: safeArr(r.workOrders),
        breakthrough: r.breakthrough,
        sources: r.sources.split(",").filter(Boolean),
        generatedAt: r.createdAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    console.error("[genesis:chimeras]", e);
    return NextResponse.json({ error: "Failed to load the chimeras" }, { status: 500 });
  }
}

function safeArr(s: string | null): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
