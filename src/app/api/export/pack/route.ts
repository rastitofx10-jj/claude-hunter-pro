import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Full export bundle — the "DNA Codex":
 * all the genes from the elite + the genes born from the field + the chimeras, in a single Markdown file
 * ready for injection into any project (.claude/skills + CLAUDE.md addendum).
 */
export async function GET() {
  try {
    // round 8 honesty fix: the old `findMany({ take: 600 })` under SQLite BINARY
    // collation silently included only the 98 alphabetically-first repos — 1152/1752
    // genes dropped, **every single field: gene (the evolutionary loop) excluded**, while
    // the header still claimed "(N born from the field)" for genes not in the file.
    // Now: field genes are ALWAYS included unconditionally (they are few and they are
    // the product of the whole system), mined genes stay capped, and the header + stats
    // say exactly what is included vs omitted. No more silent truncation.
    const EXPORT_TAKE = 600;
    const [fieldArtifacts, minedArtifacts, chimeras, totalGenes, fieldCount] = await Promise.all([
      db.dnaArtifact.findMany({
        where: { sourceRepo: { startsWith: "field:" } },
        orderBy: [{ sourceRepo: "asc" }, { path: "asc" }],
      }),
      db.dnaArtifact.findMany({
        where: { NOT: { sourceRepo: { startsWith: "field:" } } },
        orderBy: [{ sourceRepo: "asc" }, { path: "asc" }],
        take: EXPORT_TAKE,
      }),
      db.chimera.findMany({ orderBy: { id: "desc" }, take: 10 }),
      db.dnaArtifact.count(),
      db.dnaArtifact.count({ where: { sourceRepo: { startsWith: "field:" } } }),
    ]);
    const artifacts = [...fieldArtifacts, ...minedArtifacts];
    const omitted = Math.max(0, totalGenes - artifacts.length);

    if (artifacts.length === 0) {
      return NextResponse.json({ error: "The library is empty — there is nothing to export. Run a harvest or mining first." }, { status: 400 });
    }

    const L: string[] = [];
    L.push(`# 🧬 Claude Hunter — DNA Codex`);
    L.push(
      `> Auto-generated · ${new Date().toLocaleString("he-IL")} · ${artifacts.length} of ${totalGenes} genes from ${new Set(artifacts.map((a) => a.sourceRepo)).size} sources (${fieldCount} born from the field${
        omitted > 0 ? `, ${omitted} mined genes omitted — export cap ${EXPORT_TAKE}, field genes always included` : " — complete library"
      }) · real-model truth gate`
    );
    L.push(
      `\n## Installation for any project\n\n1. Create a \`skills/\` folder at the project root (or \`.claude/skills/\` for Claude Code).\n2. Copy each file according to the path written in its header.\n3. The CLAUDE.md addendum at the end of the file — pour it into your CLAUDE.md.`
    );

    const bySource = new Map<string, typeof artifacts>();
    for (const a of artifacts) {
      const arr = bySource.get(a.sourceRepo) ?? [];
      arr.push(a);
      bySource.set(a.sourceRepo, arr);
    }

    let fileNo = 0;
    for (const [source, items] of bySource) {
      const isField = source.startsWith("field:");
      L.push(`\n---\n\n# ${isField ? "🧪 From the field (accumulated experience)" : "📦 Source"}: ${source}`);
      for (const a of items) {
        fileNo++;
        L.push(`\n## [${fileNo}] ${a.kind} · ${a.path}${a.description ? `\n> ${a.description}` : ""}`);
        L.push(`\`\`\`markdown\n${a.content ?? "(no content)"}\n\`\`\``);
      }
    }

    if (chimeras.length) {
      L.push(`\n---\n\n# ⚗️ Merged chimeras (${chimeras.length})`);
      for (const c of chimeras) {
        L.push(`\n## ${c.name}\n> Sources: ${c.sources.split(",").join(" · ")}`);
        L.push(`\`\`\`markdown\n${c.skillMd}\n\`\`\``);
      }
    }

    L.push(
      `\n---\n\n# 📘 CLAUDE.md Addendum\n\n> Add this to your project's CLAUDE.md so the agent knows about the skills:\n\n\`\`\`markdown\n## Available Skills (from Claude Hunter DNA Codex)\n\nThe following skills are available in skills/ — read the relevant SKILL.md before attempting a matching task:\n${artifacts
        .filter((a) => a.kind === "skill" || a.kind === "command")
        .map((a) => `- ${a.path}: ${a.description ?? a.name}`)
        .join("\n")}\n\`\`\``
    );

    const content = L.join("\n");
    return NextResponse.json({
      filename: `claude-hunter-dna-codex-${Date.now()}.md`,
      stats: { artifacts: artifacts.length, totalGenes, fieldGenes: fieldCount, omitted, sources: bySource.size, chimeras: chimeras.length, bytes: content.length },
      content,
    });
  } catch (e) {
    console.error("export/pack failed", e);
    return NextResponse.json({ error: "Codex export failed" }, { status: 500 });
  }
}
