/**
 * Telegram Mini App sign-in.
 *
 * The dashboard doubles as the bot's Mini App: opened from the chat menu
 * button, Telegram loads this same origin in a webview and hands the page a
 * signed `initData` string. Verifying that signature proves exactly what the
 * magic link in auth.ts proves — possession of the Telegram account — so this
 * route mints the very same session cookie and every /api/* handler downstream
 * stays unchanged.
 */
import type { Env } from "../env";
import type { Db } from "../database/client";
import { findUserByIdentity } from "../database/repos/users";
import { insertAudit } from "../database/repos/audit";
import { constantTimeEquals } from "../channels/telegram/webhook";
import { log } from "../utils/logger";
import {
  SESSION_TTL_SECONDS,
  mintToken,
  sessionCookie,
  webSecret,
  type SessionPayload,
} from "./session";
import { HttpError, json, readJsonBody, requiredStr } from "./http";

/**
 * initData is minted once when the webview opens and never refreshes, so this
 * has to outlast a long-lived Mini App session while still bounding how long a
 * captured string stays spendable.
 */
export const INIT_DATA_MAX_AGE_SECONDS = 24 * 3600;

/** Tolerance for a client clock that runs ahead of ours. */
const CLOCK_SKEW_SECONDS = 300;

/** The only part of initData we act on: which Telegram account is open. */
export interface InitDataUser {
  /** Telegram user id, as the string user_identities stores. */
  id: string;
  username?: string;
  firstName?: string;
  languageCode?: string;
}

const encoder = new TextEncoder();

async function hmac(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Check an initData string against the bot token. Returns the Telegram user it
 * vouches for, or null for anything that fails — forged, tampered, or stale.
 */
export async function verifyInitData(
  botToken: string,
  initData: string,
  nowMs: number,
  maxAgeSeconds = INIT_DATA_MAX_AGE_SECONDS
): Promise<InitDataUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  // Only `hash` leaves the data-check-string. `signature` stays IN: it is
  // excluded from the third-party Ed25519 check, not from this bot-token one,
  // and dropping it here makes every launch fail to verify.
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of params) {
    if (key === "hash") continue;
    pairs.push([key, value]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  // secret_key = HMAC_SHA256(<bot_token>, "WebAppData") — Telegram writes the
  // data first and the key second, so "WebAppData" is the HMAC key here.
  const secretKey = await hmac(encoder.encode("WebAppData"), botToken);
  const expected = toHex(await hmac(secretKey, dataCheckString));
  if (!constantTimeEquals(expected, hash.toLowerCase())) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  const ageSeconds = Math.floor(nowMs / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds || ageSeconds < -CLOCK_SKEW_SECONDS) return null;

  const rawUser = params.get("user");
  if (!rawUser) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    return null;
  }
  const user = parsed as { id?: unknown; username?: unknown; first_name?: unknown; language_code?: unknown };
  if (typeof user?.id !== "number" && typeof user?.id !== "string") return null;

  return {
    id: String(user.id),
    username: typeof user.username === "string" ? user.username : undefined,
    firstName: typeof user.first_name === "string" ? user.first_name : undefined,
    languageCode: typeof user.language_code === "string" ? user.language_code : undefined,
  };
}

/**
 * POST /api/auth/miniapp — trade a verified initData string for a session.
 *
 * No rate limit and no nonce: unlike a magic link there is nothing to spend,
 * and a caller who cannot forge the HMAC gets no further than the check above.
 * The identity must already exist — the Mini App is a second door onto the same
 * account, never a way to create one.
 */
export async function handleMiniAppLogin(
  request: Request,
  env: Env,
  db: Db,
  url: URL,
  nowMs: number
): Promise<Response> {
  const body = await readJsonBody(request);
  const initData = requiredStr(body, "initData", 8192);

  const tgUser = await verifyInitData(env.TELEGRAM_BOT_TOKEN, initData, nowMs);
  if (!tgUser) {
    // No id is logged: a rejection means the string proved nothing, so any
    // identity it claimed is unverified and not worth recording.
    log("warn", "web.miniapp_rejected", {});
    throw new HttpError(401, "this Mini App session could not be verified — reopen it from the bot");
  }

  const resolved = await findUserByIdentity(db, "telegram", tgUser.id);
  if (!resolved || !resolved.user.is_allowed) {
    throw new HttpError(403, "this account cannot sign in — send /start to the bot first");
  }

  const now = Math.floor(nowMs / 1000);
  const cookieValue = await mintToken(webSecret(env), "session", {
    u: resolved.user.id,
    e: now + SESSION_TTL_SECONDS,
    i: now,
  } satisfies SessionPayload);
  await insertAudit(db, {
    user_id: resolved.user.id,
    actor: "user",
    action: "web.signed_in_miniapp",
    entity_kind: "user",
    entity_id: resolved.user.id,
  });

  return json({ ok: true, user: resolved.user }, 200, {
    "set-cookie": sessionCookie(cookieValue, url, SESSION_TTL_SECONDS),
  });
}
