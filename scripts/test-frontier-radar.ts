// test-frontier-radar.ts — adversarial validation of the TRUTH-GATED emerging-model radar:
//  1. Detection: known families ABOVE the REAL registry frontier (4.5) emerge;
//     registered real versions and below-frontier pins never do.
//  2. Fiction immunity: the fable family NEVER produces a signal — it is
//     contamination, tracked by the gate (claude-models), not by the radar.
//  3. Candidate families: claude-myth-5-0 is a candidate; product words and
//     below-4.5 candidates never are.
//  4. False-positive guards: story prose, version-45 prose, bare majors.
//  5. Wave generation: the 7 patterns parameterize the version correctly and
//     anchor the router comparison to the REAL frontier (opus 4.5).
//  6. Ledger logic (pure parts): ONLY authority-confirmed entries feed the
//     arsenal; vouched-but-unverified and fiction entries never do.
//  7. Evidence wiring: a hit via an emerging query is hard evidence for the
//     entry id and counts as a frontier hit.
//  8. DB roundtrip: record + merge are race-safe; the 2-repo vouch sets
//     vouchReached (NOT confirmed — authority is a separate, networked step).
import { detectEmergingModels, waveQueriesFor, emergingModelQueries, recordEmergingSignals, loadFrontierLedger, CONFIRM_REPO_MIN, type LedgerEntry } from "../src/lib/emerging-models";
import { consolidateCandidates, type CodeHit, type RepoHit } from "../src/lib/deep-sweep";
import { PrismaClient } from "@prisma/client";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`PASS | ${name}${detail ? ` | ${detail}` : ""}`); }
  else { fail++; console.log(`FAIL | ${name}${detail ? ` | ${detail}` : ""}`); }
};
const ids = (text: string) => detectEmergingModels(text).map((s) => s.id);
const db = new PrismaClient();

// ---------- 1. Known families: above the REAL line (4.5) ----------
{
  check("opus 4.6 bare X.Y emerges", ids("benchmarked against opus 4.6 last night").includes("claude-opus-4-6"));
  check("claude-opus-4-6 pin emerges", ids('"model": "claude-opus-4-6"').includes("claude-opus-4-6"));
  check("opus 4,6 comma decimal emerges", ids("tuned for opus 4,6 in production").includes("claude-opus-4-6"));
  check("claude_opus_4_6 underscore emerges", ids("claude_opus_4_6 settings key").includes("claude-opus-4-6"));
  check("opus4.6 compact form emerges", ids("upgrade to opus4.6 today").includes("claude-opus-4-6"));
  check("claude-opus-4-6-20260101 date suffix emerges", ids("claude-opus-4-6-20260101 snapshot pin").includes("claude-opus-4-6"));
  check("claude-opus-5 major-only (prefixed) emerges", ids("claude-opus-5 just launched").includes("claude-opus-5"));
  check("opus 5.1 two notches up emerges", ids("opus 5.1 benchmarks").includes("claude-opus-5-1"));
  check("label formatting", detectEmergingModels("claude-opus-4-6")[0]?.label === "Opus 4.6");
  check("match provenance recorded", typeof detectEmergingModels("claude-opus-4-6")[0]?.match === "string");
}

// ---------- 2. Registered real / below-frontier / fiction: never emerging ----------
{
  check("opus 4.5 (the real frontier) does NOT emerge", ids("opus 4.5 everywhere").length === 0);
  check("claude-sonnet-4-5 does NOT emerge", ids('"claude-sonnet-4-5"').length === 0);
  check("haiku 4.5 does NOT emerge", ids("haiku 4.5 cheap tier").length === 0);
  check("opus 4.1 (registered) does NOT emerge", ids("opus 4.1 comparison").length === 0);
  check("claude-3-5-sonnet (legacy real) does NOT emerge", ids("claude-3-5-sonnet-20241022").length === 0);
  check("4.x pins do NOT emerge", ids("claude-opus-4-1 claude-sonnet-4").length === 0);
  check("FICTION: fable 5.5 NEVER emerges (contamination, not signal)", ids("claude-fable-5-5 everywhere").length === 0);
  check("FICTION: fable 5.2 NEVER emerges", ids("written for fable 5.2").length === 0);
  check("FICTION: claude-fable NEVER emerges", ids('"model": "claude-fable"').length === 0);
}

