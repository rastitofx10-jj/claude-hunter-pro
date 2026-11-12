import { NextResponse } from "next/server";
import { loadFrontierLedger } from "@/lib/emerging-models";
import { QUALIFYING_MODELS } from "@/lib/claude-models";

export const dynamic = "force-dynamic";

/** The frontier radar — what the ledger knows about versions ABOVE the registry.
 *  Confirmed entries (≥2 repos) are live waves the arsenal is already hunting. */
export async function GET() {
  try {
    const ledger = await loadFrontierLedger();
    const registered = QUALIFYING_MODELS.filter((m) => m.id !== `claude-${m.family}`).length;
    return NextResponse.json({
      entries: ledger
        .sort((a, b) => b.mentions - a.mentions)
        .map((e) => ({
          id: e.id,
          label: e.label,
          kind: e.kind,
          confirmed: e.confirmed,
          repos: e.repos.length,
          repoNames: e.repos.slice(0, 5),
          mentions: e.mentions,
          firstSeen: e.firstSeen,
          lastSeen: e.lastSeen,
          samplePaths: e.samplePaths.slice(0, 2),
        })),
      registeredModels: registered,
    });
  } catch (e) {
    console.error("frontier GET failed", e);
    return NextResponse.json({ error: "Failed to load the frontier ledger" }, { status: 500 });
  }
}
