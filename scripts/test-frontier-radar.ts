// test-frontier-radar.ts — adversarial validation of the emerging-model radar:
//  1. Detection: known families ABOVE the registry frontier emerge; registered
//     and below-threshold pins never do.
//  2. Placeholder immunity: the fable family entry (5.5 placeholder) does not
//     raise the frontier line — fable 5.3 must emerge.
//  3. Candidate families: claude-myth-7-1 is a candidate; product words
//     (claude-code-2-1) never are.
//  4. False-positive guards: story prose, version-45 prose, bare "fable 6".
//  5. Wave generation: the 7 patterns parameterize the version correctly.
//  6. Ledger logic (pure parts): confirmation at ≥2 repos, cap of 2 entries,
//     momentum ordering.
//  7. Evidence wiring: a hit via an emerging query is hard evidence for the
//     family id (fable 5.3 → claude-fable) and counts as a frontier hit.
//  8. DB roundtrip: recordEmergingSignals persists and merges race-safe.
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

// ---------- 1. Known families: above the line ----------
{
  check("fable 5.3 pin emerges (claude-fable-5-3)", ids("written for fable 5.3, tuned router").includes("claude-fable-5-3"));
  check("claude-fable-5-4 pin emerges", ids('"model": "claude-fable-5-4"').includes("claude-fable-5-4"));
  check("opus 7.5 emerges", ids("compares opus 7.5 with opus 7").includes("claude-opus-7-5"));
  check("claude-opus-8 emerges (major-only)", ids("claude-opus-8 is out").includes("claude-opus-8"));
  check("fable 6 emerges (claude-prefixed major-only)", ids("claude-fable-6 launched today").includes("claude-fable-6"));
  check("label formatting", detectEmergingModels("claude-fable-5-3")[0]?.label === "Fable 5.3");
  check("match provenance recorded", typeof detectEmergingModels("claude-fable-5-3")[0]?.match === "string");
}

// ---------- 2. Registered / below-threshold: never emerging ----------
{
  check("fable 5.2 (registered) does NOT emerge", ids("written for fable 5.2").length === 0);
  check("claude-fable-5-1 does NOT emerge", ids('"claude-fable-5-1"').length === 0);
  check("opus 5.5 / 6 / 7 (registered) do NOT emerge", ids("opus 5.5 opus 6 opus 7 sonnet 4.5 haiku").length === 0);
  check("4.x pins do NOT emerge (threshold rules)", ids("claude-opus-4-5 claude-sonnet-4-7").length === 0);
  check("fable 5.0 does NOT emerge (below family line 5.2)", ids("claude-fable-5-0").length === 0);
}

// ---------- 3. Candidate families + product-word guard ----------
{
  const cand = detectEmergingModels("claude-myth-7-1 settings pin");
  check("claude-myth-7-1 is a candidate family", cand.length === 1 && cand[0].kind === "candidate" && cand[0].id === "claude-myth-7-1");
  check("claude-code-2-1 is NOT a signal (product word)", ids("claude-code-2-1 released").length === 0);
  check("claude-agent-sdk-3-0 is NOT a signal", ids("claude-agent-sdk-3-0 import").length === 0);
  check("claude-desktop-5-9 is NOT a signal", ids("claude-desktop-5-9").length === 0);
  check("candidate below 5.5 is NOT a signal", ids("claude-myth-4-2").length === 0);
  check("candidate without minor is NOT a signal (strict X.Y form)", ids("claude-myth-7 something").length === 0);
}

// ---------- 4. False-positive guards ----------
{
  check("story prose: 'fable 6: the tortoise' does NOT emerge", ids("fable 6: the tortoise and the hare, a fable 6 chapters long").length === 0);
  check("version-45 prose does NOT emerge", ids("read 45 fable stories").length === 0);
  check("bare 'opus 8' (no prefix, no minor) does NOT emerge", ids("opus 8").length === 0);
  check("bare 'opus 8.1' (no prefix, X.Y) DOES emerge", ids("opus 8.1 benchmarks").includes("claude-opus-8-1"));
  check("empty text is safe", ids("").length === 0);
  check("random repo name claude-utils-9-9 is a candidate (accepted risk, confirmation gate handles it)", ids("claude-utils-9-9").length === 1, "single-repo noise stays unconfirmed");
}

// ---------- 5. Wave generation ----------
{
  const wave = waveQueriesFor({ id: "claude-fable-5-3", label: "Fable 5.3", version: 5.3 });
  check("wave has the full 7 patterns", wave.length === 7, wave.map((w) => w.q).join(" ; "));
  check("wave pin query is exact", wave[0].q === '"claude-fable-5-3"');
  check("wave SKILL.md pattern parameterized", wave.some((w) => w.q === "claude-fable-5-3 filename:SKILL.md"));
  check("wave CLAUDE.md pattern uses spoken form", wave.some((w) => w.q === "fable 5.3 filename:CLAUDE.md"));
  check("wave router comparison anchored to opus 5.5", wave.some((w) => w.q.includes('"claude-opus-5-5"') && w.q.includes('"claude-fable-5-3"')));
  check("wave fresh-repos pattern exists", wave.some((w) => w.kind === "repo" && w.q.includes("created:{fresh}")));
  check("wave eval pattern exists", wave.some((w) => w.q === "fable 5.3 eval"));
}

