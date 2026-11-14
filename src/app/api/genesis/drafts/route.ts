import { NextRequest, NextResponse } from "next/server";
import { deleteDraft, listDrafts, publishDraft } from "@/lib/chimera-draft";
import { emitChimera } from "@/lib/event-bus";

export const dynamic = "force-dynamic";

/**
 * Draft chimeras — WO3 of chimera #3 (verified-mutation-flywheel).
 * GET                 → list staged drafts with their validation reports
 * POST  {draftId}     → explicit publish: re-validate all gates, then go live
 * DELETE ?draftId=…   → undo: delete the draft (nothing live ever existed)
 */
export async function GET() {
  const drafts = await listDrafts();
  return NextResponse.json({
    count: drafts.length,
    items: drafts.map((d) => ({
      draftId: d.draftId,
      chimeraName: d.chimeraName,
      oneLiner: d.oneLiner,
      sources: d.sources,
      createdAt: d.createdAt,
      validation: d.validation,
    })),
  });
}

export async function POST(req: NextRequest) {
  let draftId = "";
  try {
    const body = (await req.json()) as { draftId?: string };
    draftId = (body.draftId ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!draftId) return NextResponse.json({ error: "draftId required" }, { status: 400 });

  // round 8: publishDraft performs unguarded DB reads + create — any Prisma error
  // escaped the handler as a non-JSON framework 500. Same contract as every other
  // route: clean JSON errors only.
  try {
    const res = await publishDraft(draftId);
    if (!res.ok) {
      return NextResponse.json({ error: res.error, validation: res.validation }, { status: 409 });
    }
    emitChimera({ name: draftId, action: "published", note: `draft ${draftId} published as chimera #${res.id}` });
    return NextResponse.json({ ok: true, id: res.id, published: draftId, validation: res.validation, draftCleanupFailed: res.draftCleanupFailed ?? false });
  } catch (e) {
    console.error("[genesis/drafts publish]", e);
    return NextResponse.json({ error: "Draft publish failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const draftId = (new URL(req.url).searchParams.get("draftId") ?? "").trim();
  if (!draftId) return NextResponse.json({ error: "draftId required" }, { status: 400 });
  // round 8: ok:false was returned with HTTP 200 — apiFetch saw no `error` field and
  // the UI silently "succeeded" at deleting nothing. Now: 404 with a real error.
  const ok = await deleteDraft(draftId);
  if (!ok) return NextResponse.json({ error: "draft not found or already deleted" }, { status: 404 });
  return NextResponse.json({ ok, deleted: draftId });
}
