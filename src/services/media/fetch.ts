/**
 * Channel-aware media byte fetching. This is the one service seam that knows
 * which channel a MediaRef came from (like the vault, it is infrastructure —
 * the agent core stays channel-agnostic).
 */
import type { Env } from "../../env";
import type { MediaRef } from "../../channels/types";
import { downloadTelegramFile } from "../../channels/telegram/api";
import { downloadWhatsAppMedia } from "../../channels/whatsapp/api";
import { whatsAppCredentials } from "../../channels/whatsapp";

export const MAX_FETCH_BYTES = 20 * 1024 * 1024; // Telegram Bot API getFile hard cap

export async function fetchMediaBytes(
  env: Env,
  media: MediaRef,
  maxBytes = MAX_FETCH_BYTES
): Promise<{ data: ArrayBuffer; mime: string } | { error: "too_large" | "failed" | "unsupported_channel" }> {
  if (media.channel === "telegram") {
    const fileId = media.ref["file_id"];
    if (typeof fileId !== "string") return { error: "failed" };
    const result = await downloadTelegramFile(env.TELEGRAM_BOT_TOKEN, fileId, maxBytes);
    if ("error" in result) return { error: result.error };
    return { data: result.data, mime: result.mime ?? media.mimeType };
  }
  if (media.channel === "whatsapp") {
    const creds = whatsAppCredentials(env);
    const mediaId = media.ref["media_id"];
    if (!creds || typeof mediaId !== "string") return { error: "failed" };
    const result = await downloadWhatsAppMedia(creds, mediaId, maxBytes);
    if ("error" in result) return { error: result.error };
    return { data: result.data, mime: result.mime ?? media.mimeType };
  }
  return { error: "unsupported_channel" };
}
