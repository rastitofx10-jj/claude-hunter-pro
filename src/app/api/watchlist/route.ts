import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isPrismaNotFound } from "@/lib/ai-json";

export const dynamic = "force-dynamic";

interface WatchBody {
  fullName: string;
  owner: string;
  name: string;
  url: string;
  description?: string | null;
  stars?: number;
  score?: number;
  models?: string | null;
  evidence?: string | null;
  notes?: string | null;
}

// Input limits — previously uncapped: long unbounded strings entered the DB and this was a
// potential corruption point (a large payload from the client permanently in the DB).
const MAX_TEXT = 1000;
const cap = (v: string | null | undefined, max = MAX_TEXT): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

export async function GET() {
  try {
    const items = await db.savedRepo.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    return NextResponse.json({ items });
  } catch (e) {
    console.error("watchlist GET failed", e);
    return NextResponse.json({ error: "Failed to load the list" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as WatchBody;
    if (!b.fullName || !b.owner || !b.name || !b.url) {
      return NextResponse.json({ error: "Required fields are missing (fullName/owner/name/url)" }, { status: 400 });
    }
    // Basic URL validation — it is rendered as an <a href> in the UI; previously any value was accepted.
    if (!/^https:\/\/github\.com\//.test(b.url)) {
      return NextResponse.json({ error: "url must be a github.com link (https)" }, { status: 400 });
    }
    const safe: WatchBody = {
      ...b,
      fullName: b.fullName.slice(0, 200),
      owner: b.owner.slice(0, 120),
      name: b.name.slice(0, 200),
      url: b.url.slice(0, 500),
    };
    // A truly selective update: a field that was not sent — is not overwritten. And also: an explicit null value
    // does not delete existing data — previously the client sent models: null (search flow) and silently deleted
    // models saved from the analysis. Only a real value (non-empty/non-null) updates.
    const item = await db.savedRepo.upsert({
      where: { fullName: safe.fullName },
      update: {
        ...(safe.stars !== undefined ? { stars: safe.stars ?? 0 } : {}),
        ...(safe.score !== undefined ? { score: safe.score ?? 0 } : {}),
        ...(cap(safe.description) !== null ? { description: cap(safe.description) } : {}),
        ...(cap(safe.models, 300) !== null ? { models: cap(safe.models, 300) } : {}),
        ...(cap(safe.evidence) !== null ? { evidence: cap(safe.evidence) } : {}),
        ...(cap(safe.notes) !== null ? { notes: cap(safe.notes) } : {}),
      },
      create: {
        fullName: safe.fullName,
        owner: safe.owner,
        name: safe.name,
        url: safe.url,
        description: cap(safe.description),
        stars: safe.stars ?? 0,
        score: safe.score ?? 0,
        models: cap(safe.models, 300),
        evidence: cap(safe.evidence),
        notes: cap(safe.notes),
      },
    });
    return NextResponse.json({ item });
  } catch (e) {
    console.error("watchlist POST failed", e);
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = Number(req.nextUrl.searchParams.get("id"));
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ error: "A valid id is required" }, { status: 400 });
    }
    await db.savedRepo.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // P2025 = entry not found → a real 404. Anything else = 500 with a log — previously every error
    // was returned as a false 400 and without a log.
    if (isPrismaNotFound(e)) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    console.error("watchlist DELETE failed", e);
    return NextResponse.json({ error: "Deletion failed" }, { status: 500 });
  }
}
