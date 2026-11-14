import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseSweepRow, startSweep } from "@/lib/sweep-runner";

export const dynamic = "force-dynamic";

/** List of recent sweeps */
export async function GET() {
  try {
    const rows = await db.sweepRun.findMany({ orderBy: { id: "desc" }, take: 20 });
    const items = rows.map((r) => {
      const parsed = parseSweepRow(r);
      return {
        id: parsed.id,
        status: parsed.status,
        phase: parsed.phase,
        progress: parsed.progress,
        stats: parsed.stats,
        error: parsed.error,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };
    });
    const active = items.find((i) => i.status === "running") ?? null;
    return NextResponse.json({ items, active });
  } catch (e) {
    console.error("sweep GET failed", e);
    return NextResponse.json({ error: "Failed to load the sweeps" }, { status: 500 });
  }
}

/** Launch a new deep sweep — returns immediately, the run continues in the background */
export async function POST(req: NextRequest) {
  try {
    const { id } = await startSweep(req);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    if (status < 500) return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to launch the sweep" }, { status });
    console.error("sweep POST failed", e);
    return NextResponse.json({ error: "Failed to launch the sweep" }, { status: 500 });
  }
}
