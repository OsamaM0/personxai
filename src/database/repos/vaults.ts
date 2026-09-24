/**
 * Vault channels — the private Telegram channels a user's files are forwarded
 * to. There is always exactly one default (the env VAULT_CHANNEL_ID, registered
 * lazily); more can be connected, each with a category and tags read from the
 * channel description so the assistant can route files to the right one.
 */
import { dbError, type Db } from "../client";
import type { TablesInsert, TablesUpdate, VaultChannelRow } from "../types";

export async function listVaultChannels(
  db: Db,
  userId: string,
  enabledOnly = false
): Promise<VaultChannelRow[]> {
  let q = db.from("vault_channels").select("*").eq("user_id", userId);
  if (enabledOnly) q = q.eq("enabled", true);
  const { data, error } = await q
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw dbError("vault_channels", "list", error);
  return data ?? [];
}

export async function findVaultByChatId(
  db: Db,
  userId: string,
  chatId: string
): Promise<VaultChannelRow | null> {
  const { data, error } = await db
    .from("vault_channels")
    .select("*")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) throw dbError("vault_channels", "find_by_chat", error);
  return data;
}

/** Find by id, exact chat id, or fuzzy title/category (first match wins). */
export async function findVault(db: Db, userId: string, query: string): Promise<VaultChannelRow | null> {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const rows = await listVaultChannels(db, userId);
  return (
    rows.find((r) => r.id === needle || r.chat_id === needle) ??
    rows.find((r) => (r.title ?? "").toLowerCase() === needle || (r.category ?? "").toLowerCase() === needle) ??
    rows.find(
      (r) =>
        (r.title ?? "").toLowerCase().includes(needle) ||
        (r.category ?? "").toLowerCase().includes(needle) ||
        r.tags.includes(needle)
    ) ??
    null
  );
}

export async function upsertVaultChannel(
  db: Db,
  row: TablesInsert<"vault_channels">
): Promise<VaultChannelRow> {
  const { data, error } = await db
    .from("vault_channels")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "user_id,chat_id" })
    .select()
    .single();
  if (error) throw dbError("vault_channels", "upsert", error);
  return data;
}

export async function updateVaultChannel(
  db: Db,
  userId: string,
  id: string,
  patch: TablesUpdate<"vault_channels">
): Promise<void> {
  const { error } = await db.from("vault_channels").update(patch).eq("user_id", userId).eq("id", id);
  if (error) throw dbError("vault_channels", "update", error);
}

/** Make one channel the default; the partial unique index allows only one. */
export async function setDefaultVault(db: Db, userId: string, id: string): Promise<void> {
  const clear = await db
    .from("vault_channels")
    .update({ is_default: false })
    .eq("user_id", userId)
    .eq("is_default", true);
  if (clear.error) throw dbError("vault_channels", "clear_default", clear.error);
  await updateVaultChannel(db, userId, id, { is_default: true, enabled: true });
}

export async function deleteVaultChannel(db: Db, userId: string, id: string): Promise<boolean> {
  const { data, error } = await db
    .from("vault_channels")
    .delete()
    .eq("user_id", userId)
    .eq("id", id)
    .eq("is_default", false) // the default can be replaced, never removed
    .select("id");
  if (error) throw dbError("vault_channels", "delete", error);
  return (data?.length ?? 0) > 0;
}

/** Files stored per vault channel, for the /vault listing and the dashboard. */
export async function countFilesPerVault(db: Db, userId: string): Promise<Record<string, number>> {
  const { data, error } = await db
    .from("files")
    .select("vault_chat_id")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .not("vault_chat_id", "is", null);
  if (error) throw dbError("files", "count_per_vault", error);
  const out: Record<string, number> = {};
  for (const row of data ?? []) {
    const key = row.vault_chat_id ?? "";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
