/** Users + channel identities. */
import { dbError, type Db } from "../client";
import type { Enums, TablesUpdate, UserIdentityRow, UserRow } from "../types";
import { log } from "../../utils/logger";

export interface ResolvedIdentity {
  user: UserRow;
  identity: UserIdentityRow;
}

export async function findUserByIdentity(
  db: Db,
  channel: string,
  externalId: string
): Promise<ResolvedIdentity | null> {
  const { data: identity, error } = await db
    .from("user_identities")
    .select("*")
    .eq("channel", channel)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw dbError("user_identities", "select", error);
  if (!identity) return null;

  const user = await getUserById(db, identity.user_id);
  // Orphaned identity (user row deleted out-of-band): treat as unknown user.
  if (!user) return null;
  return { user, identity };
}

export async function getUserById(db: Db, userId: string): Promise<UserRow | null> {
  const { data, error } = await db.from("users").select("*").eq("id", userId).maybeSingle();
  if (error) throw dbError("users", "select", error);
  return data;
}

export async function createUserWithIdentity(
  db: Db,
  opts: {
    channel: string;
    externalId: string;
    chatRef?: string;
    username?: string;
    displayName?: string;
    role: Enums<"user_role">;
    isAllowed: boolean;
    timezone: string;
    language: string;
  }
): Promise<ResolvedIdentity> {
  const { data: user, error: userError } = await db
    .from("users")
    .insert({
      display_name: opts.displayName ?? null,
      role: opts.role,
      is_allowed: opts.isAllowed,
      timezone: opts.timezone,
      language: opts.language,
    })
    .select()
    .single();
  if (userError) throw dbError("users", "insert", userError);

  const { data: identity, error: identityError } = await db
    .from("user_identities")
    .insert({
      user_id: user.id,
      channel: opts.channel,
      external_id: opts.externalId,
      chat_ref: opts.chatRef ?? null,
      username: opts.username ?? null,
    })
    .select()
    .single();
  if (identityError) {
    // No transactions over PostgREST: undo the user insert by hand so a retry
    // does not strand an identity-less user row.
    const { error: cleanupError } = await db.from("users").delete().eq("id", user.id);
    if (cleanupError) {
      log("warn", "db.users.rollback_failed", { userId: user.id, code: cleanupError.code });
    }
    throw dbError("user_identities", "insert", identityError);
  }
  return { user, identity };
}

export async function updateUser(
  db: Db,
  userId: string,
  patch: TablesUpdate<"users">
): Promise<void> {
  const { error } = await db.from("users").update(patch).eq("id", userId);
  if (error) throw dbError("users", "update", error);
}

export async function touchLastSeen(db: Db, userId: string): Promise<void> {
  const { error } = await db
    .from("users")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw dbError("users", "update", error);
}

export async function updateIdentity(
  db: Db,
  identityId: string,
  patch: { chat_ref?: string; username?: string }
): Promise<void> {
  const { error } = await db.from("user_identities").update(patch).eq("id", identityId);
  if (error) throw dbError("user_identities", "update", error);
}

/**
 * Attach another channel identity to an existing user — "same brain, new
 * channel". Used when the owner first writes from a second channel.
 */
export async function addIdentity(
  db: Db,
  userId: string,
  opts: { channel: string; externalId: string; chatRef?: string; username?: string }
): Promise<UserIdentityRow> {
  const { data, error } = await db
    .from("user_identities")
    .insert({
      user_id: userId,
      channel: opts.channel,
      external_id: opts.externalId,
      chat_ref: opts.chatRef ?? null,
      username: opts.username ?? null,
    })
    .select()
    .single();
  if (error) throw dbError("user_identities", "insert", error);
  return data;
}

/** The (first-provisioned) owner account, or null before first contact. */
export async function findOwnerUser(db: Db): Promise<UserRow | null> {
  const { data, error } = await db
    .from("users")
    .select("*")
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw dbError("users", "find_owner", error);
  return data?.[0] ?? null;
}

/**
 * Any identity that can reach the user, preferring the channels listed first
 * (the dashboard and MCP surfaces deliver links and files through it).
 */
export async function findAnyIdentityByUser(
  db: Db,
  userId: string,
  preferred: readonly string[] = ["telegram", "whatsapp"]
): Promise<UserIdentityRow | null> {
  const { data, error } = await db
    .from("user_identities")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw dbError("user_identities", "find_any_by_user", error);
  const rows = data ?? [];
  for (const channel of preferred) {
    const hit = rows.find((r) => r.channel === channel);
    if (hit) return hit;
  }
  return rows[0] ?? null;
}

/** The user's identity on one channel — used by the web dashboard to reach them. */
export async function findIdentityByUser(
  db: Db,
  userId: string,
  channel: string
): Promise<UserIdentityRow | null> {
  const { data, error } = await db
    .from("user_identities")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", channel)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw dbError("user_identities", "find_by_user", error);
  return data?.[0] ?? null;
}
