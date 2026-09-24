/**
 * Bot registrations — the BotFather tokens the worker answers for.
 *
 * A row here is the source of truth for a channel's credentials; the env var
 * (TELEGRAM_BOT_TOKEN) is only the first-run bootstrap, seeded into this table
 * the first time the dashboard or a webhook looks for a bot. Swapping the token
 * is therefore a database write plus one setWebhook call — no redeploy.
 */
import { dbError, type Db } from "../client";
import type { BotRow, TablesInsert, TablesUpdate } from "../types";

export async function listBots(db: Db, channel?: string): Promise<BotRow[]> {
  let q = db.from("bots").select("*").order("created_at", { ascending: true });
  if (channel) q = q.eq("channel", channel);
  const { data, error } = await q;
  if (error) throw dbError("bots", "select", error);
  return data ?? [];
}

export async function getBotById(db: Db, id: string): Promise<BotRow | null> {
  const { data, error } = await db.from("bots").select("*").eq("id", id).maybeSingle();
  if (error) throw dbError("bots", "select", error);
  return data;
}

/**
 * The bot a secret-less webhook path (and every outbound call that was not told
 * which bot to use) resolves to: the explicit default, else the oldest active
 * one, so a single-bot install never has to mark anything.
 */
export async function getDefaultBot(db: Db, channel = "telegram"): Promise<BotRow | null> {
  const { data, error } = await db
    .from("bots")
    .select("*")
    .eq("channel", channel)
    .eq("is_active", true)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw dbError("bots", "select_default", error);
  return data?.[0] ?? null;
}

export async function findBotByToken(db: Db, token: string): Promise<BotRow | null> {
  const { data, error } = await db.from("bots").select("*").eq("token", token).maybeSingle();
  if (error) throw dbError("bots", "select_by_token", error);
  return data;
}

export async function insertBot(db: Db, row: TablesInsert<"bots">): Promise<BotRow> {
  const { data, error } = await db.from("bots").insert(row).select().single();
  if (error) throw dbError("bots", "insert", error);
  return data;
}

export async function updateBot(
  db: Db,
  id: string,
  patch: TablesUpdate<"bots">
): Promise<BotRow | null> {
  const { data, error } = await db.from("bots").update(patch).eq("id", id).select().maybeSingle();
  if (error) throw dbError("bots", "update", error);
  return data;
}

export async function deleteBot(db: Db, id: string): Promise<void> {
  const { error } = await db.from("bots").delete().eq("id", id);
  if (error) throw dbError("bots", "delete", error);
}

/**
 * Make one bot the channel default. The partial unique index allows a single
 * `is_default` row per channel, so the old default is cleared first.
 */
export async function setDefaultBot(db: Db, id: string, channel: string): Promise<void> {
  const { error: clearError } = await db
    .from("bots")
    .update({ is_default: false })
    .eq("channel", channel)
    .eq("is_default", true);
  if (clearError) throw dbError("bots", "clear_default", clearError);
  const { error } = await db.from("bots").update({ is_default: true }).eq("id", id);
  if (error) throw dbError("bots", "set_default", error);
}
