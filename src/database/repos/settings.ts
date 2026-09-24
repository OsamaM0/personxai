/** Per-user key/value settings. */
import { dbError, type Db } from "../client";
import type { Json } from "../types";

export async function getAllSettings(db: Db, userId: string): Promise<Record<string, Json>> {
  const { data, error } = await db.from("settings").select("key, value").eq("user_id", userId);
  if (error) throw dbError("settings", "select", error);
  const out: Record<string, Json> = {};
  for (const row of data) out[row.key] = row.value;
  return out;
}

export async function getSetting<T extends Json>(
  db: Db,
  userId: string,
  key: string
): Promise<T | null> {
  const { data, error } = await db
    .from("settings")
    .select("value")
    .eq("user_id", userId)
    .eq("key", key)
    .maybeSingle();
  if (error) throw dbError("settings", "select", error);
  if (!data) return null;
  // Caller asserts the shape of the stored value; a stored JSON null is null.
  return data.value as T | null;
}

export async function setSetting(db: Db, userId: string, key: string, value: Json): Promise<void> {
  // updated_at set explicitly: column defaults do not re-apply on conflict-update.
  const { error } = await db
    .from("settings")
    .upsert(
      { user_id: userId, key, value, updated_at: new Date().toISOString() },
      { onConflict: "user_id,key" }
    );
  if (error) throw dbError("settings", "upsert", error);
}
