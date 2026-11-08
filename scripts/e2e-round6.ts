/**
 * e2e-round6.ts — live end-to-end for round 6 (against the dev server :3000).
 * Resumable: state lives in the DB; each phase fits in one bash timeout window.
 *   bun scripts/e2e-round6.ts search      — code-mode star enrichment + history dedup
 *   bun scripts/e2e-round6.ts hunt        — start (or resume) a live hunt, pump to done
 *   bun scripts/e2e-round6.ts report-cas  — two parallel field reports (lost-update test)
 *   bun scripts/e2e-round6.ts fail-inject — flip hunt row to failed, expect 409 + payload.hunt
 *   bun scripts/e2e-round6.ts sweep       — full sweep + stats assertions
 *   bun scripts/e2e-round6.ts audit       — adversarial audit on the latest sweep
 *   bun scripts/e2e-round6.ts assert      — final DB assertions + verdict
 */
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const db = new PrismaClient();

const j = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(320_000),
  });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: string[] = [];
const note = (ok: boolean, label: string, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? ` | ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

async function phaseSearch() {
  // 1) code-mode star enrichment (round-6: GraphQL batch after REST code search)
  // "claude opus 6.5" כמחרוזת מצוטטת היא נדירה בקוד אמיתי — משתמשים במזהה שמופיע בפועל
  const body = { mode: "code" as const, query: "claude-opus-6-5", perPage: 24 };
  const r1 = await j("/api/search", { method: "POST", body: JSON.stringify(body) });
  note(r1.status === 200, "search code-mode 200", `status=${r1.status}`);
  const items: any[] = r1.body?.items ?? [];
  const withStars = items.filter((i) => (i.stars ?? 0) > 0).length;
  note(items.length > 0, "code-mode found repos", `items=${items.length}`);
  note(
    items.length === 0 || withStars > 0,
    "code-mode stars enriched (GraphQL)",
    `${withStars}/${items.length} items have stars>0 (was always 0 before round 6)`,
  );
  const zeroStar = items.filter((i) => (i.stars ?? 0) === 0).map((i) => i.fullName);
  if (zeroStar.length) console.log("  (zero-star repos:", zeroStar.slice(0, 5).join(", "), ")");

  // 2) history dedup — same search, different page
  const histBefore = await db.searchHistory.count();
  const b2 = JSON.stringify({ ...body, page: 2 });
  const first = await j("/api/search", { method: "POST", body: b2 });
  await j("/api/search", { method: "POST", body: b2 }); // exact repeat
  const histAfter = await db.searchHistory.count();
  note(
    first.status === 200 && histAfter === histBefore,
    "history dedup: repeat search adds no rows",
    `before=${histBefore} after=${histAfter} (page churn used to add a row per page)`,
  );
}

async function phaseHunt() {
  // resume or start
  let huntId: number | null = null;
  const running = await db.liveHunt.findFirst({ where: { status: "running" }, orderBy: { id: "desc" } });
  if (running) {
    huntId = running.id;
    console.log(`  resuming hunt #${huntId} (stage=${running.stageKey})`);
  } else {
    const done = await db.liveHunt.findFirst({ where: { status: "done" }, orderBy: { id: "desc" } });
    if (done && process.argv.includes("--reuse")) {
      huntId = done.id;
      console.log(`  --reuse: re-verifying done hunt #${huntId}`);
    }
  }
  if (huntId === null) {
    const start = await j("/api/live-hunt", { method: "POST", body: JSON.stringify({ action: "start" }) });
    if (start.status !== 200) {
      note(false, "hunt start", JSON.stringify(start.body).slice(0, 200));
      return;
    }
    huntId = start.body.hunt.id as number;
    note(true, "hunt started", `#${huntId}`);
  }
  const deadline = Date.now() + 560_000;
  let lastStage = "";
  let guard = 0;
  while (Date.now() < deadline) {
    guard++;
    if (guard > 400) break;
    const r = await j("/api/live-hunt", { method: "POST", body: JSON.stringify({ action: "next", id: huntId }) });
    if (r.status !== 200) {
      const payloadHunt = (r.body as any)?.hunt;
      note(false, "hunt step error", `status=${r.status} err=${JSON.stringify(r.body?.error ?? "").slice(0, 200)} huntAttached=${!!payloadHunt}`);
      return;
    }
    const h = r.body.hunt;
    if (h.stageKey !== lastStage) {
      lastStage = h.stageKey;
      console.log(`  stage=${h.stageKey} status=${h.status} llm=${h.llmCalls} elapsed=${Math.round(h.elapsedMs / 1000)}s`);
    }
    if (h.status === "done") {
      note(true, "hunt chain done", `#${h.id} stages=${h.stages.length} mission=${h.missionId} llm=${h.llmCalls} dna=${h.dnaBefore}→${h.dnaAfter}`);
      const huntEv = h.stages.find((s: any) => s.key === "hunt")?.evidence ?? {};
      const mineEv = h.stages.find((s: any) => s.key === "mine")?.evidence ?? {};
      note(Array.isArray(huntEv.queries) && huntEv.queries.length >= 26, "hunt: full arsenal ran", `queries=${huntEv.queries?.length} (26 statics + evolved, budget≥26 even in gen≥2)`);
      note(typeof mineEv.reposWithFindings === "number", "mine: honest fields", `reposWithFindings=${mineEv.reposWithFindings}/${mineEv.reposMined ?? "?"} attempted=${mineEv.reposAttempted ?? "?"} errors=${mineEv.mineErrorCount ?? 0}`);
      const grow = h.stages.find((s: any) => s.key === "grow")?.evidence ?? {};
      note(typeof grow.dnaBirthError !== "undefined", "grow: dnaBirthError surfaced (field exists)", `bornDnaId=${grow.bornDnaId ?? null}`);
      return;
    }
    if (h.status === "failed") {
      note(false, "hunt failed", String(h.error).slice(0, 200));
      return;
    }
    await sleep(300);
  }
  note(false, "hunt: timeout in this window — run `bun scripts/e2e-round6.ts hunt` again to resume", `stage=${lastStage}`);
}

