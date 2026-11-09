import { NextRequest, NextResponse } from "next/server";

/**
 * Same-origin protection for mutation requests (POST/PUT/PATCH/DELETE) to the API.
 *
 * Why: the app has no login system — the GitHub PAT is stored server-side and is used
 * automatically by all API routes. Without this protection layer, any malicious site the
 * tool owner visits could send cross-origin requests from their browser (CSRF) and run hunts/mining
 * on the PAT's API quota — and even delete the stored token.
 *
 * How: a browser always sends an Origin header on mutation requests. If Origin exists and does not
 * match the Host — immediate block. Requests without Origin (curl/scripts/server-side
 * tools) carry no CSRF risk and continue as usual, so external automation
 * and the existing workflow are not broken.
 */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function middleware(req: NextRequest) {
  if (!MUTATION_METHODS.has(req.method)) return NextResponse.next();

  const origin = req.headers.get("origin");
  if (!origin) return NextResponse.next(); // non-browser client — no CSRF risk

  const host = req.headers.get("host");
  try {
    if (host && new URL(origin).host === host) return NextResponse.next();
  } catch {
    // Corrupted Origin — treated as hostile
  }
  return NextResponse.json(
    { error: "Cross-Origin blocked: mutation requests are allowed from the same origin only" },
    { status: 403 }
  );
}

export const config = {
  matcher: "/api/:path*",
};
