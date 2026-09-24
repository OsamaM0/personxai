/**
 * DO SQLite schema + helpers. The Durable Object stores ONLY ephemeral per-user
 * state — Supabase is the source of truth for everything durable.
 */

export interface SqlExecutor {
  /** Tagged-template SQL from the agents SDK Agent class (this.sql). */
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

export function initDoSchema(a: SqlExecutor): void {
  a.sql`CREATE TABLE IF NOT EXISTS processed_updates (
    update_key TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  )`;
  a.sql`CREATE TABLE IF NOT EXISTS callbacks (
    token TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  )`;
  a.sql`CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`;
  a.sql`CREATE TABLE IF NOT EXISTS media_groups (
    group_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    buffered_at INTEGER NOT NULL
  )`;
}

/** Returns true when this update key was seen before; records it otherwise. Prunes old rows. */
export function seenUpdate(a: SqlExecutor, updateKey: string, now: number): boolean {
  const existing = a.sql<{ update_key: string }>`
    SELECT update_key FROM processed_updates WHERE update_key = ${updateKey}`;
  if (existing.length > 0) return true;
  a.sql`INSERT INTO processed_updates (update_key, seen_at) VALUES (${updateKey}, ${now})`;
  // keep the ring small — anything older than 1h is far beyond Telegram's retry window
  a.sql`DELETE FROM processed_updates WHERE seen_at < ${now - 3_600_000}`;
  return false;
}

export function kvGet(a: SqlExecutor, key: string): string | null {
  const rows = a.sql<{ value: string }>`SELECT value FROM kv WHERE key = ${key}`;
  return rows[0]?.value ?? null;
}

export function kvSet(a: SqlExecutor, key: string, value: string): void {
  a.sql`INSERT INTO kv (key, value) VALUES (${key}, ${value})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
}

export function kvDelete(a: SqlExecutor, key: string): void {
  a.sql`DELETE FROM kv WHERE key = ${key}`;
}