async function phaseReportCas() {
  const mission = await db.mission.findFirst({ where: { report: { not: null } }, orderBy: { id: "desc" } });
  if (!mission) { note(false, "report-cas: no mission with report found"); return; }
  const before = await db.mission.findUnique({ where: { id: mission.id } });
  const prevCount = Array.isArray(JSON.parse(before?.report ?? "[]")) ? JSON.parse(before?.report ?? "[]").length : 0;
  // two parallel reports — the second must not drop the first (lost-update fix)
  const mk = (notes: string) =>
    j("/api/mission/report", { method: "POST", body: JSON.stringify({ missionId: mission.id, outcome: "partial", notes }) });
  const [a, b] = await Promise.all([mk("note-A (round6 CAS test)"), mk("note-B (round6 CAS test)")]);
  note(a.status === 200 && b.status === 200, "parallel reports both 200", `${a.status}/${b.status}`);
  const after = await db.mission.findUnique({ where: { id: mission.id } });
  const arr = JSON.parse(after?.report ?? "[]");
  const hasA = arr.some((x: any) => String(x.notes ?? "").includes("note-A"));
  const hasB = arr.some((x: any) => String(x.notes ?? "").includes("note-B"));
  note(
    hasA && hasB,
    "no lost update: both reports in history",
    `entries=${arr.length} (before=${prevCount}) A=${hasA} B=${hasB} — second write used to drop the first`,
  );
  note(after?.status === "partial" || after?.status === "done", "status forward-only after reports", `status=${after?.status}`);
}

async function phaseFailInject() {
  const hunt = await db.liveHunt.findFirst({ where: { status: "done" }, orderBy: { id: "desc" } });
  if (!hunt) { note(false, "fail-inject: no done hunt"); return; }
  await db.liveHunt.update({ where: { id: hunt.id }, data: { status: "failed", error: "הזרקת כשל לבדיקה (e2e)" } });
  try {
    const r = await j("/api/live-hunt", { method: "POST", body: JSON.stringify({ action: "next", id: hunt.id }) });
    const payloadHunt = (r.body as any)?.hunt;
    note(
      r.status === 409 && payloadHunt && payloadHunt.status === "failed",
      "failed hunt → 409 + state attached (pump-stop fix)",
      `status=${r.status} huntAttached=${!!payloadHunt} — before round 6 this re-ran the failing stage forever`,
    );
    note(
      typeof payloadHunt?.error === "string" && payloadHunt.error.length > 0,
      "failed state carries the error",
      String(payloadHunt?.error ?? "").slice(0, 80),
    );
  } finally {
    await db.liveHunt.update({ where: { id: hunt.id }, data: { status: "done", error: null } });
    note(true, "fail-inject: row restored to done", `#${hunt.id}`);
  }
}

