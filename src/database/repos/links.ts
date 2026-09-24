import { dbError, type Db } from "../client";
import type { LinkRow, TablesInsert, TablesUpdate } from "../types";

export async function upsertLink(db: Db, row: TablesInsert<"links">): Promise<LinkRow> {
  const { data, error } = await db
    .from("links")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "user_id,url" })
    .select()
    .single();
  if (error) throw dbError("links", "upsert", error);
  return data;
}

export async function findLinkByUrl(db: Db, userId: string, url: string): Promise<LinkRow | null> {
  const { data, error } = await db
    .from("links")
    .select("*")
    .eq("user_id", userId)
    .eq("url", url)
    .maybeSingle();
  if (error) throw dbError("links", "find_by_url", error);
  return data;
}

export async function getLink(db: Db, userId: string, linkId: string): Promise<LinkRow | null> {
  const { data, error } = await db
    .from("links")
    .select("*")
    .eq("user_id", userId)
    .eq("id", linkId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw dbError("links", "get", error);
  return data;
}

export interface LinkFilter {
  query?: string;
  projectId?: string;
  tag?: string;
  limit?: number;
}

export async function listLinks(db: Db, userId: string, filter: LinkFilter = {}): Promise<LinkRow[]> {
  let q = db.from("links").select("*").eq("user_id", userId).is("deleted_at", null);
  if (filter.projectId) q = q.eq("project_id", filter.projectId);
  if (filter.tag) q = q.contains("tags", [filter.tag]);
  if (filter.query) {
    const escaped = filter.query.replace(/[\\%_]/g, (m) => `\\${m}`);
    q = q.or(`title.ilike.%${escaped}%,summary.ilike.%${escaped}%,url.ilike.%${escaped}%`);
  }
  const { data, error } = await q.order("created_at", { ascending: false }).limit(filter.limit ?? 15);
  if (error) throw dbError("links", "list", error);
  return data ?? [];
}

export async function updateLink(
  db: Db,
  userId: string,
  linkId: string,
  patch: TablesUpdate<"links">
): Promise<void> {
  const { error } = await db.from("links").update(patch).eq("user_id", userId).eq("id", linkId);
  if (error) throw dbError("links", "update", error);
}

export async function deleteLink(db: Db, userId: string, linkId: string): Promise<boolean> {
  const { data, error } = await db
    .from("links")
    .update({ deleted_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", linkId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw dbError("links", "delete", error);
  return (data?.length ?? 0) > 0;
}
