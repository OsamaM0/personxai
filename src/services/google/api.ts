/**
 * Thin fetch wrapper for Google's REST APIs.
 *
 * Every call carries a bearer token minted by services/google/oauth, a timeout,
 * and an error shape that names the API and status without echoing the token.
 */
import { log } from "../../utils/logger";

const CALL_TIMEOUT_MS = 15_000;

export class GoogleApiError extends Error {
  status: number;
  api: string;

  constructor(api: string, status: number, detail?: string) {
    super(`Google ${api} failed (${status})${detail ? `: ${detail}` : ""}`);
    this.name = "GoogleApiError";
    this.status = status;
    this.api = api;
  }
}

interface GoogleErrorBody {
  error?: { message?: string; status?: string };
}

export interface GoogleRequest {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Query parameters; undefined/empty values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * Call a Google endpoint. `api` is a short label used in errors and logs
 * ("gmail.messages.list"), never the URL, which can carry mail subjects.
 */
export async function googleFetch<T>(
  accessToken: string,
  api: string,
  url: string,
  req: GoogleRequest = {}
): Promise<T> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value === undefined || value === "") continue;
    target.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (req.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(target, {
    method: req.method ?? "GET",
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as GoogleErrorBody | null;
    log("warn", "google.api_error", { api, status: res.status });
    throw new GoogleApiError(api, res.status, detail?.error?.message);
  }
  // 204 on delete: nothing to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** base64url → text. Gmail encodes every body part this way. */
export function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/** text → base64url, the encoding Gmail's send endpoint wants for raw RFC 822. */
export function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
