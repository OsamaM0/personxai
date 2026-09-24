/** Conversation messages. */
import { dbError, type Db } from "../client";
import type { MessageRow, TablesInsert } from "../types";

export async function insertMessage(db: Db, row: TablesInsert<"messages">): Promise<MessageRow> {
  const { data, error } = await db.from("messages").insert(row).select().single();
  if (error) throw dbError("messages", "insert", error);
  return data;
}

export async function recentMessages(
  db: Db,
  conversationId: string,
  limit: number
): Promise<MessageRow[]> {
  // Newest-first LIMIT n grabs the tail of the conversation; reverse restores
  // chronological order for the prompt window.
  const { data, error } = await db
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false }) // deterministic tie-break on equal timestamps
    .limit(limit);
  if (error) throw dbError("messages", "select", error);
  return data.reverse();
}

export async function setMessageEmbedding(
  db: Db,
  messageId: string,
  embedding: number[]
): Promise<void> {
  // pgvector columns accept the JSON array literal ("[1,2,3]") as text input.
  const { error } = await db
    .from("messages")
    .update({ embedding: JSON.stringify(embedding) })
    .eq("id", messageId);
  if (error) throw dbError("messages", "update", error);
}
