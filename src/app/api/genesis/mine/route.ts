import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { GhError } from "@/lib/github";
import { mineDna } from "@/lib/dna-miner";
import { captureTokenFrom, resolveToken } from "@/lib/server-token";

export const dynamic = "force-dynamic";

/** Mine DNA from a repo + save it to the library */
export async function POST(req: NextRequest) {
  const token = await resolveToken(req);
  let owner = "";
  let repo = "";
  try {
    const body = (await req.json()) as { owner?: string; repo?: string; fullName?: string };
    if (body.fullName) {
      const [o, r] = body.fullName.split("/");
      owner = (o ?? "").trim();
      repo = (r ?? "").trim();
    } else {
      owner = (body.owner ?? "").trim();
      repo = (body.repo ?? "").trim();
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: "A valid owner/repo is required" }, { status: 400 });
  }

  try {
    const pkg = await mineDna(owner, repo, token);
    // Mining succeeded against GitHub — a valid token from the header is saved for server use
    // (previously: analyze/harvest/rate-limit captured it; here it did not — an inconsistency).
    await captureTokenFrom(req).catch(() => undefined);
    const warnings: string[] = [];
    if (pkg.treeTruncated) {
      warnings.push("The repo's file tree was truncated (very large repo) — only some capability files may have been found");
    }
    if (pkg.artifacts.length === 0) {
      return NextResponse.json({
        ...pkg,
        warnings,
        note: "No Claude capability files (.claude/, CLAUDE.md) found in this repo — the project may not have been built with Claude Code",
      });
    }
    // Save/update in the DNA library
    const fullName = `${owner}/${repo}`;
    for (const a of pkg.artifacts) {
      await db.dnaArtifact.upsert({
        where: { sourceRepo_path: { sourceRepo: fullName, path: a.path } },
        create: {
          sourceRepo: fullName,
          path: a.path,
          kind: a.kind,
          name: a.name,
          description: a.description,
          content: a.content,
          rawUrl: a.rawUrl,
          size: a.size,
        },
        update: {
          kind: a.kind,
          name: a.name,
          description: a.description,
          content: a.content,
          rawUrl: a.rawUrl,
          size: a.size,
        },
      });
    }
    return NextResponse.json({ ...pkg, warnings });
  } catch (e) {
    const msg = e instanceof GhError ? e.message : "Mining failed";
    const status = e instanceof GhError ? e.status : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
