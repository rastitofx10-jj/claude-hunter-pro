import { NextResponse } from "next/server";
import { loadFrontierLedger } from "@/lib/emerging-models";
import { QUALIFYING_MODELS, isRegistryKnownModelId } from "@/lib/claude-models";

export const dynamic = "force-dynamic";

/** The frontier radar — what the ledger knows about versions ABOVE the real
 *  registry. Confirmed entries are AUTHORITY-VERIFIED waves (org:anthropics hit)
 *  the arsenal is already hunting; vouched-but-unverified entries steer nothing;
 *  fiction entries are contamination records, excluded from the wave feed.
 *  Round 11 — post-inversion hygiene: ledger rows filed by the OLD (inverted)
 *  registry as "above the lineup" (opus-4-6, opus-4-7, opus-5-5…) are now
 *  fully RESOLVED by the current registry — 5.5 IS the frontier, 4.6/4.7 are
 *  real below-threshold models. Such rows are filtered at read time so the
 *  radar only ever shows what is genuinely ABOVE the current lineup. */
export async function GET() {
  try {
    const ledger = await loadFrontierLedger();
    const registered = QUALIFYING_MODELS.length;
    return NextResponse.json({
      entries: ledger
        .filter((e) => e.kind !== "fiction")
        .filter((e) => !isRegistryKnownModelId(e.id))
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
