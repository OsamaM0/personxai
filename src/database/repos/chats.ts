/**
 * Group chats the bot has been added to.
 *
 * Rows appear on their own: a my_chat_member update when the bot is added or
 * promoted, and the first message the bot sees in a group it did not know
 * about. `reply_mode` is the gate the orchestrator reads before spending a turn.
 */
import { dbError, type Db } from "../client";
import type { ChatRow, TablesUpdate } from "../types";

export type ReplyMode = "mention" | "all" | "off";
export const REPLY_MODES: readonly ReplyMode[] = ["mention", "all", "off"];

export async function listChats(db: Db, userId: string, channel?: string): Promise<ChatRow[]> {
  let q = db
    .from("chats")
    .select("*")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (channel) q = q.eq("channel", channel);
  const { data, error } = await q;
  if (error) throw dbError("chats", "select", error);
  return data ?? [];
}

export async function findChat(
  db: Db,
  channel: string,
  externalChatId: string
): Promise<ChatRow | null> {
  const { data, error } = await db
    .from("chats")
    .select("*")
    .eq("channel", channel)
    .eq("external_chat_id", externalChatId)
    .maybeSingle();
  if (error) throw dbError("chats", "select_one", error);
  return data;
}

export async function getChatById(db: Db, userId: string, id: string): Promise<ChatRow | null> {
  const { data, error } = await db
    .from("chats")
    .select("*")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw dbError("chats", "select_by_id", error);
  return data;
}

export interface ChatUpsert {
  userId: string;
  channel: string;
  externalChatId: string;
  chatType: string;
  botId?: string | null;
  title?: string | null;
  username?: string | null;
  botStatus?: string | null;
  memberCount?: number | null;
  lastMessageAt?: string | null;
}

/**
 * Register or refresh a chat.
 *
 * Deliberately a read-then-write rather than an upsert: a PostgREST upsert
 * rewrites every column in the payload, which would reassign `user_id` to
 * whoever happened to speak last. Only the fields the caller actually observed
 * are written, and `is_enabled` / `reply_mode` — which belong to the user — are
 * never touched by either path.
 */
export async function upsertChat(db: Db, input: ChatUpsert): Promise<ChatRow> {
  const patch: TablesUpdate<"chats"> = {
    chat_type: input.chatType,
    updated_at: new Date().toISOString(),
  };
  if (input.botId !== undefined && input.botId !== null) patch.bot_id = input.botId;
  if (input.title) patch.title = input.title;
  if (input.username) patch.username = input.username;
  if (input.botStatus !== undefined) patch.bot_status = input.botStatus;
  if (input.memberCount !== undefined) patch.member_count = input.memberCount;
  if (input.lastMessageAt !== undefined) patch.last_message_at = input.lastMessageAt;

  const existing = await findChat(db, input.channel, input.externalChatId);
  if (existing) {
    const { data, error } = await db
      .from("chats")
      .update(patch)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw dbError("chats", "update", error);
    return data;
  }

  const { data, error } = await db
    .from("chats")
    .insert({
      user_id: input.userId,
      channel: input.channel,
      external_chat_id: input.externalChatId,
      ...patch,
    })
    .select()
    .single();
  if (error) throw dbError("chats", "insert", error);
  return data;
}

export async function updateChat(
  db: Db,
  userId: string,
  id: string,
  patch: TablesUpdate<"chats">
): Promise<ChatRow | null> {
  const { data, error } = await db
    .from("chats")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) throw dbError("chats", "update", error);
  return data;
}

export async function deleteChat(db: Db, userId: string, id: string): Promise<void> {
  const { error } = await db.from("chats").delete().eq("user_id", userId).eq("id", id);
  if (error) throw dbError("chats", "delete", error);
}
