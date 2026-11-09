#!/usr/bin/env node
/**
 * hunt-live.mjs — live population run (round 7): token → hunt → harvest → sweep → status
 * Usage: node scripts/hunt-live.mjs <phase>
 *   token   — store uploaded PAT server-side (validated against GitHub, never printed)
 *   hunt    — start (or resume) a live hunt, pump stages to done
 *   harvest — autonomous elite-repo harvest (maxRepos=6)
 *   sweep   — full deep sweep (background, polled to done)
 *   status  — DB summary: genes, hunts, missions, sweeps, chimera
 */
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3000";
const TOKEN_FILE = "upload/טוקן טיטפקס10.secret";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const j = async (path, init, timeoutMs = 320_000) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

// ---------- phase: token ----------
async function phaseToken() {
  const raw = readFileSync(TOKEN_FILE, "utf8").trim();
  if (!raw || raw.length < 20) { console.error("FAIL | token file empty/malformed"); process.exit(1); }
  const r = await j("/api/settings/token", { method: "POST", body: JSON.stringify({ token: raw }) }, 30_000);
  if (r.status !== 200) {
    console.error(`FAIL | token store → ${r.status}: ${JSON.stringify(r.body)}`);
    process.exit(1);
  }
  console.log(`PASS | token stored server-side | hasToken=${r.body.hasToken} masked=${r.body.masked ?? r.body.tokenPreview ?? "?"}`);
  // quota snapshot
  const q = await j("/api/rate-limit", {}, 30_000);
  if (q.status === 200) {
    const c = q.body.core, s = q.body.search ?? q.body.codeSearch;
    console.log(`INFO | quota core=${c ? `${c.remaining}/${c.limit}` : "?"} search=${s ? `${s.remaining}/${s.limit}` : "?"}`);
  }
}

// ---------- phase: hunt ----------
async function phaseHunt() {
  let huntId = null;
  const list = await j("/api/live-hunt");
  const running = (list.body?.items ?? []).find((h) => h.status === "running");
  if (running) {
    huntId = running.id;
    console.log(`  resuming hunt #${huntId} (stage=${running.stageKey})`);
  } else {
    const start = await j("/api/live-hunt", { method: "POST", body: JSON.stringify({ action: "start" }) });
    if (start.status !== 200) { console.error(`FAIL | hunt start → ${start.status}: ${JSON.stringify(start.body).slice(0, 200)}`); process.exit(1); }
    huntId = start.body.hunt.id;
    console.log(`PASS | hunt started #${huntId}`);
  }
  const titles = start_titles(list.body);
  const deadline = Date.now() + 540_000;
  let lastStage = "", guard = 0;
  while (Date.now() < deadline) {
    guard++;
    if (guard > 450) break;
    const r = await j("/api/live-hunt", { method: "POST", body: JSON.stringify({ action: "next", id: huntId }) });
    if (r.status !== 200) {
      const err = r.body?.error ?? "";
      const attached = !!r.body?.hunt;
      console.error(`FAIL | hunt step → ${r.status} err=${String(err).slice(0, 250)} huntAttached=${attached}`);
      if (attached) {
        const h = r.body.hunt;
        console.error(`     state: status=${h.status} stage=${h.stageKey} elapsed=${Math.round((h.elapsedMs ?? 0) / 1000)}s`);
      }
      process.exit(1);
    }
    const h = r.body.hunt;
    if (h.stageKey !== lastStage) {
      lastStage = h.stageKey;
      console.log(`  → ${h.stageKey} (${titles[h.stageKey] ?? "?"}) · llm=${h.llmCalls ?? 0} · ${Math.round((h.elapsedMs ?? 0) / 1000)}s`);
    }
    if (h.status === "done") {
      console.log(`PASS | hunt #${h.id} DONE in ${Math.round((h.elapsedMs ?? 0) / 1000)}s`);
      console.log(`     dna ${h.dnaBefore ?? "?"} → ${h.dnaAfter ?? "?"} genes · llm=${h.llmCalls ?? 0} calls · mission=${h.missionId ?? "—"} · gen=${h.generation ?? "?"}`);
      const stages = h.stages ?? [];
      for (const s of stages) {
        const note = s.note ?? s.summary ?? "";
        console.log(`     · ${s.key ?? s.stageKey ?? "?"}: ${String(note).slice(0, 110)}`);
      }
      return;
    }
    if (h.status === "failed") {
      console.error(`FAIL | hunt #${h.id} failed at ${h.stageKey}: ${String(h.error ?? "").slice(0, 250)}`);
      process.exit(1);
    }
    await sleep(1200);
  }
  console.error(`FAIL | hunt: timeout window (still stage=${lastStage}) — rerun this phase to resume`);
  process.exit(1);
}
function start_titles(listBody) {
  const t = listBody?.stageTitles;
  return t && typeof t === "object" ? t : {};
}

