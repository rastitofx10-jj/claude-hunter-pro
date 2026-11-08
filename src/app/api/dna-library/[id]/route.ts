import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** פירוט ארטיפקט בודד כולל התוכן המלא — נקרא רק בעת הצגה מורחבת (on demand) */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  // >0 כמו בכל האחים — בעבר אישר מזהים שליליים ב-404 במקום 400
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
  }
  try {
    const row = await db.dnaArtifact.findUnique({ where: { id: numId } });
    if (!row) return NextResponse.json({ error: "הארטיפקט לא נמצא" }, { status: 404 });
    return NextResponse.json(row);
  } catch (e) {
    console.error("dna-library/[id] GET failed", e);
    return NextResponse.json({ error: "טעינת הארטיפקט נכשלה" }, { status: 500 });
  }
}
