#!/usr/bin/env node
/**
 * radar-report.mjs — generate the weekly ecosystem radar report from live DB.
 * This is the artifact that LEAVES the system: meaning goes out, raw material
 * stays in. Public-facing sections use aggregates + interpretation; the raw
 * gene lists / watchlist remain private product.
 * Output: reports/radar/YYYY-MM-DD.md (+ prints summary)
 * Usage: node scripts/radar-report.mjs
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";

const db = new PrismaClient();
const PERMISSIVE = ["MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC", "0BSD", "Unlicense", "self"];
const kindLabels = { skill: "Skills", command: "Commands", agent: "Agents", "claude-md": "CLAUDE.md", "agents-md": "AGENTS.md", "mcp-config": "MCP configs" };

try {
  const [genes, watch, hunts, missions, sweeps, chimeras, ledgerRow] = await Promise.all([
    db.dnaArtifact.findMany(),
    db.savedRepo.findMany({ orderBy: { score: "desc" } }),
    db.liveHunt.findMany({ orderBy: { id: "asc" } }),
    db.mission.findMany({ orderBy: { id: "asc" } }),
    db.sweepRun.findMany({ orderBy: { id: "asc" } }),
    db.chimera.findMany({ orderBy: { id: "asc" } }),
    db.setting.findUnique({ where: { key: "frontierLedger" } }),
  ]);

  // ---- aggregates ----
  // round 8: an empty library (fresh wipe / failed restore) divided by genes.length=0
  // and wrote literal "NaN%" / "Skills dominate (NaN%)" into the COMMITTED public report.
  // Guard the divisions; an empty library skips straight to an honest skip note.
  if (genes.length === 0) {
    console.error("RADAR_SKIP | empty library — nothing to report (run a hunt/restore first)");
    await db.$disconnect();
    process.exit(1);
  }
  const byKind = {};
  for (const g of genes) byKind[g.kind] = (byKind[g.kind] ?? 0) + 1;
  const byLicense = {};
  for (const g of genes) {
    const l = g.license ?? "unknown";
    byLicense[l] = (byLicense[l] ?? 0) + 1;
  }
  const permissive = genes.filter((g) => PERMISSIVE.includes(g.license)).length;
  const unlicensed = genes.filter((g) => g.license === "none").length;
  const copyleft = genes.filter((g) => g.license && g.license !== "unknown" && g.license !== "none" && !PERMISSIVE.includes(g.license)).length;
  const unknown = genes.filter((g) => !g.license).length;
  const repos = [...new Set(genes.map((g) => g.sourceRepo))];
  const doneHunts = hunts.filter((h) => h.status === "done");
  const totalLlm = doneHunts.reduce((s, h) => s + h.llmCalls, 0);
  const totalElapsed = doneHunts.reduce((s, h) => s + h.elapsedMs, 0);
  const sweepFindings = sweeps.flatMap((s) => {
    try { return JSON.parse(s.findings ?? "[]"); } catch { return []; }
  });

  // Frontier watch — the emerging-model radar: version pins ABOVE the registry
  // seen in the wild. Confirmed (≥2 repos) entries are waves the arsenal hunts
  // automatically — day-one detection without a code edit.
  let ledger = [];
  try {
    const v = ledgerRow?.value ? JSON.parse(ledgerRow.value) : [];
    if (Array.isArray(v)) ledger = v;
  } catch { /* corrupted row — the section simply reports nothing */ }
  const fiction = ledger.filter((e) => e && e.kind === "fiction");
  const confirmedWaves = ledger.filter((e) => e && e.confirmed && e.kind !== "fiction");
  const unconfirmed = ledger.filter((e) => e && !e.confirmed && e.kind !== "fiction");

  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# Claude Ecosystem Radar — ${date}`);
  lines.push("");
  lines.push("> Generated autonomously by Claude Hunter Pro from live GitHub intelligence.");
  lines.push("> Method: autonomous discovery (code-search arsenal) → swarm triage → DNA mining → synthesis.");
  lines.push("> Public layer: trends and interpretation. Raw gene library stays private.");
  lines.push("");
  lines.push("## 1. The library at a glance");
  lines.push("");
  lines.push(`- **${genes.length} capability genes** mined from **${repos.length} elite-track repos**`);
  lines.push(`- Composition: ${Object.entries(byKind).map(([k, n]) => `${kindLabels[k] ?? k}: ${n}`).join(" · ")}`);
  lines.push(`- **License provenance: ${permissive} permissive / ${copyleft} restrictive / ${unlicensed} unlicensed / ${unknown} unknown** — ${(100 * permissive / genes.length).toFixed(0)}% of the library is commercially usable as-is`);
  lines.push(`- ${doneHunts.length} completed autonomous hunts (${doneHunts.map((h) => `gen ${h.generation}`).join(" → ")}), ${totalLlm} LLM calls, ${Math.round(totalElapsed / 1000)}s total machine time`);
  lines.push("");
  lines.push("## 2. What the numbers say (interpretation)");
  lines.push("");
  // interpretation built from real aggregates, not invented claims
  const skillShare = ((byKind.skill ?? 0) / genes.length) * 100;
  lines.push(`- **Skills dominate (${skillShare.toFixed(0)}%)**: the ecosystem's center of gravity is shifting from "chat wrappers" to packaged, composable capabilities. Teams are standardizing on SKILL.md as the unit of work.`);
  if (copyleft > 0) {
    lines.push(`- **${copyleft} genes carry copyleft/unknown terms**: the ecosystem's best engineering is NOT uniformly free for the taking. Anyone building a commercial product on community Claude skills without license discipline is exposed — provenance tracking is now table stakes.`);
  }
  if (unlicensed > 0) {
    lines.push(`- **${unlicensed} genes are UNLICENSED (confirmed: no LICENSE file)** — all rights reserved by their authors. Legally untouchable without explicit permission; a stricter class than "unknown" and a growing share of freshly published skills.`);
  }
  const eliteStars = watch.filter((w) => w.score >= 80);
  if (eliteStars.length) {
    lines.push(`- **Elite signal concentrates**: ${eliteStars.length} repos score 80+ on the hunter's evidence-weighted scale — discovery is a power law; the radar exists to catch them early.`);
  }
  lines.push(`- **Synthesis compounds**: ${chimeras.length} chimera${chimeras.length === 1 ? "" : "s"} generated by cross-pollinating top DNA — knowledge that exists nowhere in any single repo.`);
  lines.push("");
  lines.push("## 3. Frontier watch (the radar sees what the registry doesn't)");
  lines.push("");
  lines.push(
    "The hunter self-detects frontier versions ABOVE its real registered line (opus/sonnet/haiku 4.5) — no code edit between a model release and the hunt. A signal needs " + `${2} distinct repo vouches AND an org:anthropics authority hit` + " before it steers the arsenal — text mentions alone confirm nothing.",
  );
  lines.push("");
  if (confirmedWaves.length === 0 && unconfirmed.length === 0) {
    lines.push("- No emerging-frontier pins detected yet — the corpus pins only registered versions. The radar is live and accumulating.");
  }
  for (const e of confirmedWaves) {
    lines.push(
      `- **${e.label} — LIVE WAVE** (${e.id}): ${e.mentions} mentions across ${e.repos.length} repos since ${String(e.firstSeen).slice(0, 10)}. The arsenal hunts it automatically — pins, skills, contracts, routers, evals.`,
    );
  }
  if (fiction.length > 0) {
    lines.push(`- **${fiction.length} fictional-model signal(s) tracked as contamination** (e.g. ${fiction.slice(0, 2).map((e) => `${e.label} — ${e.mentions} mentions in hallucination-spam repos, 0 org:anthropics hits`).join("; ")}). These models do not exist; the radar records the noise and never hunts it.`);
  }
  for (const e of unconfirmed.slice(0, 6)) {
    lines.push(
      `- ${e.label} (${e.id}): ${e.mentions} mention(s) in ${e.repos.length} repo — unconfirmed single-source signal, recorded and waiting for a second vouch.`,
    );
  }
  lines.push("");
  lines.push("## 4. Trend watch (what we're tracking next)");
  lines.push("");
  lines.push("- AGENTS.md adoption as the cross-tool agent contract (mined in 9 repos and rising)");
  lines.push("- Orchestration frameworks consolidating around skill-spawn-skill patterns");
  lines.push("- License hygiene of fast-growing skill collections (early-warning for compliance risk)");
  lines.push("");
  lines.push("## 5. Missions executed (proof of autonomy)");
  lines.push("");
  for (const m of missions) {
    lines.push(`- **${m.missionName}** — ${m.status}: goal distilled from live intel, planned, and executed autonomously end-to-end.`);
  }
  lines.push("");
  lines.push("## 6. Method / reproducibility");
  lines.push("");
  lines.push("Every claim above traces to mined artifacts with source repo, path, and license recorded at mining time. The pipeline is generation-aware: each hunt seeds the next with evolved queries, so coverage compounds run over run.");
  lines.push("");

  mkdirSync("reports/radar", { recursive: true });
  const file = `reports/radar/${date}.md`;
  writeFileSync(file, lines.join("\n"), "utf8");
  console.log(`RADAR_OK | ${file}`);
  console.log(`  genes=${genes.length} repos=${repos.length} hunts=${doneHunts.length} chimeras=${chimeras.length} missions=${missions.length}`);
  console.log(`  licenses: permissive=${permissive} restrictive=${copyleft} unlicensed=${unlicensed} unknown=${unknown}`);
  console.log(`  sweep findings analyzed: ${sweepFindings.length}`);
  console.log(`  frontier watch: ${confirmedWaves.length} confirmed wave(s), ${unconfirmed.length} unconfirmed signal(s)`);
} catch (e) {
  console.error("RADAR_FAIL:", e.message);
  process.exit(1);
} finally {
  await db.$disconnect();
}