// ---------- phase: harvest ----------
async function phaseHarvest() {
  const r = await j("/api/harvest", { method: "POST", body: JSON.stringify({ maxRepos: 6 }) }, 330_000);
  if (r.status !== 200) { console.error(`FAIL | harvest → ${r.status}: ${JSON.stringify(r.body).slice(0, 250)}`); process.exit(1); }
  const b = r.body;
  console.log(`PASS | harvest done`);
  console.log(`     candidates=${b.candidatesFound ?? "?"} queriesRun=${b.queriesRun ?? "?"} (failed=${b.queriesFailed ?? 0}) · repos=${(b.reposMined ?? []).length} mined · skipped=${b.skippedAlreadyMined ?? 0}`);
  console.log(`     genes: +${b.artifactsAdded ?? "?"} new · ${b.artifactsUpdated ?? 0} updated · library total=${b.totalLibrary ?? "?"}`);
  for (const repo of b.reposMined ?? []) console.log(`     ⛏ ${repo.repo ?? "?"} ★${repo.stars ?? "?"} → +${repo.newCount ?? 0} genes${repo.updatedCount ? ` (~${repo.updatedCount} upd)` : ""}`);
  if ((b.reposFailed ?? []).length) console.log(`     ✗ failed: ${b.reposFailed.map((x) => x.repo ?? x).join(", ")}`);
}

// ---------- phase: sweep ----------
async function phaseSweep() {
  const list = await j("/api/sweep");
  const active = list.body?.active;
  let sweepId = active?.id ?? null;
  if (sweepId) console.log(`  resuming sweep #${sweepId} (phase=${active.phase})`);
  else {
    const start = await j("/api/sweep", { method: "POST" }, 30_000);
    if (start.status !== 200) { console.error(`FAIL | sweep start → ${start.status}: ${JSON.stringify(start.body).slice(0, 200)}`); process.exit(1); }
    sweepId = start.body.id;
    console.log(`PASS | sweep started #${sweepId}`);
  }
  const deadline = Date.now() + 540_000;
  let lastPhase = "";
  while (Date.now() < deadline) {
    const r = await j(`/api/sweep/${sweepId}`);
    const row = r.body;
    if (row?.phase !== lastPhase) { lastPhase = row?.phase ?? "?"; console.log(`  phase=${row?.phase} progress=${row?.progress ?? "?"}%`); }
    if (row?.status === "done") {
      const st = row.stats ?? {};
      console.log(`PASS | sweep #${row.id} DONE in ${Math.round((st.elapsedMs ?? 0) / 1000)}s llm=${st.llmCalls ?? 0}`);
      console.log(`     findings=${(row.findings ?? []).length} reposWithFindings=${st.reposWithFindings ?? "?"}/${st.reposMined ?? "?"} enriched=${st.enriched ?? "?"} mineErrors=${st.mineErrors ?? 0}`);
      const pending = (row.findings ?? []).filter((f) => f.verdict === null).length;
      console.log(`     pendingVerdicts=${pending}`);
      return;
    }
    if (row?.status === "failed") { console.error(`FAIL | sweep failed: ${String(row.error).slice(0, 250)}`); process.exit(1); }
    await sleep(2500);
  }
  console.error(`FAIL | sweep: timeout window (phase=${lastPhase}) — rerun this phase to resume`);
  process.exit(1);
}

// ---------- phase: status ----------
async function phaseStatus() {
  const genes = await j("/api/dna-library");
  const geneItems = genes.body?.items ?? genes.body?.genes ?? [];
  const hunts = await j("/api/live-hunt");
  const missions = await j("/api/mission");
  const sweeps = await j("/api/sweep");
  console.log("=== STATUS ===");
  console.log(`genes=${Array.isArray(geneItems) ? geneItems.length : genes.body?.total ?? "?"}`);
  console.log(`hunts=${(hunts.body?.items ?? []).length} (done=${(hunts.body?.items ?? []).filter((h) => h.status === "done").length})`);
  console.log(`sweeps=${(sweeps.body?.items ?? []).length}`);
  const m = missions.body?.items ?? missions.body?.missions ?? [];
  console.log(`missions=${Array.isArray(m) ? m.length : "?"}`);
}

const phase = process.argv[2] ?? "status";
const phases = { token: phaseToken, hunt: phaseHunt, harvest: phaseHarvest, sweep: phaseSweep, status: phaseStatus };
if (!phases[phase]) { console.error(`unknown phase: ${phase} (token|hunt|harvest|sweep|status)`); process.exit(1); }
await phases[phase]();
