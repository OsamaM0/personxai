import { dbError, type Db } from "../client";
import type { Enums, TablesInsert, TablesUpdate, TaskRow } from "../types";

const OPEN_STATUSES: Enums<"task_status">[] = ["inbox", "todo", "in_progress", "waiting", "blocked"];

export async function createTask(db: Db, row: TablesInsert<"tasks">): Promise<TaskRow> {
  const { data, error } = await db.from("tasks").insert(row).select().single();
  if (error) throw dbError("tasks", "insert", error);
  return data;
}

export interface TaskFilter {
  statuses?: Enums<"task_status">[];
  projectId?: string;
  dueBefore?: string;
  dueAfter?: string;
  tag?: string;
  overdueOnly?: boolean;
  limit?: number;
}

export async function listTasks(db: Db, userId: string, filter: TaskFilter = {}): Promise<TaskRow[]> {
  let q = db.from("tasks").select("*").eq("user_id", userId);
  const statuses = filter.statuses ?? OPEN_STATUSES;
  q = q.in("status", statuses);
  if (filter.projectId) q = q.eq("project_id", filter.projectId);
  if (filter.dueBefore) q = q.lte("due_at", filter.dueBefore);
  if (filter.dueAfter) q = q.gte("due_at", filter.dueAfter);
  if (filter.overdueOnly) q = q.lt("due_at", new Date().toISOString());
  if (filter.tag) q = q.contains("tags", [filter.tag]);
  const { data, error } = await q
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(filter.limit ?? 25);
  if (error) throw dbError("tasks", "list", error);
  return data ?? [];
}

export async function getTask(db: Db, userId: string, taskId: string): Promise<TaskRow | null> {
  const { data, error } = await db
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw dbError("tasks", "get", error);
  return data;
}

/** Fuzzy-find an open task by title (most recently updated wins). */
export async function findTaskByTitle(db: Db, userId: string, query: string): Promise<TaskRow | null> {
  const escaped = query.trim().replace(/[\\%_]/g, (m) => `\\${m}`);
  if (!escaped) return null;
  const { data, error } = await db
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .in("status", OPEN_STATUSES)
    .ilike("title", `%${escaped}%`)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw dbError("tasks", "find_by_title", error);
  return data?.[0] ?? null;
}

export async function updateTask(
  db: Db,
  userId: string,
  taskId: string,
  patch: TablesUpdate<"tasks">
): Promise<void> {
  const next = { ...patch };
  if (patch.status === "done" && patch.completed_at === undefined) {
    next.completed_at = new Date().toISOString();
  }
  const { error } = await db.from("tasks").update(next).eq("user_id", userId).eq("id", taskId);
  if (error) throw dbError("tasks", "update", error);
}

export async function deleteTask(db: Db, userId: string, taskId: string): Promise<boolean> {
  const { data, error } = await db
    .from("tasks")
    .delete()
    .eq("user_id", userId)
    .eq("id", taskId)
    .select("id");
  if (error) throw dbError("tasks", "delete", error);
  return (data?.length ?? 0) > 0;
}

export async function countOverdueTasks(db: Db, userId: string): Promise<number> {
  const { count, error } = await db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", OPEN_STATUSES)
    .lt("due_at", new Date().toISOString());
  if (error) throw dbError("tasks", "count_overdue", error);
  return count ?? 0;
}
