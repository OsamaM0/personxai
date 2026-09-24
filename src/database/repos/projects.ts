import { dbError, type Db } from "../client";
import type { Enums, ProjectRow, TablesInsert, TablesUpdate } from "../types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export async function createProject(db: Db, row: TablesInsert<"projects">): Promise<ProjectRow> {
  const { data, error } = await db.from("projects").insert(row).select().single();
  if (error) throw dbError("projects", "insert", error);
  return data;
}

export async function listProjects(
  db: Db,
  userId: string,
  opts?: { statuses?: Enums<"project_status">[]; limit?: number }
): Promise<ProjectRow[]> {
  let q = db.from("projects").select("*").eq("user_id", userId);
  const statuses = opts?.statuses;
  if (statuses && statuses.length > 0) q = q.in("status", statuses);
  else q = q.not("status", "in", "(archived)");
  const { data, error } = await q
    .order("priority", { ascending: true })
    .order("updated_at", { ascending: false })
    .limit(opts?.limit ?? 25);
  if (error) throw dbError("projects", "list", error);
  return data ?? [];
}

/** Find by uuid, exact slug, or fuzzy name (most recently updated wins). */
export async function findProject(db: Db, userId: string, query: string): Promise<ProjectRow | null> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  if (UUID_RE.test(trimmed)) {
    const { data, error } = await db
      .from("projects")
      .select("*")
      .eq("user_id", userId)
      .eq("id", trimmed)
      .maybeSingle();
    if (error) throw dbError("projects", "find_by_id", error);
    if (data) return data;
  }
  const bySlug = await db
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .eq("slug", slugify(trimmed))
    .maybeSingle();
  if (bySlug.error) throw dbError("projects", "find_by_slug", bySlug.error);
  if (bySlug.data) return bySlug.data;
  const escaped = trimmed.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .ilike("name", `%${escaped}%`)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw dbError("projects", "find_by_name", error);
  return data?.[0] ?? null;
}

export async function updateProject(
  db: Db,
  userId: string,
  projectId: string,
  patch: TablesUpdate<"projects">
): Promise<void> {
  const { error } = await db.from("projects").update(patch).eq("user_id", userId).eq("id", projectId);
  if (error) throw dbError("projects", "update", error);
}

export interface ProjectSummary {
  project: ProjectRow;
  openTasks: number;
  doneTasks: number;
  notes: number;
}

export async function projectSummary(db: Db, userId: string, project: ProjectRow): Promise<ProjectSummary> {
  const [open, done, notes] = await Promise.all([
    db
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("project_id", project.id)
      .in("status", ["inbox", "todo", "in_progress", "waiting", "blocked"]),
    db
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("project_id", project.id)
      .eq("status", "done"),
    db
      .from("notes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("project_id", project.id)
      .is("deleted_at", null),
  ]);
  return {
    project,
    openTasks: open.count ?? 0,
    doneTasks: done.count ?? 0,
    notes: notes.count ?? 0,
  };
}
