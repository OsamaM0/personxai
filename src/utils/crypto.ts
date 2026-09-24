/**
 * Channel-neutral secret handling shared by every webhook verifier and token
 * check. Lives outside channels/ so the web, MCP and dispatcher layers do not
 * have to import from the Telegram adapter to compare a secret.
 *
 * constantTimeEquals ported from ref/openmemo/supabase/functions/_shared/telegram.ts.
 */

/**
 * Compare two strings without leaking the mismatch position through timing.
 * XOR-accumulates code points over max(len); false when either side is missing.
 */
export function constantTimeEquals(
  a: string | undefined | null,
  b: string | undefined | null
): boolean {
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? (a.codePointAt(i) ?? 0) : 0;
    const cb = i < b.length ? (b.codePointAt(i) ?? 0) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

const encoder = new TextEncoder();

/** Lowercase hex HMAC-SHA256 of `data` under `secret` (WebCrypto, works in Workers and Node). */
export async function hmacSha256Hex(secret: string, data: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
  const sig = await crypto.subtle.sign("HMAC", key, bytes);
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
