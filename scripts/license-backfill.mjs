#!/usr/bin/env node
/**
 * license-backfill.mjs — fill SPDX licenses for existing genes & watchlist repos.
 * Runs in the daily cycle too: any gene born without a license (or a new
 * watchlist repo) gets its license filled from one GraphQL batch call.
 * Idempotent: skips repos already carrying a license; field:* genes → "self".
 * Usage: node scripts/license-backfill.mjs
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";

const db = new PrismaClient();

// token: DB (server-stored) ← upload file (post-recycle)
async function resolveToken() {
  const row = await db.setting.findUnique({ where: { key: "github_pat" } });
  if (row?.value) return row.value;
  // round 8: this looked for a Hebrew-named file that does NOT exist on disk
  // (the real file is upload/token.secret — the name hunt-live.mjs uses) → post-recycle
  // this script threw "no GitHub token available" on every run. Both names, absolute.
  const candidates = ["/home/z/my-project/upload/token.secret", "/home/z/my-project/upload/טוקן טיטפקס10.secret"];
  const FILE = candidates.find((f) => existsSync(f));
  if (FILE) {
    const raw = readFileSync(FILE, "utf8").trim();
    if (raw.length > 20) {
      await db.setting.upsert({
        where: { key: "github_pat" },
        create: { key: "github_pat", value: raw },
        update: { value: raw },
      });
      return raw;
    }
  }
  return null;
}

async function fetchLicenses(fullNames, token) {
  const out = new Map();
  for (let i = 0; i < fullNames.length; i += 40) {
    const chunk = fullNames.slice(i, i + 40);
    const aliases = chunk
      .map((name, j) => {
        const [owner, repo] = name.split("/");
        if (!owner || !repo) return null;
        return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { licenseInfo { spdxId } }`;
      })
      .filter(Boolean);
    if (!aliases.length) continue;
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "claude-hunter-pro",
      },
      body: JSON.stringify({ query: `query { ${aliases.join(" ")} }` }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
    const data = await res.json();
    // round 8: `data.errors` was never inspected — a 200-with-errors response
    // (secondary rate limit, partial failure) made every `node` undefined, which
    // the loop below treated exactly like "repo exists with no license" → repos
    // permanently pinned as license:"none" (all rights reserved). And since the
    // backfill only ever selects license:null rows, a transient API error became a
    // permanent false legal label that propagates into the public radar report.
    // A failed chunk is skipped wholesale now — the repos stay null for the next cycle.
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      console.warn(`  GraphQL partial failure (${data.errors.length} errors) — chunk of ${chunk.length} skipped, retry next cycle`);
      continue;
    }
    chunk.forEach((name, j) => {
      const node = data?.data?.[`r${j}`];
      if (node === null || node === undefined) return; // repo deleted/renamed (or unreachable) — leave for next cycle
      const spdx = node?.licenseInfo?.spdxId ?? null;
      // NOASSERTION = יש רישיון אך לא מזוהה סטנדרטית — נשמר כתווית אמת
      if (spdx) out.set(name, spdx === "NOASSERTION" ? "other" : spdx);
      // repo exists but has NO license file = all rights reserved. Pin as "none"
      // so we stop re-querying it every cycle and the provenance stays truthful.
      else out.set(name, "none");
    });
  }
  return out;
}

try {
  // 1) גני שדה שלנו → "self"
  const selfRepos = await db.dnaArtifact.findMany({
    where: { sourceRepo: { startsWith: "field:" }, license: null } ,
    select: { id: true },
  });
  if (selfRepos.length) {
    await db.dnaArtifact.updateMany({
      where: { id: { in: selfRepos.map((r) => r.id) } },
      data: { license: "self" },
    });
  }

  // 2) מאגרי מקור בלי רישיון
  const geneRepos = (
    await db.dnaArtifact.groupBy({
      by: ["sourceRepo"],
      where: { license: null, sourceRepo: { not: { startsWith: "field:" } } },
    })
  ).map((g) => g.sourceRepo);

  // 3) מאגרי מעקב בלי רישיון
  const watchRepos = (
    await db.savedRepo.findMany({ where: { license: null }, select: { fullName: true } })
  ).map((r) => r.fullName);

  const need = [...new Set([...geneRepos, ...watchRepos])];
  let filled = 0;
  let stillNull = 0;
  let unlicensed = 0;
  if (need.length > 0) {
    const token = await resolveToken();
    if (!token) throw new Error("no GitHub token available (DB or upload file)");
    const lic = await fetchLicenses(need, token);
    for (const [name, spdx] of lic) {
      if (spdx === "none") unlicensed++;
      const g = await db.dnaArtifact.updateMany({
        where: { sourceRepo: name, license: null },
        data: { license: spdx },
      });
      const w = await db.savedRepo.updateMany({
        where: { fullName: name, license: null },
        data: { license: spdx },
      });
      filled += g.count + w.count;
    }
    stillNull = need.length - lic.size;
  }

  // סיכום פרוביננס
  const total = await db.dnaArtifact.count();
  const withLic = await db.dnaArtifact.count({ where: { license: { not: null } } });
  const permissive = await db.dnaArtifact.count({
    where: { license: { in: ["MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC", "0BSD", "Unlicense", "self"] } },
  });
  const unlicensedGenes = await db.dnaArtifact.count({ where: { license: "none" } });
  console.log(`BACKFILL_OK | filled=${filled} selfMarked=${selfRepos.length} unlicensedPinned=${unlicensed} lookupFailed=${stillNull}`);
  console.log(`  provenance: ${withLic}/${total} genes carry a license · ${permissive}/${total} commercially usable (permissive/self) · ${unlicensedGenes} unlicensed (all rights reserved)`);
} catch (e) {
  console.error("BACKFILL_FAIL:", e.message);
  process.exit(1);
} finally {
  await db.$disconnect();
}
