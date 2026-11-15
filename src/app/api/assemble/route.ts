import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { assemblePlugin } from "@/lib/gene-assembler";
import { zipStore } from "@/lib/zip-store";

export const dynamic = "force-dynamic";

const MAX_GENES = 150;

/**
 * POST /api/assemble
 * { name, description?, version?, author?, repos?: string[], geneIds?: number[],
 *   allowExecutables?: boolean, acceptLicenseRisk?: boolean, format?: "report" | "zip" }
 * Builds an installable Claude Code plugin from library genes. `format: "zip"` returns the bundle
 * base64-encoded next to the report; the default returns the report and file list only.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const repos = Array.isArray(body.repos) ? body.repos.filter((r): r is string => typeof r === "string").slice(0, 20) : [];
  const geneIds = Array.isArray(body.geneIds) ? body.geneIds.filter((n): n is number => Number.isInteger(n)).slice(0, MAX_GENES) : [];
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (repos.length === 0 && geneIds.length === 0) return NextResponse.json({ error: "select repos or geneIds" }, { status: 400 });

  try {
    const rows = await db.dnaArtifact.findMany({
      where: { OR: [...(repos.length ? [{ sourceRepo: { in: repos } }] : []), ...(geneIds.length ? [{ id: { in: geneIds } }] : [])] },
      select: { id: true, sourceRepo: true, path: true, kind: true, name: true, description: true, content: true, license: true, rawUrl: true },
      orderBy: [{ sourceRepo: "asc" }, { path: "asc" }],
      take: MAX_GENES * 4,
    });
    const result = assemblePlugin(rows, {
      name,
      description: typeof body.description === "string" ? body.description : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
      author: typeof body.author === "string" ? body.author : undefined,
      allowExecutables: body.allowExecutables === true,
      acceptLicenseRisk: body.acceptLicenseRisk === true,
    });
    if (!result.ok) return NextResponse.json({ ok: false, report: result.report }, { status: 422 });
    return NextResponse.json({
      ok: true,
      report: result.report,
      files: Object.keys(result.files),
      ...(body.format === "zip" ? { filename: `${name}.zip`, zipBase64: zipStore(result.files).toString("base64") } : {}),
    });
  } catch (e) {
    console.error("[assemble]", e);
    return NextResponse.json({ error: "Assembly failed — details in the server log" }, { status: 500 });
  }
}