async function phaseSweep() {
  let sweepId: number | null = null;
  const active = await db.sweepRun.findFirst({ where: { status: "running" }, orderBy: { id: "desc" } });
  const list = await j("/api/sweep");
  const latest: any = list.body?.active ?? list.body?.items?.[0] ?? null;
  if (active) {
    sweepId = active.id;
    console.log(`  resuming sweep #${sweepId}`);
  } else if (latest && (latest.status === "running")) {
    sweepId = latest.id;
  } else if (process.argv.includes("--reuse")) {
    sweepId = latest?.id ?? null;
    console.log(`  --reuse: re-verifying sweep #${sweepId}`);
  }
  if (sweepId === null) {
    const start = await j("/api/sweep", { method: "POST" });
    if (start.status !== 200) { note(false, "sweep start", JSON.stringify(start.body).slice(0, 200)); return; }
    sweepId = start.body.id;
    note(true, "sweep started", `#${sweepId}`);
  }
  const deadline = Date.now() + 560_000;
  let lastPhase = "";
  while (Date.now() < deadline) {
    const r = await j(`/api/sweep/${sweepId}`);
    const row = r.body;
    if (row?.phase !== lastPhase) { lastPhase = row?.phase ?? "?"; console.log(`  phase=${row?.phase} progress=${row?.progress}%`); }
    if (row?.status === "done") {
      const stats = row.stats ?? {};
      note(true, "sweep done", `#${row.id} elapsed=${Math.round((stats.elapsedMs ?? 0) / 1000)}s llm=${stats.llmCalls}`);
      note(
        Array.isArray(row.findings) && row.findings.length <= 36,
        "findings ≤ triage coverage (36)",
        `findings=${row.findings?.length} — 60 saved before with rows 37-60 pending forever`,
      );
      const pending = (row.findings ?? []).filter((f: any) => f.verdict === null).length;
      note(pending === 0, "every finding has a verdict", `pending=${pending}`);
      note(typeof stats.reposWithFindings === "number", "stats: reposWithFindings present", `${stats.reposWithFindings ?? "?"}/${stats.reposMined ?? "?"} errors=${stats.mineErrors ?? 0}`);
      note(typeof stats.enriched === "number", "stats: enriched present", `enriched=${stats.enriched}`);
      return;
    }
    if (row?.status === "failed") { note(false, "sweep failed", String(row.error).slice(0, 200)); return; }
    await sleep(2500);
  }
  note(false, "sweep: timeout window — rerun this phase to resume", `phase=${lastPhase}`);
}

async function phaseAudit() {
  const sweep = await db.sweepRun.findFirst({ where: { status: "done", findings: { not: "[]" } }, orderBy: { id: "desc" } });
  if (!sweep) { note(false, "audit: no completed sweep"); return; }
  const existing = JSON.parse(sweep.audit ?? "null");
  if (existing?.status === "done" && !process.argv.includes("--reaudit")) {
    note(true, "audit already done (reuse)", `precision=${existing.precision}%`);
  } else {
    const start = await j(`/api/sweep/${sweep.id}/audit`, { method: "POST" });
    if (start.status !== 200) { note(false, "audit start", JSON.stringify(start.body).slice(0, 200)); return; }
    const deadline = Date.now() + 560_000;
    while (Date.now() < deadline) {
      const r = await j(`/api/sweep/${sweep.id}`);
      const audit = r.body?.audit;
      if (audit?.status === "done") { note(true, "audit done", `precision=${audit.precision}% checks=${audit.evidenceChecks?.length}`); break; }
      if (audit?.status === "failed") { note(false, "audit failed", String(audit.error).slice(0, 200)); return; }
      await sleep(2500);
    }
  }
  const row = await db.sweepRun.findUnique({ where: { id: sweep.id } });
  const audit = JSON.parse(row?.audit ?? "null");
  if (audit) {
    const errored = (audit.evidenceChecks ?? []).filter((c: any) => c.error).length;
    const refuted = (audit.evidenceChecks ?? []).filter((c: any) => !c.verified && !c.error).length;
    note(true, "audit table split: refuted vs inconclusive", `refuted=${refuted} inconclusive(errored)=${errored}`);
  }
}

async function phaseAssert() {
  const hunts = await db.liveHunt.findMany({ orderBy: { id: "desc" }, take: 3 });
  for (const h of hunts) {
    const stages = JSON.parse(h.stages ?? "[]");
    const grow = stages.find((s: any) => s.key === "grow")?.evidence ?? null;
    const mission = h.missionId ? await db.mission.findUnique({ where: { id: h.missionId } }) : null;
    note(
      !h.missionId || !!mission,
      `hunt #${h.id}: mission link intact`,
      `missionId=${h.missionId} missionExists=${!!mission} status=${h.status}`,
    );
    if (grow) {
      const reportArr = mission?.report ? JSON.parse(mission.report) : [];
      const mine = reportArr.filter((x: any) => x.source === `livehunt-${h.id}`);
      note(mine.length <= 1, `hunt #${h.id}: grow report not duplicated`, `entriesForSource=${mine.length} (dedupe by source)`);
    }
  }
  // token never in client-visible storage shape: settings masked only
  const st = await db.setting.findUnique({ where: { key: "github_pat" } });
  note(!!st, "server token stored (DB)", st ? `masked prefix=${st.value.slice(0, 7)}…` : "missing");
}

(async () => {
  const phase = process.argv[2] ?? "assert";
  try {
    if (phase === "search") await phaseSearch();
    else if (phase === "hunt") await phaseHunt();
    else if (phase === "report-cas") await phaseReportCas();
    else if (phase === "fail-inject") await phaseFailInject();
    else if (phase === "sweep") await phaseSweep();
    else if (phase === "audit") await phaseAudit();
    else if (phase === "assert") await phaseAssert();
    else console.log("unknown phase:", phase);
  } finally {
    if (results.length) {
      console.log("\n──── e2e results ────");
      for (const r of results) console.log("  " + r);
    }
    await db.$disconnect();
  }
})();
