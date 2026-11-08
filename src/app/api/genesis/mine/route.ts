import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { GhError } from "@/lib/github";
import { mineDna } from "@/lib/dna-miner";
import { captureTokenFrom, resolveToken } from "@/lib/server-token";

export const dynamic = "force-dynamic";

/** כריית DNA מריפו + שמירה לספרייה */
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
    return NextResponse.json({ error: "גוף הבקשה אינו תקין" }, { status: 400 });
  }
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: "נדרש owner/repo תקין" }, { status: 400 });
  }

  try {
    const pkg = await mineDna(owner, repo, token);
    // הכרייה הצליחה מול GitHub — טוקן תקין מהכותרת נשמר לשימוש השרת
    // (בעבר: analyze/harvest/rate-limit לכדו; כאן לא — אי-עקביות).
    await captureTokenFrom(req).catch(() => undefined);
    const warnings: string[] = [];
    if (pkg.treeTruncated) {
      warnings.push("עץ הקבצים של הריפו נחתך (מאגר ענק מאוד) — ייתכן שנמצאו רק חלק מקבצי היכולת");
    }
    if (pkg.artifacts.length === 0) {
      return NextResponse.json({
        ...pkg,
        warnings,
        note: "לא נמצאו קבצי יכולת Claude (.claude/, CLAUDE.md) בריפו הזה — ייתכן שהפרויקט לא נבנה עם Claude Code",
      });
    }
    // שמירה/עדכון בספריית ה-DNA
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
    const msg = e instanceof GhError ? e.message : "הכרייה נכשלה";
    const status = e instanceof GhError ? e.status : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
