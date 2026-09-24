/**
 * Telegram-channel file vault (pattern from TeleFileBot-CloudFlare):
 * forward the user's message into a private channel; the bytes stay on
 * Telegram's side, we keep only ids. Retrieval is copyMessage (no
 * "forwarded from" header) with sendDocument(file_id) as fallback —
 * implemented in the Telegram adapter's sendMediaByRef.
 *
 * Multiple channels: a user can connect several private channels, each with a
 * category and tags parsed from its description; `chooseVault` is the routing
 * policy and `moveVaultMessage` re-files a stored item.
 */
import type { Env } from "../../env";
import type { Db } from "../../database/client";
import type { FileRow, VaultChannelRow } from "../../database/types";
import {
  findVaultByChatId,
  listVaultChannels,
  upsertVaultChannel,
} from "../../database/repos/vaults";
import { tgCall } from "../../channels/telegram/api";
import { normalizeTags } from "../../utils/text";
import { log, formatError } from "../../utils/logger";

export interface VaultRef {
  vaultChatId: string;
  vaultMessageId: number;
}

/** Deep link into a private channel post: t.me/c/<internal id>/<message id>. */
export function vaultLink(chatId: string | null | undefined, messageId: number | string | null | undefined): string | null {
  if (!chatId || messageId === null || messageId === undefined) return null;
  const internal = String(chatId).replace(/^-100/, "");
  if (!/^\d+$/.test(internal)) return null;
  return `https://t.me/c/${internal}/${messageId}`;
}

/** Same for the channel itself (Telegram opens the channel view). */
export function channelLink(chatId: string): string | null {
  const internal = String(chatId).replace(/^-100/, "");
  return /^\d+$/.test(internal) ? `https://t.me/c/${internal}` : null;
}

/**
 * Category + tags from a channel description. Conventions (any language):
 *   Category: research          (or "Kind:", "Type:", "تصنيف:", "فئة:")
 *   Tags: papers, pdf, thesis   (or "#papers #pdf #thesis" anywhere)
 * With neither, the first line becomes the category.
 */
