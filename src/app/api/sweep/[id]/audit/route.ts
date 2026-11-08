import { NextRequest, NextResponse } from "next/server";
import { startAudit } from "@/lib/auditor";

export const dynamic = "force-dynamic";

/** שגר ביקורת אדברסרית על סריקה שהושלמה */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
  }
  try {
    await startAudit(req, numId);
    return NextResponse.json({ ok: true, id: numId });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    if (status < 500) return NextResponse.json({ error: e instanceof Error ? e.message : "שגירת הביקורת נכשלה" }, { status });
    console.error("sweep/[id]/audit POST failed", e);
    return NextResponse.json({ error: "שגירת הביקורת נכשלה" }, { status: 500 });
  }
}
