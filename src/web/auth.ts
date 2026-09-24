/**
 * Dashboard authentication.
 *
 * The chat bot IS the identity provider: there is no password and no third
 * party. A login link is minted only for an identity that already exists in
 * user_identities and is delivered over that identity's chat channel (Telegram
 * or WhatsApp), so possession of the chat account is the credential. The link
 * carries a single-use nonce (stored in `settings`) and expires in 10 minutes;
 * redeeming it sets an HttpOnly session cookie.
 */
import type { Env } from "../env";
import type { Db } from "../database/client";
import type { Json, UserIdentityRow, UserRow } from "../database/types";
import { findAnyIdentityByUser, findOwnerUser, getUserById } from "../database/repos/users";
import { getSetting, setSetting } from "../database/repos/settings";
import { insertAudit } from "../database/repos/audit";
import { tgCall } from "../channels/telegram/api";
import { getAdapter } from "../channels/registry";
import { takeToken, type BucketState } from "../security/ratelimit";
import { constantTimeEquals } from "../utils/crypto";
import { log, formatError } from "../utils/logger";
import {
  MAGIC_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearedSessionCookie,
  mintToken,
  randomNonce,
  readCookie,
  sessionCookie,
  verifyToken,
  webSecret,
  type MagicPayload,
  type SessionPayload,
} from "./session";
import { HttpError, json, unauthorized } from "./http";

const LOGIN_SETTING_KEY = "web.login";
/** Three links up front, then one more per minute. */
const LOGIN_BUCKET = { capacity: 3, refillPerMinute: 1 };

/** Shape stored in `settings`; the index signature is what makes it a `Json`. */
interface LoginState {
  [key: string]: Json | undefined;
  nonce?: string;
  exp?: number;
  bucket?: { [key: string]: Json | undefined; tokens: number; lastRefillMs: number } | null;
}

const toJsonBucket = (b: BucketState) => ({ tokens: b.tokens, lastRefillMs: b.lastRefillMs });

const toBucket = (b: LoginState["bucket"]): BucketState | null =>
  b ? { tokens: b.tokens, lastRefillMs: b.lastRefillMs } : null;

export interface WebSession {
  user: UserRow;
  identity: UserIdentityRow;
  /** Channel-native chat to reach this user on. */
  chatRef: string;
}

/**
 * The worker's own public origin. Preferred source is PUBLIC_BASE_URL; failing
 * that we ask Telegram which URL the webhook was registered at, which is this
 * worker by construction — so no extra configuration is ever required.
 */
export async function publicBaseUrl(env: Env): Promise<string | null> {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  try {
    const info = await tgCall<{ url?: string }>(env.TELEGRAM_BOT_TOKEN, "getWebhookInfo");
    if (!info?.url) return null;
    return new URL(info.url).origin;
  } catch (err) {
    log("warn", "web.base_url_lookup_failed", { error: formatError(err) });
    return null;
  }
}

/**
 * Mint a login link and DM it to the user. Rate-limited per user; the returned
 * flag says whether a message was actually sent.
 */
export async function issueLoginLink(
  env: Env,
  db: Db,
  user: UserRow,
  channel: string,
  chatRef: string,
  baseUrl: string,
  nowMs: number
): Promise<{ sent: boolean; reason?: string }> {
  const adapter = getAdapter(channel);
  if (!adapter) return { sent: false, reason: `unknown channel ${channel}` };

  const state = ((await getSetting<LoginState>(db, user.id, LOGIN_SETTING_KEY)) ?? {}) as LoginState;
  const limit = takeToken(toBucket(state.bucket), nowMs, LOGIN_BUCKET);
  if (!limit.allowed) {
    await setSetting(db, user.id, LOGIN_SETTING_KEY, { ...state, bucket: toJsonBucket(limit.state) });
    return { sent: false, reason: "too many login links requested — try again in a minute" };
  }

  const nonce = randomNonce();
  const exp = Math.floor(nowMs / 1000) + MAGIC_TTL_SECONDS;
  // Store the nonce BEFORE sending: a delivered link whose nonce was never
  // persisted would be unredeemable, which is the worse failure.
  await setSetting(db, user.id, LOGIN_SETTING_KEY, { nonce, exp, bucket: toJsonBucket(limit.state) });

  const token = await mintToken(webSecret(env), "magic", {
    u: user.id,
    n: nonce,
    e: exp,
  } satisfies MagicPayload);
  const link = `${baseUrl.replace(/\/+$/, "")}/auth/callback?t=${encodeURIComponent(token)}`;

  const out = adapter.outbound(env);
  // Plain text: Markdown parsing would mangle the token's `-`/`_` characters.
  // disablePreview is load-bearing, not cosmetic: Telegram fetches a previewed
  // URL from its own servers within a second of the send.
  await out.sendText(
    chatRef,
    `Dashboard sign-in link (valid 10 minutes, one use):\n${link}\n\nIf you did not ask for this, ignore it.`,
    { markdown: false, disablePreview: true }
  );
  await insertAudit(db, {
    user_id: user.id,
    actor: "user",
    action: "web.login_link_issued",
    entity_kind: "user",
    entity_id: user.id,
  });
  return { sent: true };
}

