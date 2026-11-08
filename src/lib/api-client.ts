"use client";

/**
 * Sentinel: "הטוקן נמצא בשרת" — הלקוח לא מחזיק אותו.
 * כשה-token הוא ה-sentinel (או ריק) אנחנו לא שולחים כותרת x-gh-token,
 * והשרת פותר את הטוקן לבד מה-DB (server-token.resolveToken).
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
  // Record<string,string> מפורש — בעבר איחוד הסוגים עם {"x-gh-token"?: undefined}
  // הפיל את ה-typecheck (TS2769) שהוסתר ע"י ignoreBuildErrors.
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
    throw new Error(data?.error || `שגיאה ${res.status}`);
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
  URL.revokeObjectURL(url);
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
