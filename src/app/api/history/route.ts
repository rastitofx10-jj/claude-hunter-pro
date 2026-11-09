import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isPrismaNotFound } from "@/lib/ai-json";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await db.searchHistory.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    return NextResponse.json({ items });
  } catch (e) {
    console.error("history GET failed", e);
    return NextResponse.json({ error: "Failed to load the history" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (id === "all") {
      await db.searchHistory.deleteMany({});
      return NextResponse.json({ ok: true });
    }
    const num = Number(id);
    if (!Number.isFinite(num) || num <= 0) {
      return NextResponse.json({ error: "A valid id or id=all is required" }, { status: 400 });
    }
    await db.searchHistory.delete({ where: { id: num } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // P2025 → 404; anything else → 500 with a log (previously: a false catch-all 400).
    if (isPrismaNotFound(e)) {
      return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    }
    console.error("history DELETE failed", e);
    return NextResponse.json({ error: "Deletion failed" }, { status: 500 });
  }
}
