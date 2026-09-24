/**
 * WhatsApp Cloud API webhook authenticity.
 *
 * Two mechanisms, both from Meta's webhook contract:
 *   - GET handshake on subscription: ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
 *     must echo hub.challenge when the verify token matches.
 *   - Every POST carries X-Hub-Signature-256: sha256=<hex HMAC of the raw body
 *     under the app secret>. The body must be verified as received — any
 *     re-serialisation changes the bytes and breaks the signature.
 */
import { constantTimeEquals, hmacSha256Hex } from "../../utils/crypto";

/** Respond to Meta's subscription handshake; null when the request is not one. */
export function handleWhatsAppHandshake(url: URL, verifyToken: string): Response | null {
  const mode = url.searchParams.get("hub.mode");
  const challenge = url.searchParams.get("hub.challenge");
  const token = url.searchParams.get("hub.verify_token");
  if (mode !== "subscribe" || challenge === null) return null;
  if (!constantTimeEquals(verifyToken, token)) {
    return new Response("forbidden", { status: 403 });
  }
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

/** True when `header` is a valid `sha256=<hex>` signature of `rawBody` under `appSecret`. */
export async function verifyWhatsAppSignature(
  rawBody: string,
  header: string | null,
  appSecret: string
): Promise<boolean> {
  if (!header || !appSecret) return false;
  const received = header.startsWith("sha256=") ? header.slice(7).toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return constantTimeEquals(expected, received);
}
