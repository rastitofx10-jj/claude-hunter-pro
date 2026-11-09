import { NextRequest, NextResponse } from "next/server";
import { ghFetch, GhError } from "@/lib/github";
import { clearStoredToken, looksLikeToken, persistToken, storedTokenInfo } from "@/lib/server-token";

export const dynamic = "force-dynamic";

/** Status of the token stored on the server — agreed-upon, without exposure */
export async function GET() {
  const info = await storedTokenInfo();
  return NextResponse.json(info);
}

/** Save + validate against GitHub before accepting */
export async function POST(req: NextRequest) {
  let token = "";
  try {
    const body = (await req.json()) as { token?: string };
    token = (body.token ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!looksLikeToken(token)) {
    return NextResponse.json(
      { error: "Unrecognized token format — expected github_pat_... or ghp_..." },
      { status: 400 }
    );
  }
  // Real validation against GitHub
  try {
    await ghFetch("/rate_limit", token);
  } catch (e) {
    // 401/403 = the token was genuinely rejected. Anything else (network/busy hour/foreign network) is not
    // the token's fault — previously every failure was mapped to a 401 "token rejected" and misled the user.
    if (e instanceof GhError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({ error: `Token rejected: ${e.message}` }, { status: 401 });
    }
    console.error("settings/token POST verification failed", e);
    return NextResponse.json({ error: "Verification against GitHub failed (network error — not a token problem)" }, { status: 502 });
  }
  const ok = await persistToken(token);
  if (!ok) return NextResponse.json({ error: "Saving on the server failed" }, { status: 500 });
  const info = await storedTokenInfo();
  return NextResponse.json({ ok: true, ...info });
}

/** Remove the stored token */
export async function DELETE() {
  await clearStoredToken();
  return NextResponse.json({ ok: true });
}
