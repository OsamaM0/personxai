/**
 * Telegram webhook authenticity check.
 *
 * Ported from ref/openmemo/supabase/functions/_shared/telegram.ts
 * (constantTimeEquals / verifySecret) — the secret is passed in instead of
 * being read from Deno.env. The comparison itself now lives in utils/crypto so
 * other channels and the web layer share one implementation; it is re-exported
 * here for existing imports.
 */
import { constantTimeEquals } from "../../utils/crypto";

export { constantTimeEquals };

/** True when the request carries the secret Telegram was registered with. */
export function verifyTelegramWebhook(req: Request, secret: string): boolean {
  const received = req.headers.get("x-telegram-bot-api-secret-token");
  return constantTimeEquals(secret, received);
}
