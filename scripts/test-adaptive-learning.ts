// test-adaptive-learning.ts — validates the v1.1 learning-loop fixes:
//  1. Zero-yield demotion: an executed-but-unproductive query must lose weight
//     (before: it kept the never-run 0.5 forever — the ledger was half-blind).
//  2. Yield attribution merge: productive queries accumulate runs+genes.
//  3. Laplace math: proven > neutral > demoted.
//  4. Snapshot roundtrip: learningState survives export + restore (missing-row fill).
//  5. Errored queries are NOT demoted (caller's responsibility — verified by contract).
// Pure-function parts run without a DB; the DB parts run against the live DB and
// clean up after themselves.
import { normalizeQueryKey, yieldWeight, rankByYield } from "../src/lib/adaptive-learning";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`PASS | ${name}${detail ? ` | ${detail}` : ""}`); }
  else { fail++; console.log(`FAIL | ${name}${detail ? ` | ${detail}` : ""}`); }
};

// ---------- 1. Laplace math + demotion ----------
{
  const stats = {
    "proven query": { runs: 4, genes: 20, lastRun: "x" },
    "sterile query": { runs: 3, genes: 0, lastRun: "x" },
  };
  const wProven = yieldWeight("proven query", stats);
  const wSterile = yieldWeight("sterile query", stats);
  const wUnseen = yieldWeight("never ran", stats);
  check("proven query outranks neutral", wProven > 0.5, `${wProven.toFixed(2)} > 0.5`);
  check("sterile query demoted below neutral", wSterile < 0.5, `${wSterile.toFixed(2)} < 0.5 (the docstring's 0.2 promise now real)`);
  check("ranking order proven > unseen > sterile",
    JSON.stringify(rankByYield([{ q: "sterile query" }, { q: "proven query" }, { q: "never ran" }], stats).map((x) => x.q)) ===
    JSON.stringify(["proven query", "never ran", "sterile query"]),
    "proven 3.5 > unseen 0.5 > sterile 0.2");
}

// ---------- 2. normalizeQueryKey ----------
{
  const a = normalizeQueryKey('claude opus 4.5 stars:>3 pushed:>2026-11-01');
  const b = normalizeQueryKey('claude opus 4.5 stars:>3 pushed:>2026-11-12');
  check("date-normalized keys match across days", a === b, a);
  check("lowercase normalization", normalizeQueryKey("Opus 4.5") === normalizeQueryKey("opus 4.5"));
}

// ---------- 3. DB roundtrip: record + merge + race-safety ----------
{
  const { db } = await import("../src/lib/db");
  const KEY = "queryYieldStats";
  const TQ1 = "test-yield-query-alpha created:>2026-01-01";
  const TQ2 = "test-yield-query-beta created:>2026-01-01";
  // save the original row, run the test, restore it
  const orig = await db.setting.findUnique({ where: { key: KEY } });
  try {
    // simulate: run 1 — query1 yields 5 genes, query2 executes clean with 0
    const { recordQueryYields } = await import("../src/lib/adaptive-learning");
    await recordQueryYields({ [TQ1]: 5 }, [TQ1, TQ2]);
    let row = JSON.parse((await db.setting.findUnique({ where: { key: KEY } }))!.value);
    check("run 1: productive query recorded", row[normalizeQueryKey(TQ1)]?.genes === 5 && row[normalizeQueryKey(TQ1)]?.runs === 1);
    check("run 1: zero-yield query got its run counted (demotion seed)", row[normalizeQueryKey(TQ2)]?.runs === 1 && row[normalizeQueryKey(TQ2)]?.genes === 0);

    // simulate: run 2 — two CONCURRENT recorders (the hunt+sweep race)
    await Promise.all([
      recordQueryYields({ [TQ1]: 3 }, [TQ1]),
      recordQueryYields({ [TQ2]: 7 }, [TQ2]),
    ]);
    row = JSON.parse((await db.setting.findUnique({ where: { key: KEY } }))!.value);
    check("race: both concurrent updates survived (no last-writer-wins loss)",
      row[normalizeQueryKey(TQ1)]?.runs === 2 && row[normalizeQueryKey(TQ1)]?.genes === 8 &&
      row[normalizeQueryKey(TQ2)]?.runs === 2 && row[normalizeQueryKey(TQ2)]?.genes === 7,
      `q1=${JSON.stringify(row[normalizeQueryKey(TQ1)])} q2=${JSON.stringify(row[normalizeQueryKey(TQ2)])}`);

    // ---------- 4. snapshot roundtrip ----------
    const { writeDnaSnapshot } = await import("../src/lib/dna-snapshot");
    await writeDnaSnapshot();
    const snap = JSON.parse(await Bun.file("reports/state/dna-snapshot.json").text());
    check("snapshot carries learningState", !!snap.learningState?.queryYieldStats, `keys=${Object.keys(snap.learningState ?? {})}`);
    check("snapshot never carries the PAT", !snap.learningState?.github_pat && JSON.stringify(snap).indexOf("github_pat") === -1);
    // restore semantics: missing row gets filled, existing row is NOT clobbered
    const before = JSON.parse((await db.setting.findUnique({ where: { key: KEY } }))!.value);
    delete before[normalizeQueryKey(TQ2)]; // simulate losing one entry (a wipe)
    await db.setting.update({ where: { key: KEY }, data: { value: JSON.stringify(before) } });
    const { execSync } = await import("node:child_process");
    execSync("node scripts/dna-restore.mjs", { cwd: process.cwd(), stdio: "pipe" });
    const afterRestore = JSON.parse((await db.setting.findUnique({ where: { key: KEY } }))!.value);
    check("restore refuses to clobber the live (newer) learning row", afterRestore[normalizeQueryKey(TQ2)] === undefined);
    // now the true post-recycle case: row absent entirely → restore must fill it
    await db.setting.delete({ where: { key: KEY } });
    execSync("node scripts/dna-restore.mjs", { cwd: process.cwd(), stdio: "pipe" });
    const afterWipeRestore = JSON.parse((await db.setting.findUnique({ where: { key: KEY } }))!.value);
    check("post-recycle restore refills the learning row from the snapshot",
      afterWipeRestore[normalizeQueryKey(TQ1)]?.genes === 8);
  } finally {
    // restore the original state (or delete the test row if there was none)
    if (orig) await db.setting.update({ where: { key: KEY }, data: { value: orig.value } });
    else await db.setting.deleteMany({ where: { key: KEY } });
    await db.$disconnect();
  }
}

console.log(fail === 0 ? `ALL_ADAPTIVE_LEARNING_TESTS_PASS (${pass} checks)` : `FAILURES: ${fail}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