// ---------- 3. Candidate families + product-word guard ----------
{
  const cand = detectEmergingModels("claude-myth-5-0 settings pin");
  check("claude-myth-5-0 is a candidate family", cand.length === 1 && cand[0].kind === "candidate" && cand[0].id === "claude-myth-5-0");
  check("claude-code-2-1 is NOT a signal (product word)", ids("claude-code-2-1 released").length === 0);
  check("claude-agent-sdk-3-0 is NOT a signal", ids("claude-agent-sdk-3-0 import").length === 0);
  check("claude-desktop-4-9 is NOT a signal", ids("claude-desktop-4-9").length === 0);
  check("candidate below 4.5 is NOT a signal", ids("claude-myth-4-2").length === 0);
  check("candidate without minor is NOT a signal (strict X.Y form)", ids("claude-myth-5 something").length === 0);
}

// ---------- 4. False-positive guards ----------
{
  check("story prose: 'fable 6: the tortoise' does NOT emerge", ids("fable 6: the tortoise and the hare, a fable 6 chapters long").length === 0);
  check("version-45 prose does NOT emerge", ids("read 45 fable stories").length === 0);
  check("bare 'opus 5' (no prefix, no minor) does NOT emerge", ids("opus 5").length === 0);
  check("bare 'opus 5.1' (no prefix, X.Y) DOES emerge", ids("opus 5.1 benchmarks").includes("claude-opus-5-1"));
  check("empty text is safe", ids("").length === 0);
  check("random repo name claude-utils-9-9 is a candidate (accepted risk, authority gate backstops)", ids("claude-utils-9-9").length === 1, "single-repo noise never confirms without org:anthropics");
}

// ---------- 5. Wave generation ----------
{
  const wave = waveQueriesFor({ id: "claude-opus-4-6", label: "Opus 4.6", version: 4.6 });
  check("wave has the full 7 patterns", wave.length === 7, wave.map((w) => w.q).join(" ; "));
  check("wave pin query is exact", wave[0].q === '"claude-opus-4-6"');
  check("wave SKILL.md pattern parameterized", wave.some((w) => w.q === "claude-opus-4-6 filename:SKILL.md"));
  check("wave CLAUDE.md pattern uses spoken form", wave.some((w) => w.q === "opus 4.6 filename:CLAUDE.md"));
  check("wave router comparison anchored to the REAL frontier (opus 4.5)", wave.some((w) => w.q.includes('"claude-opus-4-5"') && w.q.includes('"claude-opus-4-6"')));
  check("wave fresh-repos pattern exists", wave.some((w) => w.kind === "repo" && w.q.includes("created:{fresh}")));
  check("wave eval pattern exists", wave.some((w) => w.q === "opus 4.6 eval"));
}

// ---------- 6. Ledger logic (pure parts) ----------
{
  const mk = (id: string, mentions: number, repos: string[], confirmed: boolean, kind: "emerging" | "candidate" | "fiction" = "emerging"): LedgerEntry => ({
    id, family: id.split("-")[1] ?? "x", version: 5, label: id, kind,
    firstSeen: "2026-11-12T00:00:00Z", lastSeen: "2026-11-12T00:00:00Z",
    repos, mentions, samplePaths: [], confirmed,
  });
  const led = [
    mk("claude-opus-4-6", 12, ["a/b", "c/d", "e/f"], true),
    mk("claude-myth-5-0", 3, ["a/b"], false),
    mk("claude-opus-5", 9, ["x/y", "z/w"], true),
    mk("claude-noise-8-8", 2, ["q/r"], false),
    mk("claude-fable-5-5", 41, ["s/1", "s/2", "s/3"], true, "fiction"), // even a "confirmed" fiction entry
  ];
  const qs = emergingModelQueries(led);
  const used = new Set(qs.map((q) => q.entryId));
  check("only confirmed entries generate queries", used.has("claude-myth-5-0") === false && used.has("claude-noise-8-8") === false);
  check("FICTION entries NEVER generate queries — even 'confirmed' ones", used.has("claude-fable-5-5") === false);
  check("cap of 2 confirmed entries respected", used.size <= 2, [...used].join(","));
  check("momentum ordering: opus 4.6 (12 mentions) leads", qs[0]?.entryId === "claude-opus-4-6");
  check("per-entry query volume: 7 per confirmed entry", qs.length === 14, `${qs.length}`);
  check("CONFIRM_REPO_MIN is 2 (the vouch threshold — authority is separate)", CONFIRM_REPO_MIN === 2);
  check("empty ledger generates nothing", emergingModelQueries([]).length === 0);
}

