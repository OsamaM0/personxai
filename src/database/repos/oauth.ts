/**
 * Third-party OAuth accounts (Google today).
 *
 * Refresh tokens live here because a turn may need a fresh access token hours
 * after the user last touched the dashboard. One row per (user, provider).
 */
import { dbError, type Db } from "../client";
import type { OAuthAccountRow, TablesUpdate } from "../types";

export async function getOAuthAccount(
  db: Db,
  userId: string,
  provider: string
): Promise<OAuthAccountRow | null> {
  const { data, error } = await db
    .from("oauth_accounts")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw dbError("oauth_accounts", "select", error);
  return data;
}

export interface OAuthUpsert {
  userId: string;
  provider: string;
  accountId?: string | null;
  accountEmail?: string | null;
  accessToken: string;
  /** Google only returns one on the first consent — keep the stored one otherwise. */
  refreshToken?: string | null;
  expiresAt: string | null;
  scopes: string[];
}

export async function upsertOAuthAccount(db: Db, input: OAuthUpsert): Promise<OAuthAccountRow> {
  const row: TablesUpdate<"oauth_accounts"> & { user_id: string; provider: string } = {
    user_id: input.userId,
    provider: input.provider,
    account_id: input.accountId ?? null,
    account_email: input.accountEmail ?? null,
    access_token: input.accessToken,
    expires_at: input.expiresAt,
    scopes: input.scopes,
    last_error: null,
    updated_at: new Date().toISOString(),
  };
  // A re-consent without a refresh token must not erase the one we already hold.
  if (input.refreshToken) row.refresh_token = input.refreshToken;

  const { data, error } = await db
    .from("oauth_accounts")
    .upsert(row, { onConflict: "user_id,provider" })
    .select()
    .single();
  if (error) throw dbError("oauth_accounts", "upsert", error);
  return data;
}

export async function updateOAuthAccount(
  db: Db,
  id: string,
  patch: TablesUpdate<"oauth_accounts">
): Promise<void> {
  const { error } = await db.from("oauth_accounts").update(patch).eq("id", id);
  if (error) throw dbError("oauth_accounts", "update", error);
}

export async function deleteOAuthAccount(db: Db, userId: string, provider: string): Promise<void> {
  const { error } = await db
    .from("oauth_accounts")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) throw dbError("oauth_accounts", "delete", error);
}
