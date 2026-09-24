/**
 * The one thing both the Telegram adapter and the bot registry need.
 *
 * It lives in its own module on purpose: `channels/bots.ts` imports the
 * Telegram adapter (to register a webhook and a command menu), so if the
 * adapter imported the registry back for this helper the two would form a
 * cycle. Nothing here imports anything but a type.
 */
import type { Env } from "../env";

/**
 * The Telegram token for the bot this env represents.
 *
 * The token became optional when bot tokens moved into the database, so every
 * caller that genuinely cannot proceed without one goes through here and the
 * failure reads as "no bot is set up yet" rather than a Telegram 404 on
 * `/bot/undefined`.
 */
export function requireBotToken(env: Env): string {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("no Telegram bot is configured — add one on the dashboard's Bots page");
  }
  return token;
}