/**
 * Check a login token's signature and expiry WITHOUT touching stored state.
 * Safe to run on a GET: link previewers and scanners must not be able to spend
 * a nonce simply by fetching the URL.
 */
export async function inspectLoginToken(
  env: Env,
  token: string,
  nowMs: number
): Promise<MagicPayload | null> {
  const payload = await verifyToken<MagicPayload>(webSecret(env), "magic", token, nowMs);
  return payload && typeof payload.n === "string" ? payload : null;
}

/** Redeem a magic link: verify, burn the nonce, return the session cookie value. */
export async function consumeLoginToken(
  env: Env,
  db: Db,
  token: string,
  nowMs: number
): Promise<{ cookieValue: string; user: UserRow } | { error: string }> {
  const payload = await verifyToken<MagicPayload>(webSecret(env), "magic", token, nowMs);
  if (!payload || typeof payload.n !== "string") {
    return { error: "this link is invalid or has expired" };
  }

  const state = ((await getSetting<LoginState>(db, payload.u, LOGIN_SETTING_KEY)) ?? {}) as LoginState;
  if (!state.nonce || !constantTimeEquals(state.nonce, payload.n)) {
    return { error: "this link has already been used — request a new one" };
  }

  const user = await getUserById(db, payload.u);
  if (!user || !user.is_allowed) return { error: "this account cannot sign in" };

  // Burn the nonce, keep the rate-limit bucket.
  await setSetting(db, user.id, LOGIN_SETTING_KEY, { bucket: state.bucket ?? null });

  const now = Math.floor(nowMs / 1000);
  const cookieValue = await mintToken(webSecret(env), "session", {
    u: user.id,
    e: now + SESSION_TTL_SECONDS,
    i: now,
  } satisfies SessionPayload);
  await insertAudit(db, {
    user_id: user.id,
    actor: "user",
    action: "web.signed_in",
    entity_kind: "user",
    entity_id: user.id,
  });
  return { cookieValue, user };
}

/** Resolve the session cookie to a live user, or null when signed out. */
export async function resolveSession(
  request: Request,
  env: Env,
  db: Db,
  nowMs: number
): Promise<WebSession | null> {
  const payload = await verifyToken<SessionPayload>(
    webSecret(env),
    "session",
    readCookie(request, SESSION_COOKIE),
    nowMs
  );
  if (!payload) return null;

  const user = await getUserById(db, payload.u);
  // Revoking access in Postgres must log the session out on its next request.
  if (!user || !user.is_allowed) return null;

  const identity = await findAnyIdentityByUser(db, user.id);
  if (!identity) return null;
  return { user, identity, chatRef: identity.chat_ref ?? identity.external_id };
}

export function requireSession(session: WebSession | null): WebSession {
  if (!session) throw unauthorized();
  return session;
}

/**
 * POST /api/auth/request — send the owner a login link.
 *
 * Takes no input on purpose: the recipient is always the owner account, so an
 * unauthenticated caller can neither enumerate users nor aim a message at
 * anyone else. Other users get their link from the bot's /dashboard command,
 * where the chat channel has already proved who they are.
 *
 * The link is built on PUBLIC_BASE_URL when set — that is the origin the
 * browser is on when the dashboard is hosted in front of the Worker
 * (docs/VERCEL.md) — and on the request origin otherwise.
 */
