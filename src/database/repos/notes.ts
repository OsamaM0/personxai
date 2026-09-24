import { dbError, type Db } from "../client";
import type { NoteRow, TablesInsert, TablesUpdate } from "../types";

export async function createNote(db: Db, row: TablesInsert<"notes">): Promise<NoteRow> {
  const { data, error } = await db.from("notes").insert(row).select().single();
  if (error) throw dbError("notes", "insert", error);
  return data;
}

export interface NoteFilter {
  projectId?: string;
  tag?: string;
  query?: string;
  limit?: number;
}

export async function listNotes(db: Db, userId: string, filter: NoteFilter = {}): Promise<NoteRow[]> {
  let q = db.from("notes").select("*").eq("user_id", userId).is("deleted_at", null);
  if (filter.projectId) q = q.eq("project_id", filter.projectId);
  if (filter.tag) q = q.contains("tags", [filter.tag]);
  if (filter.query) {
    const escaped = filter.query.replace(/[\\%_]/g, (m) => `\\${m}`);
    q = q.or(`title.ilike.%${escaped}%,content.ilike.%${escaped}%`);
  }
  const { data, error } = await q
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(filter.limit ?? 20);
  if (error) throw dbError("notes", "list", error);
  return data ?? [];
}

export async function getNote(db: Db, userId: string, noteId: string): Promise<NoteRow | null> {
  const { data, error } = await db
    .from("notes")
    .select("*")
    .eq("user_id", userId)
    .eq("id", noteId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw dbError("notes", "get", error);
  return data;
}

export async function updateNote(
  db: Db,
  userId: string,
  noteId: string,
  patch: TablesUpdate<"notes">
): Promise<void> {
  const { error } = await db.from("notes").update(patch).eq("user_id", userId).eq("id", noteId);
  if (error) throw dbError("notes", "update", error);
}

/** Soft delete. */
export async function deleteNote(db: Db, userId: string, noteId: string): Promise<boolean> {
  const { data, error } = await db
    .from("notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", noteId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw dbError("notes", "delete", error);
  return (data?.length ?? 0) > 0;
}
