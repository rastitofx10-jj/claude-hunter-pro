import { db } from "@/lib/db";
import type { NextRequest } from "next/server";

// ============================================================
// Server-side GitHub token management
// Priority: request header ← environment variable ← token stored in the database
// Every request arriving with a structurally valid token is saved automatically
// (upsert) so the server can use it in future calls without the header.
// ============================================================

const TOKEN_KEY = "github_pat";
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

/** Saves a token to the database (only if structurally valid) */
export async function persistToken(token: string): Promise<boolean> {
  const t = token.trim();
  if (!looksLikeToken(t)) return false;
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

/** Deletes the stored token */
export async function clearStoredToken(): Promise<void> {
  try {
    await db.setting.deleteMany({ where: { key: TOKEN_KEY } });
  } catch {
    // ignore
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