export function parseChannelDescription(description: string | null | undefined): {
  category: string | null;
  tags: string[];
} {
  const text = (description ?? "").trim();
  if (!text) return { category: null, tags: [] };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let category: string | null = null;
  const tags: string[] = [];
  for (const line of lines) {
    const cat = line.match(/^(?:category|kind|type|تصنيف|فئة|نوع)\s*[:：]\s*(.+)$/i);
    if (cat?.[1]) {
      category ??= cat[1].trim();
      continue;
    }
    const tagLine = line.match(/^(?:tags?|وسوم|تاجات|كلمات)\s*[:：]\s*(.+)$/i);
    if (tagLine?.[1]) {
      tags.push(...tagLine[1].split(/[,،\s]+/).map((s) => s.replace(/^#/, "")));
    }
  }
  for (const m of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)) {
    if (m[1]) tags.push(m[1]);
  }
  if (!category) {
    const first = lines.find((l) => !/^(?:tags?|وسوم|تاجات)\s*[:：]/i.test(l) && !/^#/.test(l));
    if (first) category = first.replace(/#[\p{L}\p{N}_-]+/gu, "").trim().slice(0, 60) || null;
  }
  return { category: category ? category.toLowerCase() : null, tags: normalizeTags(tags) };
}

/** Read title + description from Telegram and confirm the bot can post there. */
export async function inspectChannel(
  env: Env,
  chatId: string
): Promise<{ title: string | null; description: string | null; botIsAdmin: boolean; error?: string }> {
  try {
    const chat = await tgCall<{ title?: string; description?: string; type?: string }>(
      env.TELEGRAM_BOT_TOKEN,
      "getChat",
      { chat_id: chatId }
    );
    let botIsAdmin = false;
    try {
      const me = await tgCall<{ id: number }>(env.TELEGRAM_BOT_TOKEN, "getMe");
      const member = await tgCall<{ status: string; can_post_messages?: boolean }>(
        env.TELEGRAM_BOT_TOKEN,
        "getChatMember",
        { chat_id: chatId, user_id: me.id }
      );
      botIsAdmin = member.status === "creator" || (member.status === "administrator" && member.can_post_messages !== false);
    } catch {
      botIsAdmin = false;
    }
    return { title: chat.title ?? null, description: chat.description ?? null, botIsAdmin };
  } catch (err) {
    return { title: null, description: null, botIsAdmin: false, error: formatError(err) };
  }
}

/**
 * Every user's vault list starts with the env channel as the default. Reading
 * the list registers it on first use so older deployments need no migration step.
 */
export async function ensureDefaultVault(env: Env, db: Db, userId: string): Promise<VaultChannelRow[]> {
  const rows = await listVaultChannels(db, userId);
  if (rows.some((r) => r.is_default)) return rows;
  const existing = rows.find((r) => r.chat_id === env.VAULT_CHANNEL_ID);
  if (existing) {
    await upsertVaultChannel(db, { ...existing, is_default: true, enabled: true });
    return listVaultChannels(db, userId);
  }
  const info = await inspectChannel(env, env.VAULT_CHANNEL_ID);
  const parsed = parseChannelDescription(info.description);
  await upsertVaultChannel(db, {
    user_id: userId,
    chat_id: env.VAULT_CHANNEL_ID,
    title: info.title ?? "Vault",
    description: info.description,
    category: parsed.category ?? "general",
    tags: parsed.tags,
    is_default: true,
    enabled: true,
    last_synced_at: new Date().toISOString(),
  });
  return listVaultChannels(db, userId);
}

/** Re-read title/description from Telegram and refresh category + tags. */
export async function syncVaultChannel(env: Env, db: Db, row: VaultChannelRow): Promise<VaultChannelRow> {
  const info = await inspectChannel(env, row.chat_id);
  if (info.error) return row;
  const parsed = parseChannelDescription(info.description);
  return upsertVaultChannel(db, {
    ...row,
    title: info.title ?? row.title,
    description: info.description,
    category: parsed.category ?? row.category,
    tags: parsed.tags.length > 0 ? parsed.tags : row.tags,
    last_synced_at: new Date().toISOString(),
  });
}

/** Register a channel for a user (after verifying the bot can post there). */
export async function connectVaultChannel(
  env: Env,
  db: Db,
  userId: string,
  chatId: string,
  overrides: { category?: string | null; tags?: string[]; title?: string | null } = {}
): Promise<{ row: VaultChannelRow } | { error: string }> {
  const info = await inspectChannel(env, chatId);
  if (info.error) return { error: `Telegram could not open that chat: ${info.error}` };
  if (!info.botIsAdmin) {
    return { error: "the bot must be an administrator of that channel with permission to post" };
  }
  const parsed = parseChannelDescription(info.description);
  const existing = await findVaultByChatId(db, userId, chatId);
  const hasDefault = (await listVaultChannels(db, userId)).some((r) => r.is_default);
  const row = await upsertVaultChannel(db, {
    ...(existing ? { id: existing.id } : {}),
    user_id: userId,
    chat_id: chatId,
    title: overrides.title ?? info.title ?? existing?.title ?? "Vault",
    description: info.description,
    category: overrides.category ?? parsed.category ?? existing?.category ?? null,
    tags: normalizeTags([...(overrides.tags ?? []), ...parsed.tags]),
    is_default: existing?.is_default ?? !hasDefault,
    enabled: true,
    last_synced_at: new Date().toISOString(),
  });
  return { row };
}

/**
 * Pick a channel for a new file from a category/tag hint (the classifier's
 * output, or the user's words). Exact category → tag overlap → default.
 */
export function chooseVault(
  channels: VaultChannelRow[],
  hint: { category?: string | null; tags?: string[] } = {}
): VaultChannelRow | null {
  const enabled = channels.filter((c) => c.enabled);
  if (enabled.length === 0) return null;
  const cat = hint.category?.trim().toLowerCase();
  if (cat) {
    const byCat = enabled.find((c) => (c.category ?? "").toLowerCase() === cat || (c.title ?? "").toLowerCase() === cat);
    if (byCat) return byCat;
  }
  const tags = new Set(normalizeTags(hint.tags ?? []));
  if (tags.size > 0) {
    let best: VaultChannelRow | null = null;
    let bestScore = 0;
    for (const c of enabled) {
      const score = c.tags.filter((t) => tags.has(t)).length;
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (best) return best;
  }
  return enabled.find((c) => c.is_default) ?? enabled[0] ?? null;
}

/**
 * Forward a user's message (carrying media) into a vault channel.
 * Returns null when the vault is unreachable (bot not admin, wrong id) —
 * callers must still record metadata so the file_id remains usable.
 */
export async function forwardToVault(
  env: Env,
  fromChatId: string,
  messageId: string,
  targetChatId: string = env.VAULT_CHANNEL_ID
): Promise<VaultRef | null> {
  try {
    const result = await tgCall<{ message_id: number }>(env.TELEGRAM_BOT_TOKEN, "forwardMessage", {
      chat_id: targetChatId,
      from_chat_id: fromChatId,
      message_id: Number(messageId),
      disable_notification: true,
    });
    return { vaultChatId: targetChatId, vaultMessageId: result.message_id };
  } catch (err) {
    log("error", "vault_forward_failed", {
      error: formatError(err),
      target: targetChatId,
      hint: "is the bot an admin of the vault channel with permission to post?",
    });
    return null;
  }
}

/**
 * Re-file a stored item into another channel: copy (no "forwarded from"
 * header), then best-effort delete the old post. Returns the new reference.
 */
export async function moveVaultMessage(
  env: Env,
  file: Pick<FileRow, "vault_chat_id" | "vault_message_id" | "tg_file_id" | "file_name">,
  targetChatId: string
): Promise<VaultRef | null> {
  try {
    let result: { message_id: number };
    if (file.vault_chat_id && file.vault_message_id !== null) {
      result = await tgCall<{ message_id: number }>(env.TELEGRAM_BOT_TOKEN, "copyMessage", {
        chat_id: targetChatId,
        from_chat_id: file.vault_chat_id,
        message_id: Number(file.vault_message_id),
        disable_notification: true,
      });
      await tgCall(env.TELEGRAM_BOT_TOKEN, "deleteMessage", {
        chat_id: file.vault_chat_id,
        message_id: Number(file.vault_message_id),
      }).catch(() => {});
    } else if (file.tg_file_id) {
      result = await tgCall<{ message_id: number }>(env.TELEGRAM_BOT_TOKEN, "sendDocument", {
        chat_id: targetChatId,
        document: file.tg_file_id,
        disable_notification: true,
      });
    } else {
      return null;
    }
    return { vaultChatId: targetChatId, vaultMessageId: result.message_id };
  } catch (err) {
    log("error", "vault_move_failed", { error: formatError(err), target: targetChatId });
    return null;
  }
}

/** Upload generated bytes as a document into a vault channel (artifact export). */
export async function uploadToVault(
  env: Env,
  fileName: string,
  data: ArrayBuffer | string,
  mime = "text/plain",
  targetChatId: string = env.VAULT_CHANNEL_ID
): Promise<(VaultRef & { fileId?: string }) | null> {
  try {
    const form = new FormData();
    form.append("chat_id", targetChatId);
    form.append("document", new Blob([data], { type: mime }), fileName);
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
      { method: "POST", body: form, signal: AbortSignal.timeout(60_000) }
    );
    const json = (await res.json()) as {
      ok: boolean;
      result?: { message_id: number; document?: { file_id: string } };
      description?: string;
    };
    if (!json.ok || !json.result) {
      log("error", "vault_upload_failed", { description: json.description });
      return null;
    }
    return {
      vaultChatId: targetChatId,
      vaultMessageId: json.result.message_id,
      fileId: json.result.document?.file_id,
    };
  } catch (err) {
    log("error", "vault_upload_failed", { error: formatError(err) });
    return null;
  }
}
