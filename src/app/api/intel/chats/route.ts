import { NextRequest, NextResponse } from "next/server";
import { chatIntelStats, ingestAllPending, ingestChat, scanChatFiles, ChatIntelError } from "@/lib/chat-intel";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET /api/intel/chats — the operator's uploaded chats + ingestion state + stats. */
export async function GET() {
  try {
    const [files, stats] = await Promise.all([scanChatFiles(), chatIntelStats()]);
    return NextResponse.json({ files, stats });
  } catch (e) {
    console.error("intel/chats GET failed:", e);
    return NextResponse.json({ error: "Failed to scan the operator chats" }, { status: 500 });
  }
}

/**
 * POST /api/intel/chats
 *   { action: "ingest", fileName } — ingest ONE chat file
 *   { action: "ingest-all" }       — ingest every pending chat (duplicates skipped)
 */
export async function POST(req: NextRequest) {
  let body: { action?: unknown; fileName?: unknown };
  try {
    body = (await req.json()) as { action?: unknown; fileName?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";

  try {
    if (action === "ingest") {
      const fileName = typeof body.fileName === "string" ? body.fileName : "";
      if (!fileName) {
        return NextResponse.json({ error: "fileName is required for action 'ingest'" }, { status: 400 });
      }
      const result = await ingestChat(fileName);
      return NextResponse.json({ ok: true, result });
    }
    if (action === "ingest-all") {
      const result = await ingestAllPending();
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ error: "Action required: ingest | ingest-all" }, { status: 400 });
  } catch (e) {
    if (e instanceof ChatIntelError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("intel/chats POST failed:", e);
    return NextResponse.json({ error: "Failed to launch the chat ingestion" }, { status: 500 });
  }
}
