/**
 * Google OAuth 2.0 — authorization-code flow with offline access.
 *
 * One OAuth client per deployment (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET);
 * each user then grants access from the dashboard and their tokens land in
 * `oauth_accounts`. Access tokens are short-lived, so every API call goes
 * through `googleAccessToken`, which refreshes and re-persists on demand.
 *
 * Everything here uses only APIs that are free on a personal Google account:
 * Gmail, Calendar (including Meet links), Tasks and People.
 */
import type { Env } from "../../env";
import type { Db } from "../../database/client";
import type { OAuthAccountRow } from "../../database/types";
import {
  getOAuthAccount,
  updateOAuthAccount,
  upsertOAuthAccount,
} from "../../database/repos/oauth";
import { log, formatError } from "../../utils/logger";

export const GOOGLE_PROVIDER = "google";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** Refresh this long before the token actually dies, so a call never races it. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * The scopes we ask for, and why:
 *   gmail.readonly  read and search mail; the assistant summarises, never deletes
 *   gmail.send      reply to a thread / send a message the user dictated
 *   calendar.events read and write events — this is what creates a Meet link
 *   tasks           two-way with the user's own Google task lists
 *   contacts.readonly  resolve "invite Sara" to an address
 *   userinfo.email  so the dashboard can show which account is connected
 */
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts.readonly",
] as const;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** True when the deployment has an OAuth client, i.e. Google can be offered at all. */
export function isGoogleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/**
 * The OAuth client for this deployment. `origin` is the dashboard's own origin,
 * used to build the redirect URI when GOOGLE_REDIRECT_URI is not pinned — the
 * URI must match one registered in the Google Cloud console exactly.
 */
export function googleConfig(env: Env, origin: string): GoogleOAuthConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const redirectUri =
    env.GOOGLE_REDIRECT_URI ||
    `${(env.PUBLIC_BASE_URL || origin).replace(/\/+$/, "")}/auth/google/callback`;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  };
}

/**
 * Consent URL. `state` is a signed value minted by the caller and checked on
 * the way back, so a third party cannot attach their Google account to someone
 * else's session.
 *
 * `access_type=offline` + `prompt=consent` is what makes Google hand over a
 * refresh token; without the prompt it only issues one on the very first
 * consent ever, and a user who re-connects would silently lose the ability to
 * refresh.
 */
export function googleAuthUrl(cfg: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    // Google's error bodies name the problem but never echo the secret.
    throw new Error(
      `Google token request failed (${res.status})${json.error ? `: ${json.error}` : ""}${
        json.error_description ? ` — ${json.error_description}` : ""
      }`
    );
  }
  return json;
}

const expiryFrom = (expiresIn: number | undefined): string | null =>
  expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

/** Look up which account just consented, so the dashboard can name it. */
async function fetchUserInfo(accessToken: string): Promise<{ sub?: string; email?: string }> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return {};
    return (await res.json()) as { sub?: string; email?: string };
  } catch {
    return {};
  }
}

/** Exchange the callback's `code` for tokens and store them against the user. */
export async function exchangeGoogleCode(
  db: Db,
  cfg: GoogleOAuthConfig,
  userId: string,
  code: string
): Promise<OAuthAccountRow> {
  const token = await postToken(
    new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    })
  );
  const accessToken = token.access_token as string;
  const info = await fetchUserInfo(accessToken);

  return upsertOAuthAccount(db, {
    userId,
    provider: GOOGLE_PROVIDER,
    accountId: info.sub ?? null,
    accountEmail: info.email ?? null,
    accessToken,
    refreshToken: token.refresh_token ?? null,
    expiresAt: expiryFrom(token.expires_in),
    scopes: (token.scope ?? GOOGLE_SCOPES.join(" ")).split(" ").filter(Boolean),
  });
}

export class GoogleNotConnectedError extends Error {
  constructor(message = "Google is not connected — link it on the dashboard's Settings page") {
    super(message);
    this.name = "GoogleNotConnectedError";
  }
}

/**
 * A usable access token for this user, refreshing first when the stored one is
 * spent. Throws GoogleNotConnectedError when there is nothing to refresh, which
 * tools turn into a plain "connect Google first" answer.
 */
export async function googleAccessToken(env: Env, db: Db, userId: string): Promise<string> {
  const account = await getOAuthAccount(db, userId, GOOGLE_PROVIDER);
  if (!account) throw new GoogleNotConnectedError();

  const expiresAt = account.expires_at ? Date.parse(account.expires_at) : 0;
  if (account.access_token && expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return account.access_token;
  }
  if (!account.refresh_token) {
    throw new GoogleNotConnectedError(
      "Google access has expired and there is no refresh token — reconnect it on the dashboard"
    );
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GoogleNotConnectedError("this deployment has no Google OAuth client configured");
  }

  try {
    const token = await postToken(
      new URLSearchParams({
        refresh_token: account.refresh_token,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: "refresh_token",
      })
    );
    const accessToken = token.access_token as string;
    await updateOAuthAccount(db, account.id, {
      access_token: accessToken,
      expires_at: expiryFrom(token.expires_in),
      last_error: null,
      updated_at: new Date().toISOString(),
    });
    return accessToken;
  } catch (err) {
    const message = formatError(err);
    // Recorded so the dashboard can say "reconnect" instead of failing silently.
    await updateOAuthAccount(db, account.id, { last_error: message }).catch(() => {});
    log("warn", "google.refresh_failed", { error: message });
    throw new GoogleNotConnectedError(`Google refresh failed — reconnect it on the dashboard`);
  }
}

/** Best-effort revoke at Google; the local row is deleted by the caller either way. */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log("warn", "google.revoke_failed", { error: formatError(err) });
  }
}
