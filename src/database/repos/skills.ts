import { dbError, type Db } from "../client";
import type { McpServerRow, SkillRow, SystemPromptRow, TablesInsert, TablesUpdate } from "../types";

// ── Skills ───────────────────────────────────────────────────────────────────

export async function createSkill(db: Db, row: TablesInsert<"skills">): Promise<SkillRow> {
  const { data, error } = await db.from("skills").insert(row).select().single();
  if (error) throw dbError("skills", "insert", error);
  return data;
}

/** A user's own skills plus any global (user_id null) ones. */
export async function listSkills(db: Db, userId: string, enabledOnly = false): Promise<SkillRow[]> {
  let q = db.from("skills").select("*").or(`user_id.eq.${userId},user_id.is.null`);
  if (enabledOnly) q = q.eq("enabled", true);
  const { data, error } = await q.order("name", { ascending: true }).limit(100);
  if (error) throw dbError("skills", "list", error);
  return data ?? [];
}

export async function findSkillByName(db: Db, userId: string, name: string): Promise<SkillRow | null> {
  const { data, error } = await db
    .from("skills")
    .select("*")
    .or(`user_id.eq.${userId},user_id.is.null`)
    .ilike("name", name)
    .limit(1);
  if (error) throw dbError("skills", "find_by_name", error);
  return data?.[0] ?? null;
}

export async function updateSkill(
  db: Db,
  userId: string,
  skillId: string,
  patch: TablesUpdate<"skills">
): Promise<void> {
  const { error } = await db.from("skills").update(patch).eq("user_id", userId).eq("id", skillId);
  if (error) throw dbError("skills", "update", error);
}

export async function deleteSkill(db: Db, userId: string, skillId: string): Promise<boolean> {
  const { data, error } = await db
    .from("skills")
    .delete()
    .eq("user_id", userId)
    .eq("id", skillId)
    .select("id");
  if (error) throw dbError("skills", "delete", error);
  return (data?.length ?? 0) > 0;
}

// ── MCP servers ──────────────────────────────────────────────────────────────

export async function listMcpServers(db: Db, userId: string, enabledOnly = true): Promise<McpServerRow[]> {
  let q = db.from("mcp_servers").select("*").eq("user_id", userId);
  if (enabledOnly) q = q.eq("enabled", true);
  const { data, error } = await q.order("name", { ascending: true }).limit(20);
  if (error) throw dbError("mcp_servers", "list", error);
  return data ?? [];
}

export async function upsertMcpServer(
  db: Db,
  row: TablesInsert<"mcp_servers">
): Promise<McpServerRow> {
  const { data, error } = await db
    .from("mcp_servers")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "user_id,name" })
    .select()
    .single();
  if (error) throw dbError("mcp_servers", "upsert", error);
  return data;
}

export async function updateMcpServer(
  db: Db,
  userId: string,
  serverId: string,
  patch: TablesUpdate<"mcp_servers">
): Promise<void> {
  const { error } = await db
    .from("mcp_servers")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", serverId);
  if (error) throw dbError("mcp_servers", "update", error);
}

export async function deleteMcpServer(db: Db, userId: string, name: string): Promise<boolean> {
  const { data, error } = await db
    .from("mcp_servers")
    .delete()
    .eq("user_id", userId)
    .eq("name", name)
    .select("id");
  if (error) throw dbError("mcp_servers", "delete", error);
  return (data?.length ?? 0) > 0;
}

// ── Versioned personalization layer ──────────────────────────────────────────

export async function getActiveSystemPrompt(db: Db, userId: string): Promise<SystemPromptRow | null> {
  const { data, error } = await db
    .from("system_prompts")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw dbError("system_prompts", "get_active", error);
  return data;
}

/** Deactivate the current row, then insert the next version (partial unique index). */
export async function setSystemPrompt(
  db: Db,
  userId: string,
  content: string,
  createdByRole: "user" | "assistant" = "user",
  description?: string
): Promise<SystemPromptRow> {
  const current = await getActiveSystemPrompt(db, userId);
  if (current) {
    const { error } = await db
      .from("system_prompts")
      .update({ is_active: false })
      .eq("id", current.id);
    if (error) throw dbError("system_prompts", "deactivate", error);
  }
  const { data, error } = await db
    .from("system_prompts")
    .insert({
      user_id: userId,
      prompt_content: content,
      version: (current?.version ?? 0) + 1,
      created_by_role: createdByRole,
      description: description ?? null,
      is_active: true,
    })
    .select()
    .single();
  if (error) throw dbError("system_prompts", "insert", error);
  return data;
}

export async function listSystemPromptVersions(
  db: Db,
  userId: string,
  limit = 10
): Promise<SystemPromptRow[]> {
  const { data, error } = await db
    .from("system_prompts")
    .select("*")
    .eq("user_id", userId)
    .order("version", { ascending: false })
    .limit(limit);
  if (error) throw dbError("system_prompts", "list", error);
  return data ?? [];
}

export async function clearSystemPrompt(db: Db, userId: string): Promise<boolean> {
  const current = await getActiveSystemPrompt(db, userId);
  if (!current) return false;
  const { error } = await db.from("system_prompts").update({ is_active: false }).eq("id", current.id);
  if (error) throw dbError("system_prompts", "clear", error);
  return true;
}
