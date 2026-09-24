/**
 * Signed, stateless tokens for the web dashboard.
 *
 * Two token purposes share one secret but are domain-separated by a prefix in
 * the signed message, so a magic-link token can never be replayed as a session
 * cookie (or vice versa), and neither collides with the dispatch bearer.
 *
 * The secret is WEB_SESSION_SECRET when set, else DISPATCH_SECRET — the worker
 * already requires the latter, so the dashboard needs no new configuration.
 */
import type { Env } from "../env";
import { constantTimeEquals } from "../channels/telegram/webhook";

export type TokenPurpose = "magic" | "session" | "mcp";

export interface MagicPayload {
  /** user id (uuid) */
  u: string;
  /** single-use nonce, matched against the row stored in settings */
  n: string;
  /** expiry, epoch seconds */
  e: number;
}

export interface SessionPayload {
  u: string;
  e: number;
  /** issued at, epoch seconds */
  i: number;
}

/**
 * Bearer token for the MCP server surface (src/mcp/server). Carries the same
 * user + expiry as a session, plus a rotation nonce (checked against the row in
 * `settings`, so a token can be revoked) and the scope it was minted with.
 */
export interface McpPayload {
  u: string;
  e: number;
  /** issued at, epoch seconds */
  i: number;
  /** rotation nonce — matched against settings["mcp.access"] */
  n: string;
  /** "read" (read-level tools only) or "full" (everything the role allows) */
  s: string;
}

/** The fields every minted token shares; enough for verifyToken to do its job. */
export type AnyTokenPayload = MagicPayload | SessionPayload | McpPayload;

export const MAGIC_TTL_SECONDS = 10 * 60;
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const SESSION_COOKIE = "pxa_session";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function webSecret(env: Env): string {
  const secret = env.WEB_SESSION_SECRET || env.DISPATCH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("web dashboard requires WEB_SESSION_SECRET (or DISPATCH_SECRET) of >= 16 chars");
  }
  return secret;
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(value: string): Uint8Array | null {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function sign(secret: string, purpose: TokenPurpose, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  // The purpose is inside the signed message, not the key, so the same secret
  // yields disjoint signature spaces per purpose.
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`pxa.${purpose}.v1.${body}`));
  return b64urlFromBytes(new Uint8Array(mac));
}

export async function mintToken(
  secret: string,
  purpose: TokenPurpose,
  payload: AnyTokenPayload
): Promise<string> {
  const body = b64urlFromBytes(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await sign(secret, purpose, body)}`;
}

/** Verify signature and expiry. Returns null on any failure — never throws. */
export async function verifyToken<T extends AnyTokenPayload>(
  secret: string,
  purpose: TokenPurpose,
  token: string | null | undefined,
  nowMs: number
): Promise<T | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = await sign(secret, purpose, body);
  if (!constantTimeEquals(expected, signature)) return null;

  const raw = bytesFromB64url(body);
  if (!raw) return null;
  let payload: T;
  try {
    payload = JSON.parse(decoder.decode(raw)) as T;
  } catch {
    return null;
  }
  if (typeof payload?.u !== "string" || typeof payload?.e !== "number") return null;
  if (payload.e * 1000 <= nowMs) return null;
  return payload;
}

export function randomNonce(): string {
  return b64urlFromBytes(crypto.getRandomValues(new Uint8Array(24)));
}

/** Read one cookie from a request without pulling in a parser. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Session cookie. `Secure` is omitted on plain-http origins so `wrangler dev`
 * on localhost still works; every real deployment is https.
 */
export function sessionCookie(value: string, url: URL, maxAgeSeconds: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearedSessionCookie(url: URL): string {
  return sessionCookie("", url, 0);
}
