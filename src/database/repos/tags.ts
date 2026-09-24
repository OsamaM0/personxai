/**
 * Cross-entity tag helpers. Every entity stores `tags text[]` behind a GIN
 * index, so a tag lookup is one indexed query per kind — no join table, no
 * model call. `tagCounts` is the facet source for /tags, the dashboard chips,
 * and the "tags in use" line the model sees every turn.
 */
import { dbError, type Db } from "../client";
import type { Enums } from "../types";

export type TaggableKind = Extract<Enums<"entity_kind">, "task" | "project" | "note" | "file" | "link" | "memory">;
export const TAGGABLE_KINDS: TaggableKind[] = ["task", "project", "note", "file", "link", "memory"];

export interface TagFacet {
  name: string;
  total: number;
  counts: Partial<Record<TaggableKind, number>>;
}

export async function tagCounts(db: Db, userId: string): Promise<TagFacet[]> {
  const { data, error } = await db.rpc("tag_counts", { p_user_id: userId });
  if (error) throw dbError("tag_counts", "rpc", error);
  const byName = new Map<string, TagFacet>();
  for (const row of data ?? []) {
    const facet = byName.get(row.name) ?? { name: row.name, total: 0, counts: {} };
    facet.total += Number(row.count);
    facet.counts[row.kind as TaggableKind] = Number(row.count);
    byName.set(row.name, facet);
  }
  return [...byName.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Most-used tag names, for prompts and autocomplete. */
export async function topTagNames(db: Db, userId: string, limit = 30): Promise<string[]> {
  const facets = await tagCounts(db, userId);
  return facets.slice(0, limit).map((f) => f.name);
}

export interface TaggedHit {
  kind: TaggableKind;
  id: string;
  title: string;
  snippet: string | null;
  tags: string[];
  updatedAt: string;
}

/** Everything carrying ALL of the given tags, across every taggable kind. */
export async function searchByTags(
  db: Db,
  userId: string,
  tags: string[],
  opts: { kinds?: TaggableKind[]; limitPerKind?: number } = {}
): Promise<TaggedHit[]> {
  if (tags.length === 0) return [];
  const kinds = opts.kinds ?? TAGGABLE_KINDS;
  const limit = opts.limitPerKind ?? 25;
  const hits: TaggedHit[] = [];

  const run = async <T>(
    kind: TaggableKind,
    query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
    map: (row: T) => Omit<TaggedHit, "kind">
  ) => {
    if (!kinds.includes(kind)) return;
    const { data, error } = await query;
    if (error) throw dbError(kind, "search_by_tag", error as never);
    for (const row of data ?? []) hits.push({ kind, ...map(row) });
  };

  await Promise.all([
    run(
      "task",
      db.from("tasks").select("id,title,description,tags,updated_at,status")
        .eq("user_id", userId).contains("tags", tags)
        .not("status", "in", "(done,cancelled)").order("updated_at", { ascending: false }).limit(limit),
      (r) => ({ id: r.id, title: r.title, snippet: r.description, tags: r.tags, updatedAt: r.updated_at })
    ),
    run(
      "project",
      db.from("projects").select("id,name,description,tags,updated_at")
        .eq("user_id", userId).contains("tags", tags).neq("status", "archived")
        .order("updated_at", { ascending: false }).limit(limit),
      (r) => ({ id: r.id, title: r.name, snippet: r.description, tags: r.tags, updatedAt: r.updated_at })
    ),
    run(
      "note",
      db.from("notes").select("id,title,content,tags,updated_at")
        .eq("user_id", userId).contains("tags", tags).is("deleted_at", null)
        .order("updated_at", { ascending: false }).limit(limit),
      (r) => ({ id: r.id, title: r.title ?? r.content.slice(0, 60), snippet: r.content.slice(0, 200), tags: r.tags, updatedAt: r.updated_at })
    ),
    run(
      "file",
      db.from("files").select("id,file_name,caption,tags,updated_at")
        .eq("user_id", userId).contains("tags", tags).is("deleted_at", null)
        .order("updated_at", { ascending: false }).limit(limit),
      (r) => ({ id: r.id, title: r.file_name, snippet: r.caption, tags: r.tags, updatedAt: r.updated_at })
    ),
    run(
      "link",
      db.from("links").select("id,title,url,summary,tags,updated_at")
        .eq("user_id", userId).contains("tags", tags).is("deleted_at", null)
        .order("updated_at", { ascending: false }).limit(limit),
      (r) => ({ id: r.id, title: r.title ?? r.url, snippet: r.summary, tags: r.tags, updatedAt: r.updated_at })
    ),
    run(
      "memory",
      db.from("memories").select("id,content,tags,updated_at")
        .eq("user_id", userId).contains("tags", tags).is("deleted_at", null)
        .order("updated_at", { ascending: false }).limit(limit),
      (r) => ({ id: r.id, title: r.content.slice(0, 60), snippet: r.content.slice(0, 200), tags: r.tags, updatedAt: r.updated_at })
    ),
  ]);
  return hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Replace or extend the tags of one entity. Returns the final tag list. */
export async function setEntityTags(
  db: Db,
  userId: string,
  kind: TaggableKind,
  id: string,
  tags: string[],
  mode: "add" | "replace"
): Promise<string[] | null> {
  const table = (
    { task: "tasks", project: "projects", note: "notes", file: "files", link: "links", memory: "memories" } as const
  )[kind];
  const current = await db.from(table).select("tags").eq("user_id", userId).eq("id", id).maybeSingle();
  if (current.error) throw dbError(table, "read_tags", current.error);
  if (!current.data) return null;
  const finalTags = [...new Set(mode === "replace" ? tags : [...current.data.tags, ...tags])];
  const { error } = await db.from(table).update({ tags: finalTags }).eq("user_id", userId).eq("id", id);
  if (error) throw dbError(table, "set_tags", error);
  return finalTags;
}
