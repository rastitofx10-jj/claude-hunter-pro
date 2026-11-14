import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateChimera } from "@/lib/genesis";
import { writeDnaSnapshot } from "@/lib/dna-snapshot";
import { saveDraft } from "@/lib/chimera-draft";
import { emitChimera } from "@/lib/event-bus";
import type { MinedArtifact } from "@/lib/dna-miner";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Chimera creation: AI fusion of DNA from several elite repos + work orders.
 * WO3 (chimera #3 verified-mutation-flywheel): body flag `draft: true` stages the
 * result as a validated DRAFT FILE — nothing live. Publish is a separate explicit
 * call (POST /api/genesis/drafts). Omitting the flag keeps the legacy publish-now
 * behavior so the existing UI flow is untouched.
 */
export async function POST(req: NextRequest) {
  let repos: string[] = [];
  let productContext = "";
  let draft = false;
  try {
    const body = (await req.json()) as { repos?: string[]; productContext?: string; draft?: boolean };
    repos = (body.repos ?? []).map((r) => r.trim()).filter(Boolean).slice(0, 5);
    // Input cap — previously unbounded (mission/route.ts already caps; here there was none).
    productContext = (body.productContext ?? "").trim().slice(0, 2000);
    draft = body.draft === true;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (repos.length === 0) {
    return NextResponse.json({ error: "Select at least one repo from the library" }, { status: 400 });
  }

  try {
    const sources: { repo: string; artifacts: MinedArtifact[] }[] = [];
    for (const repo of repos) {
      const rows = await db.dnaArtifact.findMany({ where: { sourceRepo: repo } });
      if (rows.length === 0) continue;
      sources.push({
        repo,
        artifacts: rows.map((r) => ({
          path: r.path,
          kind: r.kind as MinedArtifact["kind"],
          name: r.name,
          description: r.description,
          content: r.content,
          rawUrl: r.rawUrl,
          size: r.size,
          truncated: false,
        })),
      });
    }
    if (sources.length === 0) {
      return NextResponse.json(
        { error: "No DNA saved for the selected repos — mine at least one repo first" },
        { status: 400 }
      );
    }

    const chimera = await generateChimera(
      sources,
      productContext ||
        "Claude Hunter — a competitive-intelligence system for discovering and analyzing premium Claude projects on GitHub, with an AI synthesis layer. Next.js 16, TypeScript, Prisma, Tailwind."
    );

    // ---- WO3 fork: draft mode stages a validated file, never touches the live library ----
    if (draft) {
      const rec = await saveDraft(chimera);
      emitChimera({ name: chimera.chimeraName, action: "draft", note: `staged as draft ${rec.draftId}` });
      return NextResponse.json({
        staged: true,
        draftId: rec.draftId,
        validation: rec.validation,
        ...chimera,
      });
    }

    const saved = await db.chimera.create({
      data: {
        name: chimera.chimeraName,
        // Previously not saved — and the history faked it from breakthrough
        oneLiner: chimera.oneLiner || null,
        sources: chimera.sources.join(","),
        skillMd: chimera.skillMd,
        principles: JSON.stringify(chimera.principles),
        workOrders: JSON.stringify(chimera.workOrders),
        breakthrough: chimera.breakthrough,
      },
    });

    // A chimera was synthesized and saved — snapshot the library in the background.
    // Fire-and-forget: the synthesis response never waits on (or fails from) snapshot I/O.
    void writeDnaSnapshot().catch((e) => console.error("[dna-snapshot]", e));
    emitChimera({ name: chimera.chimeraName, action: "published", note: `chimera #${saved.id} born live` });

    return NextResponse.json({ id: saved.id, ...chimera });
  } catch (e) {
    console.error("genesis/synthesize failed", e);
    return NextResponse.json({ error: "Chimera creation failed" }, { status: 500 });
  }
}
