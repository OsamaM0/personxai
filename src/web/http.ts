/**
 * Minimal request/response helpers for the dashboard API. Deliberately tiny —
 * the worker stays dependency-free on the HTTP layer.
 */

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = "not found") => new HttpError(404, msg);
export const unauthorized = (msg = "not signed in") => new HttpError(401, msg);

/** Parse a JSON body, rejecting anything that is not a plain object. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw badRequest("expected content-type: application/json");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw badRequest("body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Same-origin guard for state-changing requests. SameSite=Lax already blocks
 * the cookie on cross-site form posts; this rejects the fetch-based cases too.
 *
 * `Origin: null` is not proof of a cross-site request: the Fetch spec serialises
 * the header as "null" for a same-origin POST whenever the document's referrer
 * policy is `no-referrer`, and sandboxed or redirect-laundered contexts do the
 * same. Fall back to `Sec-Fetch-Site`, which browsers set from the actual
 * relationship and which no referrer policy can rewrite.
 */
export function assertSameOrigin(
  request: Request,
  url: URL,
  allowedOrigins: readonly string[] = []
): void {
  const origin = request.headers.get("origin");
  if (!origin || origin === url.origin) return;

  if (origin === "null" && request.headers.get("sec-fetch-site") === "same-origin") return;

  // A dashboard hosted on another origin (Vercel in front of the Worker,
  // docs/VERCEL.md) is opted in explicitly through ALLOWED_ORIGINS.
  if (allowedOrigins.includes(origin)) return;

  throw new HttpError(403, "cross-origin request rejected");
}

/**
 * Match `pattern` (with `:name` segments) against a pathname.
 * Returns the captured params, or null when the shape does not match.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = pathname.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] ?? "";
    const g = got[i] ?? "";
    if (w.startsWith(":")) {
      if (!g) return null;
      params[w.slice(1)] = decodeURIComponent(g);
      continue;
    }
    if (w !== g) return null;
  }
  return params;
}

// ── Field coercion ───────────────────────────────────────────────────────────
// Bodies come from a browser, so every field is validated before it reaches a
// repo. `undefined` means "not supplied"; `null` means "clear this column".

export function str(body: Record<string, unknown>, key: string, max = 10_000): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw badRequest(`${key} must be a string`);
  if (v.length > max) throw badRequest(`${key} exceeds ${max} characters`);
  return v;
}

export function requiredStr(body: Record<string, unknown>, key: string, max = 10_000): string {
  const v = str(body, key, max);
  if (v === undefined || v.trim() === "") throw badRequest(`${key} is required`);
  return v;
}

export function nullableStr(
  body: Record<string, unknown>,
  key: string,
  max = 100_000
): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw badRequest(`${key} must be a string or null`);
  if (v.length > max) throw badRequest(`${key} exceeds ${max} characters`);
  return v;
}

export function num(body: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`${key} must be a number between ${min} and ${max}`);
  }
  return n;
}

export function bool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw badRequest(`${key} must be a boolean`);
  return v;
}

export function strArray(body: Record<string, unknown>, key: string, max = 40): string[] | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw badRequest(`${key} must be an array of strings`);
  if (v.length > max) throw badRequest(`${key} accepts at most ${max} entries`);
  return v.map((item) => {
    if (typeof item !== "string") throw badRequest(`${key} must be an array of strings`);
    return item.trim();
  }).filter((item) => item.length > 0);
}

/** Validate a value against a fixed enum list. */
export function oneOf<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw badRequest(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

/** ISO timestamp, or null to clear. Rejects unparseable input rather than storing it. */
export function isoDate(body: Record<string, unknown>, key: string): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw badRequest(`${key} must be an ISO timestamp or null`);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw badRequest(`${key} is not a valid timestamp`);
  return new Date(ms).toISOString();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(body: Record<string, unknown>, key: string): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !UUID_RE.test(v)) throw badRequest(`${key} must be a uuid`);
  return v;
}

export function assertUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw badRequest(`${label} must be a uuid`);
  return value;
}

/** Numeric query param with a hard ceiling so the browser cannot ask for the whole table. */
export function queryLimit(url: URL, fallback: number, max: number): number {
  const raw = url.searchParams.get("limit");
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** Drop keys whose value is `undefined` so a PATCH only touches supplied fields. */
export function definedOnly<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
