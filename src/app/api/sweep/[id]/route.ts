import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseSweepRow } from "@/lib/sweep-runner";
import { isPrismaNotFound } from "@/lib/ai-json";

export const dynamic = "force-dynamic";

/** פרטי סריקה מלאים — יעד הפולינג של ה-UI */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
  }
  try {
    const row = await db.sweepRun.findUnique({ where: { id: numId } });
    if (!row) return NextResponse.json({ error: "הסריקה לא נמצאה" }, { status: 404 });
    return NextResponse.json(parseSweepRow(row));
  } catch (e) {
    console.error("sweep/[id] GET failed", e);
    return NextResponse.json({ error: "טעינת הסריקה נכשלה" }, { status: 500 });
  }
}

/** מחיקת סריקה מההיסטוריה */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
  }
  try {
    await db.sweepRun.delete({ where: { id: numId } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isPrismaNotFound(e)) {
      return NextResponse.json({ error: "הסריקה לא נמצאה" }, { status: 404 });
    }
    console.error("sweep/[id] DELETE failed", e);
    return NextResponse.json({ error: "המחיקה נכשלה" }, { status: 500 });
  }
}
