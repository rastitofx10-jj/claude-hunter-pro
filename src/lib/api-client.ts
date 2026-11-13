"use client";

/**
 * Sentinel: "the token lives on the server" — the client never holds it.
 * When the token is the sentinel (or empty) we do not send the x-gh-token header,
 * and the server resolves the token on its own from the DB (server-token.resolveToken).
 */
export const SERVER_TOKEN = "@server";

export function isServerToken(t: string | null | undefined): boolean {
  return !t || !t.trim() || t.trim() === SERVER_TOKEN;
}

// Small fetch wrapper: attaches GitHub token header + JSON error handling
export async function apiFetch<T>(
  url: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  // Explicit Record<string,string> — the previous type union with {"x-gh-token"?: undefined}
  // broke the typecheck (TS2769), hidden by ignoreBuildErrors.
  const authHeaders: Record<string, string> = isServerToken(token) ? {} : { "x-gh-token": token.trim() };
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
      ...(init?.headers || {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || data?.error) {
    // The full error body is attached to the Error — the live-hunt pump reads the
    // failed hunt's state from it (payload.hunt) and stops instead of running in
    // an infinite loop.
    // Previously: the route attached the state in the response body, but the wrapper
    // threw it away before anyone could read it.
    const err = new Error(data?.error || `Error ${res.status}`);
    throw Object.assign(err, { payload: data as unknown, status: res.status });
  }
  return data as T;
}

// Client-side duplicate of repo input parsing (owner/repo or full URL)
export function parseRepoInputClient(
  raw: string
): { owner: string; repo: string } | null {
  if (!raw) return null;
  let s = raw.trim().replace(/\.git$/i, "");
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/^github\.com\//i, "");
  s = s.split(/[?#]/)[0].replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

export function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Round 9 — revoke LATE: revoking synchronously right after the synthetic click
  // can abort the just-started download in Firefox/Safari (Chrome tolerates it).
  // 30s covers any export this app generates; the leak window is bounded either way.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}