export async function handleLoginRequest(
  env: Env,
  db: Db,
  url: URL,
  nowMs: number
): Promise<Response> {
  const owner = await findOwnerUser(db);
  const identity = owner ? await findAnyIdentityByUser(db, owner.id) : null;
  if (!owner || !owner.is_allowed || !identity) {
    throw new HttpError(409, "no owner account yet — send /start to the bot first");
  }
  const chatRef = identity.chat_ref ?? identity.external_id;
  const baseUrl = env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || url.origin;
  const result = await issueLoginLink(env, db, owner, identity.channel, chatRef, baseUrl, nowMs);
  if (!result.sent) throw new HttpError(429, result.reason ?? "rate limited");
  return json({ ok: true, sent: true, via: identity.channel });
}

/** Base64url body + signature — the only shape a minted token can take. */
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const errorRedirect = (message: string): Response =>
  new Response(null, { status: 302, headers: { location: `/?error=${encodeURIComponent(message)}` } });

/**
 * The sign-in page a login link opens.
 *
 * It exists so that redeeming is a POST. Preview crawlers, link scanners and
 * browser prefetchers issue GETs and never submit forms, so none of them can
 * spend the nonce; the script auto-submits, keeping it one tap for a real
 * browser, and the button covers the no-JavaScript case.
 */
function loginPage(token: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<!-- The token is in this URL, so keep the Referer inside this origin. NOT
     no-referrer: that makes the browser send "Origin: null" on the POST below,
     which the same-origin guard would then reject. The script scrubs the token
     out of the URL before submitting, so the Referer carries no secret. -->
<meta name="referrer" content="same-origin">
<title>Sign in · PersonXAI</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="login">
  <div class="login-card">
    <div class="brand">
      <span class="brand-mark">X</span>
      <div><h1>PersonXAI</h1><p class="muted">Signing you in…</p></div>
    </div>
    <form id="redeem" method="POST" action="/api/auth/redeem">
      <input type="hidden" name="t" value="${token}">
      <button class="btn btn-primary btn-block" type="submit">Sign in</button>
    </form>
    <p class="muted small" style="margin-top:14px">This link works once and expires 10 minutes after it was sent.</p>
  </div>
</main>
<script>
// Drop the token from the address bar (and therefore from the Referer) before
// submitting; the value the POST needs is in the hidden field, not the URL.
try { history.replaceState(null, "", "/auth/callback"); } catch (e) {}
document.getElementById("redeem").submit();
</script>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Never let a token-bearing page sit in a cache.
      "cache-control": "no-store, no-cache, must-revalidate",
      "referrer-policy": "same-origin",
    },
  });
}

/**
 * GET /auth/callback?t=… — show the sign-in page.
 * Signature and expiry are checked here so a stale link fails immediately, but
 * the nonce is left untouched: only the POST below can spend it.
 */
export async function handleLoginCallback(env: Env, url: URL, nowMs: number): Promise<Response> {
  const token = url.searchParams.get("t") ?? "";
  if (!TOKEN_RE.test(token)) return errorRedirect("this link is malformed");
  const payload = await inspectLoginToken(env, token, nowMs);
  if (!payload) return errorRedirect("this link is invalid or has expired");
  return loginPage(token);
}

/**
 * POST /api/auth/redeem — spend the nonce and start the session.
 *
 * Accepts the form encoding the sign-in page submits; the same-origin check in
 * handleApi has already run.
 */
export async function handleLoginRedeem(
  request: Request,
  env: Env,
  db: Db,
  url: URL,
  nowMs: number
): Promise<Response> {
  let token = "";
  try {
    const form = await request.formData();
    token = String(form.get("t") ?? "");
  } catch {
    return errorRedirect("this link could not be read");
  }
  if (!TOKEN_RE.test(token)) return errorRedirect("this link is malformed");

  const result = await consumeLoginToken(env, db, token, nowMs);
  if ("error" in result) return errorRedirect(result.error);

  return new Response(null, {
    status: 302,
    headers: {
      location: "/",
      "set-cookie": sessionCookie(result.cookieValue, url, SESSION_TTL_SECONDS),
    },
  });
}

export function handleLogout(url: URL): Response {
  return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie(url) });
}
