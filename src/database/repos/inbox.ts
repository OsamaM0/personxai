import { dbError, type Db } from "../client";
import type { Enums, InboxItemRow, Json, TablesInsert } from "../types";

export async function insertInboxItem(db: Db, row: TablesInsert<"inbox_items">): Promise<InboxItemRow> {
  const { data, error } = await db.from("inbox_items").insert(row).select().single();
  if (error) throw dbError("inbox_items", "insert", error);
  return data;
}

export async function listPendingInbox(db: Db, userId: string, limit = 10): Promise<InboxItemRow[]> {
  const { data, error } = await db
    .from("inbox_items")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw dbError("inbox_items", "list_pending", error);
  return data ?? [];
}

export async function countPendingInbox(db: Db, userId: string): Promise<number> {
  const { count, error } = await db
    .from("inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "pending");
  if (error) throw dbError("inbox_items", "count_pending", error);
  return count ?? 0;
}

export async function getInboxItem(db: Db, userId: string, itemId: string): Promise<InboxItemRow | null> {
  const { data, error } = await db
    .from("inbox_items")
    .select("*")
    .eq("user_id", userId)
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw dbError("inbox_items", "get", error);
  return data;
}

export async function saveClassification(
  db: Db,
  userId: string,
  itemId: string,
  classification: Json,
  suggestedKind: Enums<"entity_kind"> | null,
  suggestedProjectId: string | null
): Promise<void> {
  const { error } = await db
    .from("inbox_items")
    .update({
      classification,
      suggested_kind: suggestedKind,
      suggested_project_id: suggestedProjectId,
    })
    .eq("user_id", userId)
    .eq("id", itemId);
  if (error) throw dbError("inbox_items", "save_classification", error);
}

export async function resolveInboxItem(
  db: Db,
  userId: string,
  itemId: string,
  resolution: {
    status: Enums<"inbox_status">;
    resolvedKind?: Enums<"entity_kind">;
    resolvedEntityId?: string;
  }
): Promise<void> {
  const { error } = await db
    .from("inbox_items")
    .update({
      status: resolution.status,
      resolved_kind: resolution.resolvedKind ?? null,
      resolved_entity_id: resolution.resolvedEntityId ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("id", itemId);
  if (error) throw dbError("inbox_items", "resolve", error);
}
