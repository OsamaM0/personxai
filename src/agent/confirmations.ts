/**
 * Pending-confirmation store (token indirection for inline buttons).
 *
 * Telegram callback_data is capped at 64 bytes, so button payloads never carry
 * entity data — only a short token. The full payload lives in the DO's SQLite
 * `callbacks` table, one-shot with a TTL.
 *
 * Callback data wire format: `v1:<kind>:<token>:<verb>` (e.g. v1:cfm:Ab3dEf78:y)
 */
import { nanoid } from "nanoid";
import type { SqlExecutor } from "./do-schema";

export const CALLBACK_TTL_MS = 10 * 60 * 1000;

export interface PendingCallback<T = unknown> {
  token: string;
  kind: string;
  payload: T;
}

export function createCallbackToken<T>(
  a: SqlExecutor,
  kind: string,
  payload: T,
  now: number,
  ttlMs = CALLBACK_TTL_MS
): string {
  const token = nanoid(10);
  a.sql`INSERT INTO callbacks (token, kind, payload, created_at, expires_at)
    VALUES (${token}, ${kind}, ${JSON.stringify(payload)}, ${now}, ${now + ttlMs})`;
  return token;
}

/** One-shot consume: returns the payload only the first time, null if missing/expired/used. */
export function consumeCallbackToken<T = unknown>(
  a: SqlExecutor,
  token: string,
  now: number
): PendingCallback<T> | null {
  const rows = a.sql<{ token: string; kind: string; payload: string; expires_at: number; consumed: number }>`
    SELECT token, kind, payload, expires_at, consumed FROM callbacks WHERE token = ${token}`;
  const row = rows[0];
  if (!row || row.consumed === 1 || row.expires_at < now) return null;
  a.sql`UPDATE callbacks SET consumed = 1 WHERE token = ${token}`;
  a.sql`DELETE FROM callbacks WHERE expires_at < ${now}`;
  try {
    return { token: row.token, kind: row.kind, payload: JSON.parse(row.payload) as T };
  } catch {
    return null;
  }
}

/** Clear all pending confirmations (the /cancel command). Returns how many were live. */
export function clearPendingCallbacks(a: SqlExecutor, now: number): number {
  const live = a.sql<{ n: number }>`
    SELECT COUNT(*) as n FROM callbacks WHERE consumed = 0 AND expires_at >= ${now}`;
  a.sql`DELETE FROM callbacks`;
  return live[0]?.n ?? 0;
}

export interface DecodedCallback {
  version: string;
  kind: string;
  token: string;
  verb: string;
}

export function encodeCallbackData(kind: string, token: string, verb: string): string {
  const data = `v1:${kind}:${token}:${verb}`;
  if (new TextEncoder().encode(data).length > 64) {
    throw new Error(`callback data exceeds 64 bytes: ${data.length} chars`);
  }
  return data;
}

export function decodeCallbackData(data: string): DecodedCallback | null {
  const parts = data.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [version, kind, token, verb] = parts;
  if (!kind || !token || !verb) return null;
  return { version: version as string, kind, token, verb };
}
