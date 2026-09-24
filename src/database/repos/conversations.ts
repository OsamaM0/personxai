/**
 * Conversations. A partial unique index allows at most one is_active=true row
 * per user, so activation always deactivates the current one first.
 */
import { dbError, type Db } from "../client";
import type { ConversationRow } from "../types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getActiveConversation(
  db: Db,
  userId: string
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw dbError("conversations", "select", error);
  return data;
}

export async function ensureActiveConversation(
  db: Db,
  userId: string,
  defaultTitle: string
): Promise<ConversationRow> {
  const existing = await getActiveConversation(db, userId);
  if (existing) return existing;

  const { data, error } = await db
    .from("conversations")
    .insert({ user_id: userId, title: defaultTitle, is_active: true })
    .select()
    .single();
  if (error) {
    // 23505: a concurrent turn won the partial-unique-index race; reuse its row.
    if (error.code === "23505") {
      const raced = await getActiveConversation(db, userId);
      if (raced) return raced;
    }
    throw dbError("conversations", "insert", error);
  }
  return data;
}

export async function startNewConversation(
  db: Db,
  userId: string,
  title: string | null,
  projectId?: string | null
): Promise<ConversationRow> {
  // Deactivate FIRST: inserting a second active row would violate the index.
  await deactivateActive(db, userId);

  const { data, error } = await db
    .from("conversations")
    .insert({ user_id: userId, title, project_id: projectId ?? null, is_active: true })
    .select()
    .single();
  if (error) throw dbError("conversations", "insert", error);
  return data;
}

export async function switchConversation(
  db: Db,
  userId: string,
  query: string
): Promise<ConversationRow | null> {
  const found = await findConversation(db, userId, query.trim());
  if (!found) return null;

  await deactivateActive(db, userId, found.id);

  const { data, error } = await db
    .from("conversations")
    .update({ is_active: true })
    .eq("user_id", userId)
    .eq("id", found.id)
    .select()
    .single();
  if (error) throw dbError("conversations", "update", error);
  return data;
}

export async function listConversations(
  db: Db,
  userId: string,
  limit = 10
): Promise<ConversationRow[]> {
  const { data, error } = await db
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw dbError("conversations", "select", error);
  return data;
}

export async function archiveConversation(
  db: Db,
  userId: string,
  conversationId: string
): Promise<void> {
  // Also drop is_active so an archived conversation can never shadow new ones.
  const { error } = await db
    .from("conversations")
    .update({ archived_at: new Date().toISOString(), is_active: false })
    .eq("user_id", userId)
    .eq("id", conversationId);
  if (error) throw dbError("conversations", "update", error);
}

/** Deactivate the user's active conversation, optionally sparing one id. */
async function deactivateActive(db: Db, userId: string, exceptId?: string): Promise<void> {
  let q = db
    .from("conversations")
    .update({ is_active: false })
    .eq("user_id", userId)
    .eq("is_active", true);
  if (exceptId) q = q.neq("id", exceptId);
  const { error } = await q;
  if (error) throw dbError("conversations", "update", error);
}

/** Exact id match (uuid-shaped input only) or ilike title; most recent non-archived. */
async function findConversation(
  db: Db,
  userId: string,
  query: string
): Promise<ConversationRow | null> {
  if (query.length === 0) return null;

  if (UUID_RE.test(query)) {
    const { data, error } = await db
      .from("conversations")
      .select("*")
      .eq("user_id", userId)
      .eq("id", query)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw dbError("conversations", "select", error);
    if (data) return data;
  }

  // Escape LIKE metacharacters so the user's text matches as a literal substring.
  const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { data, error } = await db
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .is("archived_at", null)
    .ilike("title", pattern)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw dbError("conversations", "select", error);
  return data;
}
