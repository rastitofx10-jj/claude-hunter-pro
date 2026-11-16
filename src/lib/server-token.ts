import { db } from "@/lib/db";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";

// ============================================================
// Server-side GitHub token management
// Priority: request header ← environment variable ← token stored in the database
// Every request arriving with a structurally valid token is saved automatically
// (upsert) so the server can use it in future calls without the header.
// ============================================================

// round 8: exported — the key literal was duplicated in live-hunt.ts; renaming one
// side would silently orphan the other module's token path. One key, one source.
export const TOKEN_KEY = "github_pat";

/**
 * Round 14 — the durable token mirror.
 * Field fact (2026-11-14 ×2, 2026-11-15): the sandbox recycles and wipes
 * db/custom.db. The library self-heal (dna-restore.ts) restores genes, hunts,
 * sweeps and learning state — but NEVER the PAT ("not in the snapshot by
 * design"). Every recycle therefore silently reverted the app to token-less,
 * and "Start an autonomous live hunt" failed with 400 "No GitHub token"
 * until a human re-pasted the PAT — the exact recurring "failed to launch"
 * report. The cure: reports/state/ PROVED durable across all three recycles
 * (the 24MB dna-snapshot survived them), so the verified token is mirrored
 * there too and re-seeded into a wiped DB at boot. The mirror file is
 * .gitignored (like db/ and .env) — it must never be committed.
 * HUNTER_TOKEN_FILE overrides the path for the isolated test suite.
 */
export const TOKEN_FILE =
  process.env.HUNTER_TOKEN_FILE ?? path.join("reports", "state", "gh-token.txt");

/**
 * Round 15 — the upload fallback. Field fact (2026-11-16): the mirror itself
 * was missing after the latest recycle because the token had been persisted
 * BEFORE the mirror code existed (only persistToken writes the mirror, and
 * nobody re-stored the token after that deploy). The user's demonstrated
 * recovery pattern is uploading the PAT as a .secret file into upload/
 * (twice so far: token.secret, טוקן טיטפקס10.secret) — that folder proved
 * durable across every recycle. Restore chain: DB → mirror → newest
 * upload/*.secret. A live DB token is NEVER overwritten. When the heal came
 * from upload/, the mirror is written too — so the NEXT recycle heals from
 * the mirror without even needing the fallback.
 * HUNTER_UPLOAD_DIR overrides the path for the isolated test suite.
 */
export const UPLOAD_DIR = process.env.HUNTER_UPLOAD_DIR ?? "upload";

/**
 * Lenient validity check: GitHub itself is the source of truth (capture happens only after a 200 from GitHub),
 * so any reasonable string of suitable length is accepted — no strictness about prefixes that may change.
 */
export function looksLikeToken(t: string | null | undefined): t is string {
  if (!t) return false;
  const s = t.trim();
  if (s.length < 20 || s.length > 255) return false;
  if (/\s/.test(s)) return false;
  if (/^(null|undefined|test|token)$/i.test(s)) return false;
  return true;
}

