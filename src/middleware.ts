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
 *
 * round 8: GET was exempted wholesale — but GET /api/analyze is a side-effectful,
 * quota-burning route (~25 authenticated GitHub calls + 2 DB writes per hit): a page of
 * hidden <img src="http://host/api/analyze?owner=a&repo=b"> tags drained the shared
 * 5,000/h quota. <img> never sends Origin, but browsers DO send Referer on subresource
 * loads by default — so for these expensive GETs a cross-origin Referer is blocked too
 * (same-origin pages and header-less scripts keep working).
 */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXPENSIVE_GET_PATHS = new Set(["/api/analyze"]);

function sameOriginValue(headerValue: string | null, host: string | null): boolean | null {
  // null → header absent (cannot judge); true → matches; false → cross-origin
  if (!headerValue) return null;
  try {
    const origin = new URL(headerValue).origin;
    if (!host) return false;
    const hostOrigin = new URL(`http://${host}`).origin;
    return origin === hostOrigin || origin === `http://${host}` || origin === `https://${host}`;
  } catch {
    return false; // corrupted value — treated as hostile
  }
}

export function middleware(req: NextRequest) {
  const host = req.headers.get("host");

  if (MUTATION_METHODS.has(req.method)) {
    const originOk = sameOriginValue(req.headers.get("origin"), host);
    if (originOk === null) return NextResponse.next(); // non-browser client — no CSRF risk
    if (originOk === true) return NextResponse.next();
    return NextResponse.json(
      { error: "Cross-Origin blocked: mutation requests are allowed from the same origin only" },
      { status: 403 }
    );
  }

  // expensive side-effectful GETs: Origin check (fetch/XHR) + Referer check (<img>/<script> tags)
  const path = new URL(req.url).pathname;
  if (EXPENSIVE_GET_PATHS.has(path)) {
    const originOk = sameOriginValue(req.headers.get("origin"), host);
    const refererOk = sameOriginValue(req.headers.get("referer"), host);
    if (originOk === false || refererOk === false) {
      return NextResponse.json(
        { error: "Cross-Origin blocked: this operation is allowed from the same origin only" },
        { status: 403 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
