/**
 * Vercel Edge Middleware — hosts the dashboard on Vercel in front of the Worker.
 *
 * The SPA in ./public is served as static files by Vercel; every dashboard API
 * path is transparently proxied (a server-side rewrite, not a redirect) to the
 * Cloudflare Worker named in PERSONXAI_WORKER_URL. The browser only ever sees
 * the Vercel origin, so the session cookie the Worker sets lands on this
 * domain, and the Worker accepts the requests because ALLOWED_ORIGINS and
 * PUBLIC_BASE_URL name it (docs/VERCEL.md).
 *
 * Webhooks (/channels/*), /dispatch and /admin/* are deliberately NOT proxied:
 * providers talk to the Worker directly.
 */
import { rewrite, next } from "@vercel/edge";

export const config = {
  matcher: ["/api/:path*", "/auth/:path*", "/mcp", "/mcp/:path*", "/health"],
};

export default function middleware(request) {
  const worker = (process.env.PERSONXAI_WORKER_URL || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(worker)) {
    return new Response(
      JSON.stringify({ error: "PERSONXAI_WORKER_URL is not set on this Vercel project" }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, worker);
  const headers = new Headers();
  // Tell the Worker which public host the browser is on; it is informational —
  // origin trust comes from ALLOWED_ORIGINS, not from these headers.
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  return target.href ? rewrite(target, { request: { headers } }) : next();
}