/** The active token for a request: header ← env ← DB */
export async function resolveToken(req: NextRequest): Promise<string | null> {
  const header = req.headers.get("x-gh-token");
  if (header && header.trim()) return header.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const row = await db.setting.findUnique({ where: { key: TOKEN_KEY } });
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Server-side token WITHOUT an incoming request — for processes that run on
 * their own initiative (the scheduler, the autonomous daily cycle) and have
 * no client header to honor: env ← DB.
 */
export async function resolveServerToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const row = await db.setting.findUnique({ where: { key: TOKEN_KEY } });
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Writes the durable mirror (best effort — the DB stays the source of truth) */
async function writeTokenFile(t: string): Promise<void> {
  try {
    await mkdir(path.dirname(TOKEN_FILE), { recursive: true });
    await writeFile(TOKEN_FILE, t, { mode: 0o600 });
  } catch (e) {
    console.error(
      "[server-token] durable mirror write failed:",
      e instanceof Error ? e.message : e
    );
  }
}

/** Reads the mirror — null when absent/unreadable/structurally invalid */
async function readTokenFile(): Promise<string | null> {
  try {
    const t = (await readFile(TOKEN_FILE, "utf8")).trim();
    return looksLikeToken(t) ? t : null;
  } catch {
    return null;
  }
}

/** Newest-first scan of upload/*.secret — null when nothing valid is found */
async function readUploadFallbackToken(): Promise<string | null> {
  try {
    const entries = await readdir(UPLOAD_DIR, { withFileTypes: true });
    const names = entries
      .filter((e) => e.isFile() && /\.secret$/i.test(e.name))
      .map((e) => e.name);
    if (names.length === 0) return null;
    const withMtime = await Promise.all(
      names.map(async (name) => {
        const st = await stat(path.join(UPLOAD_DIR, name)).catch(() => null);
        return { name, mtime: st?.mtimeMs ?? 0 };
      })
    );
    withMtime.sort((a, b) => b.mtime - a.mtime); // freshest upload = the user's latest intent
    for (const { name } of withMtime) {
      const raw = (await readFile(path.join(UPLOAD_DIR, name), "utf8")).trim();
      if (looksLikeToken(raw)) return raw;
    }
    return null;
  } catch {
    return null;
  }
}

/** Saves a token to the database (only if structurally valid) + mirrors it durably */
export async function persistToken(token: string): Promise<boolean> {
  const t = token.trim();
  if (!looksLikeToken(t)) return false;
  // The mirror is written even if the DB write fails — when the DB comes back
  // (a recycle replaces it with a fresh file), restoreTokenFromFile() heals.
  await writeTokenFile(t);
  try {
    await db.setting.upsert({
      where: { key: TOKEN_KEY },
      create: { key: TOKEN_KEY, value: t },
      update: { value: t },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Transparent capture: if the request carried a structurally valid token — save it for server use.
 * Called only after a successful GitHub call (meaning the token also actually works).
 * A historical bug fixed here: resolveToken returns the request header itself when one is present —
 * so "current !== header" was always false, persistToken never ran, and all the
 * "capture" comments in the five routes were about a dead function. Now: the comparison is against
 * the value stored in the DB only (env cannot be updated at runtime — the header always wins over it).
 */
export async function captureTokenFrom(req: NextRequest): Promise<void> {
  const header = req.headers.get("x-gh-token");
  if (header && looksLikeToken(header)) {
    const t = header.trim();
    let stored: string | null = null;
    try {
      const row = await db.setting.findUnique({ where: { key: TOKEN_KEY } });
      stored = row?.value ?? null;
    } catch {
      stored = null;
    }
    if (stored !== t) await persistToken(t);
  }
}

/** Deletes the stored token (DB + durable mirror — a clear must clear both) */
export async function clearStoredToken(): Promise<void> {
  try {
    await db.setting.deleteMany({ where: { key: TOKEN_KEY } });
  } catch {
    // ignore
  }
  try {
    await unlink(TOKEN_FILE);
  } catch {
    // absent is the goal
  }
}

/**
 * Self-heal (round 14): if the DB lost the token (sandbox recycle/wipe) but the
 * durable mirror holds one — re-seed the DB. Idempotent and non-destructive:
 * a DB that already holds a token is NEVER overwritten (the mirror is a
 * backup, not an authority). Returns true only when a re-seed actually ran.
 * Called at boot (instrumentation.ts) and as the last-chance fallback inside
 * startLiveHunt's pre-flight. Never throws.
 */
export async function restoreTokenFromFile(): Promise<boolean> {
  try {
    const row = await db.setting.findUnique({ where: { key: TOKEN_KEY } });
    if (row?.value?.trim()) return false; // the DB already holds a token
    let t = await readTokenFile();
    let from = "durable mirror";
    if (!t) {
      t = await readUploadFallbackToken();
      from = "upload fallback (.secret)";
    }
    if (!t) return false; // nothing to heal from
    await db.setting.upsert({
      where: { key: TOKEN_KEY },
      create: { key: TOKEN_KEY, value: t },
      update: { value: t },
    });
    if (from !== "durable mirror") {
      // heal the mirror too — the next recycle recovers without the fallback
      await writeTokenFile(t);
    }
    console.log(
      `[server-token] token re-seeded from the ${from} — db/custom.db was recycled`
    );
    return true;
  } catch {
    return false;
  }
}

/** Masked display without exposing the full token */
export function maskToken(t: string | null | undefined): string | null {
  if (!t) return null;
  const s = t.trim();
  if (s.length <= 12) return "•".repeat(s.length);
  return `${s.slice(0, 7)}••••${s.slice(-4)}`;
}

export async function storedTokenInfo(): Promise<{
  exists: boolean;
  masked: string | null;
  updatedAt: Date | null;
}> {
  try {
    const row = await db.setting.findUnique({ where: { key: TOKEN_KEY } });
    return {
      exists: !!row,
      masked: row ? maskToken(row.value) : null,
      updatedAt: row?.updatedAt ?? null,
    };
  } catch {
    return { exists: false, masked: null, updatedAt: null };
  }
}
