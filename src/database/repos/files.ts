import { dbError, type Db } from "../client";
import type { Enums, FileRow, TablesInsert, TablesUpdate } from "../types";

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function insertFile(db: Db, row: TablesInsert<"files">): Promise<FileRow> {
  const { data, error } = await db.from("files").insert(row).select().single();
  if (error) throw dbError("files", "insert", error);
  return data;
}

/** Dedup lookup by Telegram's stable per-file id. */
export async function findFileByUniqueId(
  db: Db,
  userId: string,
  tgFileUniqueId: string
): Promise<FileRow | null> {
  const { data, error } = await db
    .from("files")
    .select("*")
    .eq("user_id", userId)
    .eq("tg_file_unique_id", tgFileUniqueId)
    .maybeSingle();
  if (error) throw dbError("files", "find_by_unique_id", error);
  return data;
}

export async function getFileById(db: Db, userId: string, fileId: string): Promise<FileRow | null> {
  const { data, error } = await db
    .from("files")
    .select("*")
    .eq("user_id", userId)
    .eq("id", fileId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw dbError("files", "get", error);
  return data;
}

/** Find the file that arrived as a specific chat message (for reply-to-file turns). */
export async function findFileByOriginMessage(
  db: Db,
  userId: string,
  originMessageId: string
): Promise<FileRow | null> {
  const { data, error } = await db
    .from("files")
    .select("*")
    .eq("user_id", userId)
    .eq("origin_message_id", originMessageId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw dbError("files", "find_by_origin", error);
  return data?.[0] ?? null;
}

/** The stored row behind a post in a vault channel (for forwarded posts). */
export async function findFileByVaultMessage(
  db: Db,
  userId: string,
  vaultChatId: string,
  vaultMessageId: string | number
): Promise<FileRow | null> {
  const { data, error } = await db
    .from("files")
    .select("*")
    .eq("user_id", userId)
    .eq("vault_chat_id", vaultChatId)
    .eq("vault_message_id", Number(vaultMessageId))
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw dbError("files", "find_by_vault_message", error);
  return data;
}

export interface FileSearchFilter {
  query?: string;
  projectId?: string;
  mediaKind?: string;
  /** Every listed tag must be present (AND). */
  tags?: string[];
  /** Restrict to one vault channel (telegram chat id). */
  vaultChatId?: string;
  after?: string;
  before?: string;
  limit?: number;
}

export async function searchFiles(db: Db, userId: string, filter: FileSearchFilter): Promise<FileRow[]> {
  let q = db.from("files").select("*").eq("user_id", userId).is("deleted_at", null);
  if (filter.query) {
    const like = `%${escapeLike(filter.query)}%`;
    q = q.or(`file_name.ilike.${like},caption.ilike.${like},extracted_text.ilike.${like}`);
  }
  if (filter.projectId) q = q.eq("project_id", filter.projectId);
  if (filter.mediaKind) q = q.eq("media_kind", filter.mediaKind);
  if (filter.tags && filter.tags.length > 0) q = q.contains("tags", filter.tags);
  if (filter.vaultChatId) q = q.eq("vault_chat_id", filter.vaultChatId);
  if (filter.after) q = q.gte("created_at", filter.after);
  if (filter.before) q = q.lte("created_at", filter.before);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(filter.limit ?? 10);
  if (error) throw dbError("files", "search", error);
  return data ?? [];
}

export async function listRecentFiles(db: Db, userId: string, limit = 10): Promise<FileRow[]> {
  return searchFiles(db, userId, { limit });
}

export async function updateFile(
  db: Db,
  userId: string,
  fileId: string,
  patch: TablesUpdate<"files">
): Promise<void> {
  const { error } = await db.from("files").update(patch).eq("user_id", userId).eq("id", fileId);
  if (error) throw dbError("files", "update", error);
}

export async function setExtraction(
  db: Db,
  userId: string,
  fileId: string,
  status: Enums<"extraction_status">,
  extractedText?: string | null
): Promise<void> {
  await updateFile(db, userId, fileId, {
    extraction_status: status,
    ...(extractedText !== undefined ? { extracted_text: extractedText } : {}),
  });
}

export async function insertFileChunks(
  db: Db,
  rows: TablesInsert<"file_chunks">[]
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await db.from("file_chunks").insert(rows);
  if (error) throw dbError("file_chunks", "insert", error);
}

/**
 * Ensure tags exist and attach them to a file. Returns the final tag names.
 * `files.tags` (array, GIN-indexed) is the canonical read path; the tags /
 * file_tags tables are kept in sync for anything that still joins on them.
 */
export async function tagFile(
  db: Db,
  userId: string,
  fileId: string,
  names: string[],
  mode: "add" | "replace" = "add"
): Promise<string[]> {
  const current = await db.from("files").select("tags").eq("user_id", userId).eq("id", fileId).maybeSingle();
  if (current.error) throw dbError("files", "read_tags", current.error);
  const merged = mode === "replace" ? [...names] : [...(current.data?.tags ?? []), ...names];
  const finalTags = [...new Set(merged)];
  await updateFile(db, userId, fileId, { tags: finalTags });
  if (mode === "replace") {
    const cleared = await db.from("file_tags").delete().eq("file_id", fileId);
    if (cleared.error) throw dbError("file_tags", "clear", cleared.error);
  }
  const out: string[] = [];
  for (const name of finalTags) {
    const { data: tag, error } = await db
      .from("tags")
      .upsert({ user_id: userId, name }, { onConflict: "user_id,name" })
      .select()
      .single();
    if (error) throw dbError("tags", "upsert", error);
    const link = await db
      .from("file_tags")
      .upsert({ file_id: fileId, tag_id: tag.id }, { onConflict: "file_id,tag_id" });
    if (link.error) throw dbError("file_tags", "upsert", link.error);
    out.push(tag.name);
  }
  return out;
}

export async function fileTagNames(db: Db, fileId: string): Promise<string[]> {
  const { data, error } = await db.from("file_tags").select("tag_id, tags(name)").eq("file_id", fileId);
  if (error) throw dbError("file_tags", "list", error);
  return (data ?? [])
    .map((row) => (row as unknown as { tags: { name: string } | null }).tags?.name)
    .filter((n): n is string => typeof n === "string");
}

export async function searchFilesByTag(
  db: Db,
  userId: string,
  tagName: string,
  limit = 10
): Promise<FileRow[]> {
  const { data: tag, error } = await db
    .from("tags")
    .select("id")
    .eq("user_id", userId)
    .eq("name", tagName)
    .maybeSingle();
  if (error) throw dbError("tags", "find", error);
  if (!tag) return [];
  const { data: links, error: linkErr } = await db
    .from("file_tags")
    .select("file_id")
    .eq("tag_id", tag.id)
    .limit(limit);
  if (linkErr) throw dbError("file_tags", "by_tag", linkErr);
  const ids = (links ?? []).map((l) => l.file_id);
  if (ids.length === 0) return [];
  const { data, error: fileErr } = await db
    .from("files")
    .select("*")
    .eq("user_id", userId)
    .in("id", ids)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (fileErr) throw dbError("files", "by_tag", fileErr);
  return data ?? [];
}
