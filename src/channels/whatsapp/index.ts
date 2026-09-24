/**
 * WhatsApp ChannelAdapter wiring (WhatsApp Cloud API / Meta Graph API).
 *
 * Unlike Telegram there is nothing to "register" from code: the webhook URL
 * and verify token are entered once in the Meta developer dashboard, which
 * then performs the GET handshake handled here. See docs/WHATSAPP.md.
 */
import type { Env } from "../../env";
import type { ChannelAdapter, IncomingMessage } from "../types";
import type { WhatsAppCredentials } from "./api";
import { parseWhatsAppUpdate } from "./normalize";
import { WhatsAppOutbound } from "./send";
import { handleWhatsAppHandshake, verifyWhatsAppSignature } from "./webhook";

/** Credentials for outbound calls, or null when the channel is not set up. */
export function whatsAppCredentials(env: Env): WhatsAppCredentials | null {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return null;
  const creds: WhatsAppCredentials = {
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  };
  if (env.WHATSAPP_API_VERSION) creds.apiVersion = env.WHATSAPP_API_VERSION;
  return creds;
}

export function isWhatsAppConfigured(env: Env): boolean {
  return whatsAppCredentials(env) !== null && !!env.WHATSAPP_APP_SECRET && !!env.WHATSAPP_VERIFY_TOKEN;
}

export const whatsappAdapter: ChannelAdapter = {
  name: "whatsapp",
  isConfigured: isWhatsAppConfigured,
  handshake: (_req: Request, env: Env, url: URL) =>
    env.WHATSAPP_VERIFY_TOKEN ? handleWhatsAppHandshake(url, env.WHATSAPP_VERIFY_TOKEN) : null,
  verifyWebhook: (req: Request, env: Env, rawBody: string) =>
    env.WHATSAPP_APP_SECRET
      ? verifyWhatsAppSignature(rawBody, req.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET)
      : false,
  parseUpdate: parseWhatsAppUpdate,
  outbound: (env: Env, incoming?: IncomingMessage) => {
    const creds = whatsAppCredentials(env);
    if (!creds) {
      throw new Error("WhatsApp is not configured (set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID)");
    }
    const inbound = incoming
      ? { chatRef: incoming.externalChatId, messageId: incoming.externalMessageId }
      : undefined;
    return new WhatsAppOutbound(creds, env.TELEGRAM_BOT_TOKEN, inbound);
  },
};
