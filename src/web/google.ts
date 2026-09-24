/**
 * Google account linking for the dashboard.
 *
 * Three steps: the dashboard asks for a consent URL, the browser goes to
 * Google, Google sends it back to /auth/google/callback with a code. The
 * `state` parameter is a short-lived signed token naming the user plus a
 * single-use nonce kept in `settings`, so the account that comes back can only
 * ever be attached to the session that started the flow.
 */
import type { Env } from "../env";
import type { Db } from "../database/client";
import type { Json } from "../database/types";
import { getSetting, setSetting } from "../database/repos/settings";
import { getOAuthAccount, deleteOAuthAccount } from "../database/repos/oauth";
import { insertAudit } from "../database/repos/audit";
import { constantTimeEquals } from "../utils/crypto";
import { log, formatError } from "../utils/logger";
import {
  GOOGLE_PROVIDER,
  GOOGLE_SCOPES,
  exchangeGoogleCode,
  googleAuthUrl,
  googleConfig,
  isGoogleConfigured,
  revokeGoogleToken,
} from "../services/google/oauth";
import { mintToken, randomNonce, verifyToken, webSecret, type MagicPayload } from "./session";
import type { WebSession } from "./auth";
import { HttpError, json } from "./http";

const STATE_SETTING_KEY = "google.oauth";
const STATE_TTL_SECONDS = 10 * 60;

interface StateSetting {
  [key: string]: Json | undefined;
  nonce?: string;
  exp?: number;
}

/** Where the browser lands after the flow, with a message the dashboard shows. */
const backToDashboard = (message: string, ok: boolean): Response =>
  new Response(null, {
    status: 302,
    headers: {
      location: `/#/settings?${ok ? "google" : "error"}=${encodeURIComponent(message)}`,
    },
  });

/**
 * POST /api/google/connect — mint the consent URL.
 *
 * Returns the URL rather than redirecting: the dashboard is a fetch-driven
 * single page, and a 302 out of `fetch()` would be followed invisibly.
 */
export async function handleGoogleConnect(
  env: Env,
  db: Db,
  url: URL,
  session: WebSession,
  nowMs: number
): Promise<Response> {
  const cfg = googleConfig(env, url.origin);
  if (!cfg) {
    throw new HttpError(
      409,
      "this deployment has no Google OAuth client — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (docs/GOOGLE.md)"
    );
  }

  const nonce = randomNonce();
  const exp = Math.floor(nowMs / 1000) + STATE_TTL_SECONDS;
  await setSetting(db, session.user.id, STATE_SETTING_KEY, { nonce, exp });

  // Same token shape as a login link: user + nonce + expiry, its own purpose.
  const state = await mintToken(webSecret(env), "magic", {
    u: session.user.id,
    n: nonce,
    e: exp,
  } satisfies MagicPayload);

  return json({
    url: googleAuthUrl(cfg, state),
    redirectUri: cfg.redirectUri,
    scopes: GOOGLE_SCOPES,
  });
}

/**
 * GET /auth/google/callback — exchange the code and store the tokens.
 *
 * Every failure path redirects back to the dashboard with a readable message
 * rather than rendering an error page: the user is in a browser, mid-flow, and
 * the only useful next step is "try again from Settings".
 */
export async function handleGoogleCallback(
  env: Env,
  db: Db,
  url: URL,
  nowMs: number
): Promise<Response> {
  const denied = url.searchParams.get("error");
  if (denied) return backToDashboard(`Google sign-in was cancelled (${denied})`, false);

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return backToDashboard("Google sent an incomplete response", false);

  const payload = await verifyToken<MagicPayload>(webSecret(env), "magic", state, nowMs);
  if (!payload || typeof payload.n !== "string") {
    return backToDashboard("that Google link expired — start again from Settings", false);
  }

  const stored = ((await getSetting<StateSetting>(db, payload.u, STATE_SETTING_KEY)) ??
    {}) as StateSetting;
  if (!stored.nonce || !constantTimeEquals(stored.nonce, payload.n)) {
    return backToDashboard("that Google link was already used — start again from Settings", false);
  }
  // Burn the nonce before the exchange: a retry must restart the flow.
  await setSetting(db, payload.u, STATE_SETTING_KEY, {});

  const cfg = googleConfig(env, url.origin);
  if (!cfg) return backToDashboard("Google is not configured on this deployment", false);

  try {
    const account = await exchangeGoogleCode(db, cfg, payload.u, code);
    await insertAudit(db, {
      user_id: payload.u,
      actor: "user",
      action: "google.connected",
      entity_kind: "user",
      entity_id: payload.u,
      details: { account: account.account_email },
    }).catch(() => {});
    return backToDashboard(`Connected ${account.account_email ?? "your Google account"}`, true);
  } catch (err) {
    const message = formatError(err);
    log("warn", "google.exchange_failed", { error: message });
    return backToDashboard(`Google refused the connection: ${message}`, false);
  }
}

/** GET /api/google — what the Settings card renders. */
export async function handleGoogleStatus(
  env: Env,
  db: Db,
  url: URL,
  session: WebSession
): Promise<Response> {
  const cfg = googleConfig(env, url.origin);
  if (!isGoogleConfigured(env) || !cfg) {
    return json({
      available: false,
      connected: false,
      reason:
        "no Google OAuth client on this deployment — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (docs/GOOGLE.md)",
    });
  }
  const account = await getOAuthAccount(db, session.user.id, GOOGLE_PROVIDER);
  return json({
    available: true,
    connected: Boolean(account),
    redirectUri: cfg.redirectUri,
    account: account
      ? {
          email: account.account_email,
          scopes: account.scopes,
          connectedAt: account.created_at,
          lastError: account.last_error,
          // The tokens themselves never leave the worker.
          expiresAt: account.expires_at,
        }
      : null,
    features: ["Gmail", "Calendar + Meet", "Tasks", "Contacts"],
  });
}

/** DELETE /api/google — unlink, revoking at Google first when we can. */
export async function handleGoogleDisconnect(
  db: Db,
  session: WebSession
): Promise<Response> {
  const account = await getOAuthAccount(db, session.user.id, GOOGLE_PROVIDER);
  if (!account) return json({ ok: true, connected: false });

  // Revoking the refresh token invalidates the access token with it.
  const token = account.refresh_token ?? account.access_token;
  if (token) await revokeGoogleToken(token);
  await deleteOAuthAccount(db, session.user.id, GOOGLE_PROVIDER);
  await insertAudit(db, {
    user_id: session.user.id,
    actor: "user",
    action: "google.disconnected",
    entity_kind: "user",
    entity_id: session.user.id,
  }).catch(() => {});
  return json({ ok: true, connected: false });
}
