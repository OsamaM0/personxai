import { dbError, type Db } from "../client";
import type {
  Enums,
  MemoryMatch,
  MemoryRow,
  TablesInsert,
  TablesUpdate,
  UserFactRow,
} from "../types";

export async function createMemory(db: Db, row: TablesInsert<"memories">): Promise<MemoryRow> {
  const { data, error } = await db.from("memories").insert(row).select().single();
  if (error) throw dbError("memories", "insert", error);
  return data;
}

export interface MemoryFilter {
  types?: Enums<"memory_type">[];
  projectId?: string;
  tag?: string;
  query?: string;
  limit?: number;
}

export async function listMemories(db: Db, userId: string, filter: MemoryFilter = {}): Promise<MemoryRow[]> {
  let q = db.from("memories").select("*").eq("user_id", userId).is("deleted_at", null);
  if (filter.types && filter.types.length > 0) q = q.in("memory_type", filter.types);
  if (filter.projectId) q = q.eq("project_id", filter.projectId);
  if (filter.tag) q = q.contains("tags", [filter.tag]);
  if (filter.query) {
    const escaped = filter.query.replace(/[\\%_]/g, (m) => `\\${m}`);
    q = q.ilike("content", `%${escaped}%`);
  }
  const { data, error } = await q
    .order("importance", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 20);
  if (error) throw dbError("memories", "list", error);
  return data ?? [];
}

export async function getMemory(db: Db, userId: string, memoryId: string): Promise<MemoryRow | null> {
  const { data, error } = await db
    .from("memories")
    .select("*")
    .eq("user_id", userId)
    .eq("id", memoryId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw dbError("memories", "get", error);
  return data;
}

export async function updateMemory(
  db: Db,
  userId: string,
  memoryId: string,
  patch: TablesUpdate<"memories">
): Promise<void> {
  const { error } = await db.from("memories").update(patch).eq("user_id", userId).eq("id", memoryId);
  if (error) throw dbError("memories", "update", error);
}

/** Soft delete — "forget this". */
export async function forgetMemory(db: Db, userId: string, memoryId: string): Promise<boolean> {
  const { data, error } = await db
    .from("memories")
    .update({ deleted_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", memoryId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw dbError("memories", "forget", error);
  return (data?.length ?? 0) > 0;
}

/** Best-effort embedding write; never throws (embedding failure must not lose the memory). */
export async function setMemoryEmbedding(
  db: Db,
  userId: string,
  memoryId: string,
  embedding: number[]
): Promise<void> {
  await db
    .from("memories")
    .update({ embedding: JSON.stringify(embedding) })
    .eq("user_id", userId)
    .eq("id", memoryId);
}

export async function matchMemories(
  db: Db,
  userId: string,
  embedding: number[],
  opts: { projectId?: string; tags?: string[]; limit?: number } = {}
): Promise<MemoryMatch[]> {
  const { data, error } = await db.rpc("match_memories", {
    p_user_id: userId,
    p_query_embedding: JSON.stringify(embedding),
    p_project: opts.projectId ?? null,
    p_tag_filter: opts.tags ?? null,
    p_limit: opts.limit ?? 10,
  });
  if (error) throw dbError("match_memories", "rpc", error);
  return data ?? [];
}

export async function touchMemories(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.from("memories").update({ last_accessed_at: new Date().toISOString() }).in("id", ids);
}

// ── user_facts: KV facts injected into every prompt (key IS the dedup) ───────

export async function listUserFacts(db: Db, userId: string): Promise<UserFactRow[]> {
  const { data, error } = await db
    .from("user_facts")
    .select("*")
    .eq("user_id", userId)
    .order("category", { ascending: true })
    .limit(60);
  if (error) throw dbError("user_facts", "list", error);
  return data ?? [];
}

export async function upsertUserFact(
  db: Db,
  userId: string,
  key: string,
  value: string,
  category = "general"
): Promise<UserFactRow> {
  const { data, error } = await db
    .from("user_facts")
    .upsert(
      { user_id: userId, key, value, category, updated_at: new Date().toISOString() },
      { onConflict: "user_id,key" }
    )
    .select()
    .single();
  if (error) throw dbError("user_facts", "upsert", error);
  return data;
}

export async function deleteUserFact(db: Db, userId: string, key: string): Promise<boolean> {
  const { data, error } = await db
    .from("user_facts")
    .delete()
    .eq("user_id", userId)
    .eq("key", key)
    .select("id");
  if (error) throw dbError("user_facts", "delete", error);
  return (data?.length ?? 0) > 0;
}