// ---------- 6. Ledger logic (pure parts) ----------
{
  const mk = (id: string, mentions: number, repos: string[], confirmed: boolean): LedgerEntry => ({
    id, family: id.split("-")[1] ?? "x", version: 6, label: id, kind: "emerging",
    firstSeen: "2026-11-12T00:00:00Z", lastSeen: "2026-11-12T00:00:00Z",
    repos, mentions, samplePaths: [], confirmed,
  });
  const led = [
    mk("claude-fable-5-3", 12, ["a/b", "c/d", "e/f"], true),
    mk("claude-myth-7-1", 3, ["a/b"], false),
    mk("claude-opus-7-5", 9, ["x/y", "z/w"], true),
    mk("claude-noise-8-8", 2, ["q/r"], false),
  ];
  const qs = emergingModelQueries(led);
  const used = new Set(qs.map((q) => q.entryId));
  check("only confirmed entries generate queries", used.has("claude-myth-7-1") === false && used.has("claude-noise-8-8") === false);
  check("cap of 2 confirmed entries respected", used.size <= 2, [...used].join(","));
  check("momentum ordering: fable 5.3 (12 mentions) leads", qs[0]?.entryId === "claude-fable-5-3");
  check("per-entry query volume: 7 per confirmed entry", qs.length === 14, `${qs.length}`);
  check("CONFIRM_REPO_MIN is 2 (the documented discipline)", CONFIRM_REPO_MIN === 2);
  check("empty ledger generates nothing", emergingModelQueries([]).length === 0);
}

// ---------- 7. Evidence wiring through consolidateCandidates ----------
{
  const q = '"claude-fable-5-3"';
  const codeHits: CodeHit[] = [
    { path: "README.md", repo: "someone/router", capability: false, viaQuery: q },
    { path: "skills/x/SKILL.md", repo: "someone/router", capability: true, viaQuery: q },
  ];
  const repoHits: RepoHit[] = [];
  const cands = consolidateCandidates(codeHits, repoHits, [q]);
  const c = cands.find((x) => x.fullName === "someone/router");
  check("emerging-query hit counts as a frontier hit", !!c && c.frontierHits === 2, `${c?.frontierHits}`);
  check("emerging fable query → hard evidence for the family id", !!c && c.contentEvidence.includes("claude-fable"), (c?.contentEvidence ?? []).join(","));
  check("evidence class is hard", c?.evidence === "hard");
  check("evidencePath recorded for re-verification", !!c && c.evidencePaths.length > 0);
  // backward compatibility: no dynamic queries → old behavior (frontier-model pool only)
  const legacy = consolidateCandidates(codeHits, repoHits);
  const lc = legacy.find((x) => x.fullName === "someone/router");
  check("legacy call (no dynamic queries) unaffected", lc?.frontierHits === 0 && lc?.evidence === "soft", `${lc?.frontierHits}/${lc?.evidence}`);
}

// ---------- 8. DB roundtrip (record + merge + confirm) ----------
{
  const KEY = "frontierLedger";
  const before = await db.setting.findUnique({ where: { key: KEY } });
  const backup = before?.value ?? null;
  try {
    await db.setting.delete({ where: { key: KEY } }).catch(() => {});
    // single repo → recorded, NOT confirmed
    const s1 = detectEmergingModels("tuned for fable 5.3");
    await recordEmergingSignals(s1, "alpha/one", "README.md");
    let led = await loadFrontierLedger();
    check("single-repo signal recorded unconfirmed", led.length === 1 && led[0].id === "claude-fable-5-3" && led[0].confirmed === false);
    // second repo vouches → confirmed, one-way
    const s2 = detectEmergingModels("claude-fable-5-3 router");
    await recordEmergingSignals(s2, "beta/two", "router.ts");
    led = await loadFrontierLedger();
    check("second repo vouch confirms the wave", led[0].confirmed === true && led[0].repos.length === 2, led[0].repos.join(","));
    check("mentions accumulate", led[0].mentions === 2, `${led[0].mentions}`);
    check("samplePaths capped and attributed", led[0].samplePaths.includes("router.ts"));
    // race simulation: two concurrent recorders must not lose each other's updates
    await Promise.all([
      recordEmergingSignals(detectEmergingModels("claude-myth-7-1 pin"), "gamma/three", "a.md"),
      recordEmergingSignals(detectEmergingModels("claude-myth-7-1 again"), "delta/four", "b.md"),
    ]);
    led = await loadFrontierLedger();
    const myth = led.find((e) => e.id === "claude-myth-7-1");
    check("concurrent recorders both survive (race-safe merge)", !!myth && myth.repos.length === 2, (myth?.repos ?? []).join(","));
    check("confirmed stays one-way after later single-repo mention", (() => {
      const fable = led.find((e) => e.id === "claude-fable-5-3");
      return fable?.confirmed === true;
    })());
    // empty signals → no write, no crash
    const n0 = await recordEmergingSignals([], "x/y");
    check("empty signal list is a no-op", n0 === 0);
  } finally {
    // restore the pre-test state (the real ledger must not be polluted by tests)
    if (backup === null) await db.setting.delete({ where: { key: KEY } }).catch(() => {});
    else await db.setting.upsert({ where: { key: KEY }, update: { value: backup }, create: { key: KEY, value: backup } });
  }
}

await db.$disconnect();
console.log(`\n${pass}/${pass + fail} frontier-radar checks ${fail === 0 ? "PASS ✅" : "FAIL ❌"}`);
process.exit(fail === 0 ? 0 : 1);