// ---------- 7. Evidence wiring through consolidateCandidates ----------
{
  const q = '"claude-opus-4-6"';
  const codeHits: CodeHit[] = [
    { path: "README.md", repo: "someone/router", capability: false, viaQuery: q },
    { path: "skills/x/SKILL.md", repo: "someone/router", capability: true, viaQuery: q },
  ];
  const repoHits: RepoHit[] = [];
  const cands = consolidateCandidates(codeHits, repoHits, [q]);
  const c = cands.find((x) => x.fullName === "someone/router");
  check("emerging-query hit counts as a frontier hit", !!c && c.frontierHits === 2, `${c?.frontierHits}`);
  check("emerging query → hard evidence for the entry id (fiction-classified by the gate, authority-confirmed by the radar)", !!c && c.contentEvidence.includes("claude-opus-4-6"), (c?.contentEvidence ?? []).join(","));
  check("evidence class is hard", c?.evidence === "hard");
  check("evidencePath recorded for re-verification", !!c && c.evidencePaths.length > 0);
  // backward compatibility: no dynamic queries → old behavior (frontier-model pool only)
  const legacy = consolidateCandidates(codeHits, repoHits);
  const lc = legacy.find((x) => x.fullName === "someone/router");
  check("legacy call (no dynamic queries) unaffected", lc?.frontierHits === 0 && lc?.evidence === "soft", `${lc?.frontierHits}/${lc?.evidence}`);
  // the static pool now grants evidence for REAL frontier ids
  const realQ = '"claude-opus-4-5" filename:SKILL.md';
  const realHits: CodeHit[] = [{ path: "skills/y/SKILL.md", repo: "real/adopter", capability: true, viaQuery: realQ }];
  const rc = consolidateCandidates(realHits, []).find((x) => x.fullName === "real/adopter");
  check("static real-frontier query → hard evidence for claude-opus-4-5", !!rc && rc.contentEvidence.includes("claude-opus-4-5"), (rc?.contentEvidence ?? []).join(","));
}

// ---------- 8. DB roundtrip (record + merge + vouch — authority is networked, not tested here) ----------
{
  const KEY = "frontierLedger";
  const before = await db.setting.findUnique({ where: { key: KEY } });
  const backup = before?.value ?? null;
  try {
    await db.setting.delete({ where: { key: KEY } }).catch(() => {});
    // single repo → recorded, NOT vouched
    const s1 = detectEmergingModels("tuned for opus 4.6");
    await recordEmergingSignals(s1, "alpha/one", "README.md");
    let led = await loadFrontierLedger();
    check("single-repo signal recorded, not vouched", led.length === 1 && led[0].id === "claude-opus-4-6" && led[0].vouchReached !== true && led[0].confirmed === false);
    // second repo vouches → vouchReached (NOT confirmed — text never confirms anymore)
    const s2 = detectEmergingModels("claude-opus-4-6 router");
    await recordEmergingSignals(s2, "beta/two", "router.ts");
    led = await loadFrontierLedger();
    check("second repo vouch sets vouchReached — confirmed stays FALSE until org:anthropics", led[0].vouchReached === true && led[0].confirmed === false, `vouch=${led[0].vouchReached} conf=${led[0].confirmed}`);
    check("mentions accumulate", led[0].mentions === 2, `${led[0].mentions}`);
    check("samplePaths capped and attributed", (led[0].samplePaths ?? []).length === 2);
    // concurrent recorders both survive (race-safe merge)
    await Promise.all([
      recordEmergingSignals(detectEmergingModels("claude-myth-5-0 pin"), "gamma/three", "a.md"),
      recordEmergingSignals(detectEmergingModels("claude-myth-5-0 again"), "delta/four", "b.md"),
    ]);
    led = await loadFrontierLedger();
    const myth = led.find((e) => e.id === "claude-myth-5-0");
    check("concurrent recorders both survive (race-safe merge)", !!myth && myth.repos.length === 2, (myth?.repos ?? []).join(","));
    check("vouch stays one-way after later single-repo mention", led.find((e) => e.id === "claude-opus-4-6")?.vouchReached === true);
    check("empty signal list is a no-op", (await recordEmergingSignals([], "x/y")) === 0);
  } finally {
    if (backup !== null) {
      await db.setting.upsert({ where: { key: KEY }, update: { value: backup }, create: { key: KEY, value: backup } });
    } else {
      await db.setting.delete({ where: { key: KEY } }).catch(() => {});
    }
    await db.$disconnect();
  }
}

console.log(`\n${pass} pass / ${fail} fail — frontier-radar (truth-gated)`);
process.exit(fail > 0 ? 1 : 0);
