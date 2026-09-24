/**
 * Supabase service-role client for Cloudflare Workers.
 *
 * The service role bypasses RLS, so every repo query re-filters by user_id
 * where the table has one (defense in depth against cross-user leaks).
 */
import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

export type Db = SupabaseClient<Database>;

export function createDb(url: string, serviceRoleKey: string): Db {
  // No browser session in a Worker: never persist or refresh auth state.
  return createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Build the concise error repos throw on a Supabase failure. Includes only the
 * table/rpc name, operation, and PostgREST code+message — never the URL, key
 * material, or the error's `details`/`hint` (which can echo row values).
 */
export function dbError(
  table: string,
  op: string,
  error: Pick<PostgrestError, "code" | "message">
): Error {
  return new Error(`db ${table}.${op} failed [${error.code}]: ${error.message}`);
}
