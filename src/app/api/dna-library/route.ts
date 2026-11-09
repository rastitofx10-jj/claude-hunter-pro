import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The DNA library — grouped by repo.
 * Light default: no full content (we saw 692KB JSON on every tab open) —
 * contentPreview for display + size for sorting. Full content: ?full=1 or /api/dna-library/[id].
 */
const PREVIEW_CHARS = 400;

/**
 * The default mode (without full) — previously: findMany with full content from the DB
 * and then content=null with preview inflation on the server side — megabytes transferred from SQLite
 * just to be thrown away. Now: substr inside the SQL — only the 400 characters leave the process.
 */
async function listLight() {
  const rows = await db.$queryRaw<{
    id: number;
    sourceRepo: string;
    path: string;
    kind: string;
    name: string;
    description: string | null;
    rawUrl: string | null;
    size: number;
    contentPreview: string | null;
    contentLength: number;
  }[]>`
    SELECT id, sourceRepo, path, kind, name, description, rawUrl, size,
           substr(content, 1, ${PREVIEW_CHARS}) AS contentPreview,
           length(content) AS contentLength
    FROM DnaArtifact
    ORDER BY sourceRepo ASC, kind ASC, name ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    sourceRepo: r.sourceRepo,
    path: r.path,
    kind: r.kind,
    name: r.name,
    description: r.description,
    rawUrl: r.rawUrl,
    size: r.size,
    content: null,
    contentPreview: r.contentPreview ?? "",
    hasContent: (r.contentLength ?? 0) > 0,
  }));
}

export async function GET(req: NextRequest) {
  const full = req.nextUrl.searchParams.get("full") === "1";
  try {
    if (!full) {
      const items = await listLight();
      return NextResponse.json({ items, full: false });
    }
    // Explicit take — previously full=1 returned the entire library unbounded
    const rows = await db.dnaArtifact.findMany({
      orderBy: [{ sourceRepo: "asc" }, { kind: "asc" }, { name: "asc" }],
      take: 400,
    });
    return NextResponse.json({ items: rows, full: true });
  } catch (e) {
    console.error("dna-library GET failed", e);
    return NextResponse.json({ error: "Failed to load the DNA library" }, { status: 500 });
  }
}

/**
 * Deletion: ?repo=owner/name for a single repo, or ?all=1 for the entire library.
 * Previously: deletion without a parameter = delete everything, and an empty ?repo= leaked there too — an
 * irreversible typo (a data disaster waiting to happen). Now: every action must be explicit.
 */
export async function DELETE(req: NextRequest) {
  const repo = (req.nextUrl.searchParams.get("repo") ?? "").trim();
  const all = req.nextUrl.searchParams.get("all") === "1";
  if (!repo && !all) {
    return NextResponse.json(
      { error: "An explicit ?repo=owner/name or ?all=1 is required — deletion without a clear instruction is blocked" },
      { status: 400 }
    );
  }
  try {
    await db.dnaArtifact.deleteMany(repo ? { where: { sourceRepo: repo } } : undefined);
    return NextResponse.json({ ok: true, scope: repo || "all" });
  } catch (e) {
    console.error("dna-library DELETE failed", e);
    return NextResponse.json({ error: "Deletion failed" }, { status: 500 });
  }
}
