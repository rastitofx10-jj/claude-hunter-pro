#!/usr/bin/env node
/**
 * findings-desk.mjs — chimera #3 (verified-mutation-flywheel) WO2 live injection:
 * the STANDING REVIEW DESK over the sweep-findings queue.
 *
 * Parent DNA (medici-finance/assay pr-review-desk):
 *   - a standing window watching a queue, not a scheduled event
 *   - reviewer slots refill on completion; reviews run in parallel
 *   - everything reviewed within one cadence tick
 *   - SILENT operation — human-needed items are filed artifacts, never narration
 *   - humans merge — always
 * Synergy with sibling work orders:
 *   - WO1 (data before doctrine): every review re-verifies evidence against LIVE
 *     GitHub — recorded stars/pushedAt are never trusted blindly
 *   - WO5 (record every verdict): verdicts + base rates persist and compound
 *
 * State: reports/state/findings-desk.json (committed → survives env recycles).
 * Idempotent + resumable: reviewed repos never re-enter the queue unless stale
 * (--recheck-days, default 30) — evidence decays, so old verdicts get refreshed.
 *
 * Usage: node scripts/findings-desk.mjs [--tick-only] [--recheck-days N]
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};

const db = new PrismaClient();
const STATE_FILE = "reports/state/findings-desk.json";
// round 8: `--recheck-days` as the LAST argv token made argOf() return undefined →
// Number(undefined)=NaN → recheckMs=NaN → `now - x > NaN` always false → re-checking
// silently disabled forever. A non-numeric/missing value falls back to the default 30.
const RECHECK_ARG = argOf("--recheck-days");
const RECHECK_DAYS = RECHECK_ARG != null && Number.isFinite(Number(RECHECK_ARG)) ? Number(RECHECK_ARG) : 30;
const SLOTS = 5; // parallel reviewer slots (assay: keep the pool full, refill on completion)

// ---- state ----
const state = existsSync(STATE_FILE)
  ? safeParse(readFileSync(STATE_FILE, "utf8"))
  : {
      version: 1,
      deskOpened: new Date().toISOString(),
      ticksDone: 0,
      reviewed: {}, // fullName -> verdict record
      needsHuman: [], // filed artifacts, never narration
      baseRates: null,
    };

// ---- token (never printed) ----
const tokenRow = await db.setting.findUnique({ where: { key: "github_pat" } });
const token = tokenRow?.value;
if (!token) {
  console.error("FATAL | no github_pat in Settings — store the token first");
  process.exit(1);
}

// ---- build the queue: latest finding per repo across DONE sweeps ----
const sweeps = await db.sweepRun.findMany({ where: { status: "done" }, select: { id: true, findings: true } });
const latest = {};
for (const s of sweeps) {
  let f;
  try { f = JSON.parse(s.findings ?? "[]"); } catch { continue; }
  for (const item of (Array.isArray(f) ? f : [])) {
    if (!item?.fullName) continue;
    latest[item.fullName] = { sweep: s.id, ...item }; // later sweep wins = newest evidence
  }
}

const now = Date.now();
const recheckMs = RECHECK_DAYS * 24 * 3600_000;
const queue = Object.entries(latest).filter(([name, rec]) => {
  const prev = state.reviewed[name];
  if (!prev) return true; // never reviewed → in queue
  return now - new Date(prev.checkedAt).getTime() > recheckMs; // evidence decayed → re-review
});

console.log(
  `desk tick | queue=${queue.length} (unique repos=${Object.keys(latest).length}, reviewed=${Object.keys(state.reviewed).length}, recheck=${RECHECK_DAYS}d)`
);
if (queue.length === 0) {
  console.log("QUEUE_EMPTY | desk idle — everything reviewed within cadence");
  await finish(0, null);
}

// ---- reviewer slot pool (parallel, refill on completion) ----
let idx = 0;
let reviews = 0;
const verdicts = { confirmed: 0, downgraded: 0, escalated: 0, missing: 0, stale: 0, needsHuman: 0 };
async function reviewer() {
  while (idx < queue.length) {
    const [name, rec] = queue[idx++];
    // round 8: review() had no guard — gh() swallows JSON-parse failures and returns
    // {status:200, body:null}; `live.stargazers_count` then threw, Promise.all rejected,
    // the top-level await threw, and finish()/writeFileSync never ran: every review
    // completed earlier in the tick was LOST and the process died unhandled.
    let v;
    try {
      v = await review(name, rec);
    } catch (e) {
      v = {
        outcome: "needsHuman",
        record: {
          repo: name,
          sweepFound: rec.sweep,
          recordedTier: rec.tier,
          checkedAt: new Date().toISOString(),
          liveVerdict: "unverified",
          reason: `desk internal error: ${String(e?.message ?? e).slice(0, 120)}`,
        },
        file: {
          repo: name,
          filedAt: new Date().toISOString(),
          reason: "desk internal error — retry next tick",
          evidence: { tier: rec.tier, stars: rec.stars, sweep: rec.sweep },
        },
      };
    }
    verdicts[v.outcome]++;
    if (v.outcome === "needsHuman") state.needsHuman.push(v.file);
    else state.needsHuman = state.needsHuman.filter((h) => h.repo !== name);
    // round 8 blackout fix: a needsHuman outcome wrote state.reviewed[name] with
    // checkedAt=now — the queue filter then excluded the repo for a full 30 days while
    // the filed reason literally said "retry next tick". A transient failure (5xx/0/
    // timeout/non-JSON body) no longer marks the repo reviewed: it re-enters next tick.
    // Only a real verdict (confirmed/downgraded/missing) closes the cadence window.
    if (v.outcome !== "needsHuman") state.reviewed[name] = v.record;
    reviews++;
  }
}

async function review(name, rec) {
  const res = await gh(`https://api.github.com/repos/${name}`);
  const checkedAt = new Date().toISOString();
  const record = {
    repo: name,
    sweepFound: rec.sweep,
    recordedTier: rec.tier,
    recordedStars: rec.stars,
    recordedVerdict: rec.verdict,
    checkedAt,
  };
  if (res.status === 404 || res.status === 301) {
    return {
      outcome: "missing",
      record: { ...record, liveVerdict: "gone", reason: `GitHub ${res.status} — evidence disappeared` },
      file: null,
    };
  }
  if (res.status !== 200) {
    // network/busy — NOT the finding's fault (InvestSkill: never blame the data for a network error)
    return {
      outcome: "needsHuman",
      record: { ...record, liveVerdict: "unverified", reason: `GitHub ${res.status} on check` },
      file: {
        repo: name,
        filedAt: checkedAt,
        reason: `verification unreachable (HTTP ${res.status}) — retry next tick`,
        evidence: { tier: rec.tier, stars: rec.stars, sweep: rec.sweep },
      },
    };
  }
  const live = res.body;
  // round 8: a 200 with a non-JSON body (proxy page, truncated response) left live=null
  // and `live.stargazers_count` below crashed the whole tick — guarded as needsHuman.
  if (!live || typeof live.stargazers_count !== "number") {
    return {
      outcome: "needsHuman",
      record: { ...record, liveVerdict: "unverified", reason: "GitHub 200 with unreadable body" },
      file: {
        repo: name,
        filedAt: checkedAt,
        reason: "verification unreachable (unreadable body) — retry next tick",
        evidence: { tier: rec.tier, stars: rec.stars, sweep: rec.sweep },
      },
    };
  }
  record.liveStars = live.stargazers_count;
  record.livePushedAt = live.pushed_at;
  record.archived = !!live.archived;

  // WO1 — evidence verification against live state
  const daysSincePush = (now - new Date(live.pushed_at).getTime()) / 86400_000;
  const stale = daysSincePush > 180;
  const starSag = typeof rec.stars === "number" && live.stargazers_count < rec.stars * 0.5;

  // adversarial pass (Bear Case): argue AGAINST the recorded tier
  let outcome = "confirmed";
  let liveVerdict = rec.tier;
  let reason = `evidence holds (stars ${rec.stars}→${live.stargazers_count}, pushed ${Math.round(daysSincePush)}d ago)`;
  if (stale || live.archived) {
    liveVerdict = rec.tier === "elite" ? "watch" : "noise";
    outcome = "downgraded";
    reason = live.archived ? "repo ARCHIVED — capability frozen" : `stale: last push ${Math.round(daysSincePush)}d ago`;
  } else if (starSag) {
    outcome = "downgraded";
    reason = `star sag: recorded ${rec.stars} → live ${live.stargazers_count}`;
  }
  // elite repos that hold their evidence against the bear case → confirmed with honor
  if (outcome === "confirmed" && rec.tier === "elite" && live.stargazers_count >= 1000) {
    reason += " — survived the bear case";
  }
  record.liveVerdict = liveVerdict;
  record.reason = reason;
  return { outcome, record, file: null };
}

async function gh(url) {
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "claude-hunter-desk" },
      signal: AbortSignal.timeout(15_000),
    });
    let body = null;
    try { body = await r.json(); } catch { /* 404 bodies are sometimes not json */ }
    return { status: r.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

// ---- run the tick ----
await Promise.all(Array.from({ length: Math.min(SLOTS, queue.length) }, () => reviewer()));
state.ticksDone++;

// ---- WO5 — base rates compound across ticks ----
const all = Object.values(state.reviewed);
state.baseRates = {
  reviewsTotal: all.length,
  // round 8: "unverified" records (needsHuman outcomes) were counted as confirmed —
  // a network hiccup inflated the WO5 confirmed base rate. Excluded now.
  confirmedRate: rate(all.filter((r) => r.liveVerdict !== "gone" && r.liveVerdict !== "unverified" && !String(r.reason ?? "").includes("stale") && !String(r.reason ?? "").includes("sag") && !String(r.reason ?? "").includes("ARCHIVED") && !String(r.reason ?? "").startsWith("desk internal")).length, all.length),
  missingRate: rate(all.filter((r) => r.liveVerdict === "gone").length, all.length),
  downgradedRate: rate(all.filter((r) => String(r.reason ?? "").match(/stale|sag|ARCHIVED/)).length, all.length),
  needsHumanOpen: state.needsHuman.length,
  eliteSurviving: all.filter((r) => r.recordedTier === "elite" && r.liveVerdict === "elite").length,
};

await finish(reviews, verdicts);

// ---- silent wrap-up: counts only; human items are in the state file ----
async function finish(reviewsThisTick, tickVerdicts) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), "utf8");
  const br = state.baseRates ?? {};
  const vSummary = tickVerdicts
    ? Object.entries(tickVerdicts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(" ")
    : "";
  console.log(
    `DESK_TICK_DONE | reviewed=${reviewsThisTick ?? 0} this tick | ticks=${state.ticksDone}${vSummary ? " | " + vSummary : ""}`
  );
  if (state.needsHuman.length) {
    console.log(`  human queue (filed, silent): ${state.needsHuman.length} item(s) — see ${STATE_FILE} → needsHuman`);
  }
  if (br.reviewsTotal) {
    console.log(
      `  base rates: confirmed=${pct(br.confirmedRate)} downgraded=${pct(br.downgradedRate)} missing=${pct(br.missingRate)} elite-surviving=${br.eliteSurviving}`
    );
  }
  console.log(`  → ${STATE_FILE}`);
  await db.$disconnect();
  process.exit(0);
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
function rate(n, d) { return d ? n / d : null; }
function pct(v) { return v == null ? "—" : Math.round(v * 100) + "%"; }
