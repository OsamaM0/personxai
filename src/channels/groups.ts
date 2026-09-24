/**
 * Group-chat behaviour.
 *
 * A bot added to a group sees every message in it. Answering all of them would
 * be noisy and expensive, so by default the bot only wakes when it is actually
 * addressed — @mentioned, replied to, or given a slash command. The per-group
 * `reply_mode` in the `chats` table can widen that to every message or silence
 * the bot entirely, and the dashboard is where that gets set.
 *
 * Nothing here decides *whose* data a group turn touches: that stays the
 * sender's own account, resolved by the orchestrator exactly as in a private
 * chat, so a group can never be used to read someone else's tasks.
 */
import type { Db } from "../database/client";
import type { BotRow, ChatRow } from "../database/types";
import type { IncomingMessage } from "./types";
import { findChat, upsertChat, type ReplyMode } from "../database/repos/chats";
import { findOwnerUser } from "../database/repos/users";
import { log, formatError } from "../utils/logger";

/** Chat kinds that are shared spaces rather than a one-to-one conversation. */
export function isGroupChat(chatType: string | undefined): boolean {
  return chatType === "group" || chatType === "supergroup";
}

export interface BotIdentityHint {
  /** Numeric Telegram id of the bot, when known. */
  externalId?: string | undefined;
  /** @username of the bot, lowercased, when known. */
  username?: string | undefined;
}

/**
 * Identify the bot behind a token even without a stored row: a Telegram bot
 * token is `<bot id>:<secret>`, so the id is free and replies can be matched
 * with no lookup at all. The @username is not in the token, so it comes either
 * from the `bots` row or from `fetchedUsername` — see resolveBotUsername, which
 * the ingress calls (and caches) only for group traffic.
 */
export function botIdentity(
  bot: BotRow | null,
  token: string | undefined,
  /** Looked up with getMe when the row has none (see resolveBotUsername). */
  fetchedUsername?: string | undefined
): BotIdentityHint {
  const prefix = token?.split(":")[0];
  const externalId = prefix && /^\d+$/.test(prefix) ? prefix : undefined;
  if (bot) {
    return {
      externalId: bot.bot_external_id ?? externalId,
      username: bot.username?.toLowerCase() ?? fetchedUsername,
    };
  }
  return { externalId, username: fetchedUsername };
}

/**
 * Is this message aimed at the bot?
 *
 * True for everything outside a group. Inside one: an @mention of the bot, a
 * reply to something the bot said, or a slash command that either names this
 * bot or names none at all.
 */
export function isAddressedToBot(msg: IncomingMessage, identity: BotIdentityHint): boolean {
  if (!isGroupChat(msg.chatType)) return true;
  if (msg.addressedToBot) return true;

  const username = identity.username;
  if (username && msg.mentions?.includes(username)) return true;
  if (identity.externalId && msg.replyToFromId === identity.externalId) return true;
  if (msg.command) {
    // "/tasks" (unaddressed) counts; "/tasks@OtherBot" does not.
    if (!msg.command.target) return true;
    if (username && msg.command.target === username) return true;
    return false;
  }
  return false;
}

export interface RecordChatOptions {
  botId?: string | null;
  /** Who the chat belongs to in the dashboard; defaults to the owner account. */
  ownerUserId?: string | undefined;
  botStatus?: string;
  lastMessageAt?: string;
}

/**
 * Record (or refresh) a group the bot belongs to.
 *
 * Chats are attributed to the bot's owner, falling back to the first owner
 * account, because the dashboard lists them per user. Private chats are not
 * recorded: they are already represented by `user_identities`.
 */
export async function recordChat(
  db: Db,
  msg: IncomingMessage,
  opts: RecordChatOptions = {}
): Promise<ChatRow | null> {
  if (!isGroupChat(msg.chatType) && msg.chatType !== "channel") return null;
  const ownerId = opts.ownerUserId ?? (await findOwnerUser(db).catch(() => null))?.id;
  if (!ownerId) return null;

  try {
    return await upsertChat(db, {
      userId: ownerId,
      channel: msg.channel,
      externalChatId: msg.externalChatId,
      chatType: msg.chatType ?? "group",
      botId: opts.botId ?? msg.botId ?? null,
      title: msg.chatTitle ?? msg.membership?.title ?? null,
      username: msg.membership?.username ?? null,
      ...(opts.botStatus !== undefined ? { botStatus: opts.botStatus } : {}),
      ...(opts.lastMessageAt !== undefined ? { lastMessageAt: opts.lastMessageAt } : {}),
    });
  } catch (err) {
    log("warn", "groups.record_failed", { error: formatError(err) });
    return null;
  }
}

/** A my_chat_member update: the bot was added, removed, or promoted. */
export async function handleMembershipChange(
  db: Db,
  bot: BotRow | null,
  msg: IncomingMessage
): Promise<void> {
  const status = msg.membership?.status ?? "member";
  await recordChat(db, msg, {
    botId: bot?.id ?? null,
    ownerUserId: bot?.user_id,
    botStatus: status,
  });
  log("info", "groups.membership_changed", {
    chatId: msg.externalChatId,
    chatType: msg.chatType,
    status,
  });
}

export type GroupGate = "handle" | "ignore";

/**
 * Should this group message become a turn?
 *
 * Reads the stored `reply_mode`; an unknown group behaves as "mention", which
 * is also what a freshly added bot does before anyone has configured it.
 */
export async function gateGroupMessage(db: Db, msg: IncomingMessage): Promise<GroupGate> {
  if (!isGroupChat(msg.chatType)) return "handle";

  const chat = await findChat(db, msg.channel, msg.externalChatId).catch((err) => {
    log("warn", "groups.gate_lookup_failed", { error: formatError(err) });
    return null;
  });
  if (chat && !chat.is_enabled) return "ignore";

  const mode = (chat?.reply_mode ?? "mention") as ReplyMode;
  if (mode === "off") return "ignore";
  if (mode === "all") return "handle";
  return msg.addressedToBot ? "handle" : "ignore";
}
