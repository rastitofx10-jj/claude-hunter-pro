import { NextRequest, NextResponse } from "next/server";
import { harvest } from "@/lib/harvester";
import { GhError } from "@/lib/github";
import { captureTokenFrom, resolveToken } from "@/lib/server-token";
import { writeDnaSnapshot } from "@/lib/dna-snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Harvest lock: a harvest is a long pipeline (up to 300 seconds) — two parallel POSTs
 * would double the quota burn and concurrently mine the same repos (previously: no lock at all) */
let harvestRunning = false;

/** Autonomous harvest: discover elite real-model repos ← mine DNA ← the library explodes */
export async function POST(req: NextRequest) {
  if (harvestRunning) {
    return NextResponse.json({ error: "A harvest is already running — wait for it to finish" }, { status: 409 });
  }
  harvestRunning = true;
  let maxRepos = 6;
  try {
    const body = (await req.json()) as { maxRepos?: unknown };
    if (typeof body.maxRepos === "number") {
      maxRepos = Math.max(1, Math.min(10, Math.floor(body.maxRepos)));
    }
  } catch {
    // An empty body is allowed — default 6
  }

  try {
    const token = await resolveToken(req);
    const result = await harvest(token, maxRepos);
    // The harvest just upserted artifacts into the library — snapshot it automatically in the
    // background (the manual script required a human to remember). Fire-and-forget: the response
    // never waits on (or fails from) snapshot I/O.
    void writeDnaSnapshot().catch((e) => console.error("[dna-snapshot]", e));
    await captureTokenFrom(req);
    return NextResponse.json(result);
  } catch (e) {
    // (Previously: a raw e.message leaked to the client)
    console.error("[harvest]", e);
    // GitHub quota exhausted — a precise 429 instead of a misleading generic 500 ("try again" does not help)
    if (e instanceof GhError && e.rateLimited === true) {
      return NextResponse.json(
        { error: "GitHub API quota exhausted — the harvest stopped. Try again in a minute." },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: "The autonomous harvest failed — details in the server log" }, { status: 500 });
  } finally {
    harvestRunning = false;
  }
}
