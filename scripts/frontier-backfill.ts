#!/usr/bin/env tsx
// frontier-backfill.ts — one-time (and idempotent re-runnable) seeding of the
// emerging-model ledger from the texts the hunter ALREADY owns:
//   1. every gene's content in the library (the richest corpus — 1,400+ files)
//   2. every watchlist repo's description + models field
// Day-one value: if anyone in the mined corpus already mentions a frontier
// version above the registry (fable 5.3, a brand-new family), the radar knows
// NOW instead of waiting for the next sweep to touch that text again.
// Usage: bunx tsx scripts/frontier-backfill.ts [--dry]
import { PrismaClient } from "@prisma/client";
import { detectEmergingModels } from "../src/lib/emerging-models";

const db = new PrismaClient();
const dry = process.argv.includes("--dry");

try {
  const [genes, repos] = await Promise.all([
    db.dnaArtifact.findMany({ select: { sourceRepo: true, path: true, content: true, description: true, name: true } }),
    db.savedRepo.findMany({ select: { fullName: true, description: true, models: true, notes: true } }),
  ]);
  console.log(`scanning ${genes.length} genes + ${repos.length} watchlist repos…`);

  // Aggregate per (id) with per-repo attribution, then a single merge write —
  // the same discipline as recordEmergingSignals but batched (one transaction
  // instead of thousands; the per-signal writer stays the runtime path).
  const byId = new Map<
    string,
    { family: string; version: number; label: string; kind: "emerging" | "candidate"; repos: Set<string>; mentions: number; samplePaths: string[] }
  >();
  const absorb = (text: string | null | undefined, repo: string, path: string) => {
    if (!text) return;
    for (const s of detectEmergingModels(text)) {
      let e = byId.get(s.id);
      if (!e) {
        e = { family: s.family, version: s.version, label: s.label, kind: s.kind, repos: new Set(), mentions: 0, samplePaths: [] };
        byId.set(s.id, e);
      }
      e.mentions += 1;
      e.repos.add(repo);
      if (e.samplePaths.length < 3) e.samplePaths.push(path);
    }
  };

  for (const g of genes) {
    absorb(`${g.name} ${g.description ?? ""}`, g.sourceRepo, g.path);
    absorb(g.content, g.sourceRepo, g.path);
  }
  for (const r of repos) {
    absorb(`${r.fullName} ${r.description ?? ""} ${r.models ?? ""} ${r.notes ?? ""}`, r.fullName, "watchlist");
  }

  const found = Array.from(byId.entries()).sort((a, b) => b[1].repos.size - a[1].repos.size);
  if (found.length === 0) {
    console.log("BACKFILL_OK | no emerging-frontier pins found in the corpus — the radar starts clean");
  } else {
    console.log(`BACKFILL_SCAN | ${found.length} distinct emerging pins:`);
    for (const [id, e] of found) {
      const status = e.repos.size >= 2 ? "CONFIRMED (wave — joins the arsenal)" : "unconfirmed (single repo)";
      console.log(`  ${id} | ${e.kind} | ${e.mentions} mentions in ${e.repos.size} repo(s) | ${status}`);
      console.log(`    e.g. ${e.samplePaths[0]}`);
    }
  }

  if (!dry && found.length > 0) {
    const now = new Date().toISOString();
    await db.$transaction(
      async (tx) => {
        const row = await tx.setting.findUnique({ where: { key: "frontierLedger" } });
        let entries: unknown[] = [];
        try {
          const v = row?.value ? JSON.parse(row.value) : [];
          if (Array.isArray(v)) entries = v;
        } catch { /* corrupted row — rebuild beats losing the radar */ }
        const ledger = entries as {
          id: string; family: string; version: number; label: string; kind: string;
          firstSeen: string; lastSeen: string; repos: string[]; mentions: number;
          samplePaths: string[]; confirmed: boolean;
        }[];
        for (const [id, e] of found) {
          let x = ledger.find((l) => l.id === id);
          if (!x) {
            x = {
              id, family: e.family, version: e.version, label: e.label, kind: e.kind,
              firstSeen: now, lastSeen: now, repos: [], mentions: 0, samplePaths: [], confirmed: false,
            };
            ledger.push(x);
          }
          x.lastSeen = now;
          x.mentions += e.mentions;
          for (const r of e.repos) if (!x.repos.includes(r)) x.repos.push(r);
          for (const p of e.samplePaths) if (x.samplePaths.length < 3 && !x.samplePaths.includes(p)) x.samplePaths.push(p);
          if (!x.confirmed && x.repos.length >= 2) x.confirmed = true;
        }
        await tx.setting.upsert({
          where: { key: "frontierLedger" },
          update: { value: JSON.stringify(ledger) },
          create: { key: "frontierLedger", value: JSON.stringify(ledger) },
        });
      },
      { timeout: 30_000 }
    );
    console.log("BACKFILL_OK | ledger seeded (idempotent — re-runs only add)");
  }
} catch (e) {
  console.error("BACKFILL_FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await db.$disconnect();
}
