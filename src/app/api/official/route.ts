import { NextRequest, NextResponse } from "next/server";
import { discoverOfficialRepos, harvestOfficial, OFFICIAL_ORGS } from "@/lib/anthropic-sources";
import { GhError } from "@/lib/github";
import { captureTokenFrom, resolveToken } from "@/lib/server-token";
import { writeDnaSnapshot } from "@/lib/dna-snapshot";
import { emitDnaBorn } from "@/lib/event-bus";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

let running = false;

const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** GET /api/official — preview: the ranked official repos (two GitHub calls, nothing is mined). */
export async function GET(req: NextRequest) {
  try {
    const token = await resolveToken(req);
    const { repos, failures } = await discoverOfficialRepos(token);
    return NextResponse.json({ orgs: OFFICIAL_ORGS, repos: repos.slice(0, 30), failures });
  } catch (e) {
    console.error("[official:get]", e);
    if (e instanceof GhError && e.rateLimited === true) {
      return NextResponse.json({ error: "GitHub API quota exhausted — try again in a minute." }, { status: 429 });
    }
    return NextResponse.json({ error: "Official-source discovery failed — details in the server log" }, { status: 500 });
  }
}

/** POST /api/official { maxRepos?, orgs?, remine? } — folder-mode harvest of Anthropic's public orgs. */
export async function POST(req: NextRequest) {
  if (running) return NextResponse.json({ error: "An official-source harvest is already running" }, { status: 409 });
  running = true;
  let maxRepos = 5;
  let orgs: string[] | undefined;
  let remine = false;
  try {
    const body = (await req.json()) as { maxRepos?: unknown; orgs?: unknown; remine?: unknown };
    if (typeof body.maxRepos === "number") maxRepos = Math.max(1, Math.min(10, Math.floor(body.maxRepos)));
    if (Array.isArray(body.orgs)) {
      orgs = body.orgs.filter((o): o is string => typeof o === "string" && ORG_RE.test(o)).slice(0, 5);
    }
    remine = body.remine === true;
  } catch {
    // empty body — defaults
  }
  try {
    const token = await resolveToken(req);
    const result = await harvestOfficial(token, { maxRepos, orgs, remine });
    for (const rep of result.reposMined) {
      if (rep.newCount > 0) emitDnaBorn({ name: `${rep.repo} +${rep.newCount}`, source: rep.repo, origin: "mined", note: "official source" });
    }
    void writeDnaSnapshot().catch((e) => console.error("[dna-snapshot]", e));
    await captureTokenFrom(req);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[official:post]", e);
    if (e instanceof GhError && e.rateLimited === true) {
      return NextResponse.json({ error: "GitHub API quota exhausted — the harvest stopped. Try again in a minute." }, { status: 429 });
    }
    return NextResponse.json({ error: "The official-source harvest failed — details in the server log" }, { status: 500 });
  } finally {
    running = false;
  }
}
