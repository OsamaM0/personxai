/**
 * Bot credential resolution.
 *
 * The worker used to read exactly one Telegram token out of the environment.
 * Now the `bots` table is the source of truth and TELEGRAM_BOT_TOKEN is only
 * the first-run bootstrap, so a user can paste a fresh BotFather token into the
 * dashboard and have it live immediately.
 *
 * Rather than thread credentials through every call site (the vault, media
 * downloads, the Mini App verifier and half a dozen others all read
 * `env.TELEGRAM_BOT_TOKEN`), a resolved bot is projected back into a *copy* of
 * the env. Everything downstream keeps working unchanged and automatically uses
 * whichever bot the update arrived on.
 */
import type { Env } from "../env";
import type { Db } from "../database/client";
import type { BotRow } from "../database/types";
import {
  findBotByToken,
  getBotById,
  getDefaultBot,
  insertBot,
  listBots,
  updateBot,
} from "../database/repos/bots";
import { tgCall } from "./telegram/api";
import {
  registerTelegramCommands,
  registerTelegramMenuButton,
  registerTelegramWebhook,
} from "./telegram";
import { log, formatError } from "../utils/logger";
// Re-exported so callers that already reach for the bot registry keep working.
export { requireBotToken } from "./bot-token";

export interface ResolvedBot {
  /** A copy of `env` carrying this bot's token and webhook secret. */
  env: Env;
  /** The stored row, or null when running on the env bootstrap credentials. */
  bot: BotRow | null;
}

/** UUIDs identify a bot in a webhook path; anything else is treated as a username. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Project a bot's credentials onto a copy of the env. Bindings are preserved. */
export function envForBot(env: Env, bot: BotRow): Env {
  return {
    ...env,
    TELEGRAM_BOT_TOKEN: bot.token,
    TELEGRAM_WEBHOOK_SECRET: bot.webhook_secret,
  };
}

/**
 * Resolve the bot an update (or an outbound call) belongs to.
 *
 * `key` is the trailing segment of `/channels/telegram/webhook/<key>` — a bot
 * id. Without one, the channel default answers, and failing that the env
 * bootstrap credentials do, which is what keeps a fresh install working before
 * anyone has opened the dashboard.
 */
export async function resolveBot(
  env: Env,
  db: Db,
  channel: string,
  key?: string | null
): Promise<ResolvedBot | null> {
  if (channel !== "telegram") return { env, bot: null };

  if (key) {
    const bot = UUID_RE.test(key) ? await getBotById(db, key) : null;
    if (!bot || !bot.is_active || bot.channel !== channel) return null;
    return { env: envForBot(env, bot), bot };
  }

  const fallback = await getDefaultBot(db, channel).catch((err) => {
    // A database hiccup must not take the bot offline when env credentials exist.
    log("warn", "bots.default_lookup_failed", { error: formatError(err) });
    return null;
  });
  if (fallback) return { env: envForBot(env, fallback), bot: fallback };
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET) return { env, bot: null };
  return null;
}

/** Resolve by stored id, for a turn that already knows which bot it is on. */
export async function resolveBotById(env: Env, db: Db, botId: string): Promise<Env> {
  const bot = await getBotById(db, botId).catch(() => null);
  return bot && bot.is_active ? envForBot(env, bot) : env;
}

/**
 * Credentials for work that did not arrive on a webhook — the cron dispatcher,
 * scheduled routines, the dashboard and the MCP surface. All of them speak as
 * "the" bot, which is the channel default.
 *
 * Cached briefly in the isolate: without it every dashboard request would pay
 * for a lookup of a single, rarely-changing row. The window is short enough
 * that a token swap takes effect within seconds.
 */
const DEFAULT_BOT_TTL_MS = 30_000;
let defaultBotCache: { at: number; bot: BotRow | null } | null = null;

export async function defaultBotEnv(env: Env, db: Db): Promise<Env> {
  const now = Date.now();
  if (!defaultBotCache || now - defaultBotCache.at > DEFAULT_BOT_TTL_MS) {
    const bot = await getDefaultBot(db, "telegram").catch((err) => {
      log("warn", "bots.default_env_lookup_failed", { error: formatError(err) });
      return null;
    });
    defaultBotCache = { at: now, bot };
  }
  const bot = defaultBotCache.bot;
  return bot ? envForBot(env, bot) : env;
}

/** Drop the cached default so a dashboard change is visible immediately. */
export function invalidateDefaultBotCache(): void {
  defaultBotCache = null;
}

export interface BotIdentity {
  id: string;
  username?: string;
  title?: string;
}

/** getMe — also the check that a pasted token is real before anything is stored. */
export async function fetchBotIdentity(token: string): Promise<BotIdentity> {
  const me = await tgCall<{ id: number; username?: string; first_name?: string }>(token, "getMe");
  if (!me?.id) throw new Error("Telegram accepted the token but returned no bot id");
  const out: BotIdentity = { id: String(me.id) };
  if (me.username) out.username = me.username;
  if (me.first_name) out.title = me.first_name;
  return out;
}

/**
 * The bot's @username, which is what an @mention in a group has to be matched
 * against. A stored row already knows it; the env-bootstrap path does not, so
 * it is fetched once per token and cached for the life of the isolate — group
 * traffic would otherwise be unable to tell "@thisbot" from "@someotherbot".
 *
 * Only group messages need it, so a private chat never pays for the lookup.
 */
const usernameCache = new Map<string, string | null>();

export async function resolveBotUsername(
  bot: BotRow | null,
  token: string | undefined
): Promise<string | undefined> {
  if (bot?.username) return bot.username.toLowerCase();
  if (!token) return undefined;

  const cached = usernameCache.get(token);
  if (cached !== undefined) return cached ?? undefined;

  try {
    const identity = await fetchBotIdentity(token);
    const username = identity.username?.toLowerCase() ?? null;
    usernameCache.set(token, username);
    return username ?? undefined;
  } catch (err) {
    // A getMe failure must not swallow the message; cache the miss so a
    // hammered group does not retry on every line.
    log("warn", "bots.username_lookup_failed", { error: formatError(err) });
    usernameCache.set(token, null);
    return undefined;
  }
}

/** The webhook URL Telegram is pointed at for one stored bot. */
export function webhookUrlFor(baseUrl: string, botId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/channels/telegram/webhook/${botId}`;
}

/**
 * Point Telegram at us for this bot and publish its command menu.
 *
 * Idempotent, and safe to call whenever the public origin changes. Failures of
 * the cosmetic calls (commands, menu button) are reported but do not fail the
 * registration — a bot that can receive updates is already useful.
 */
export async function registerBot(
  db: Db,
  bot: BotRow,
  baseUrl: string
): Promise<{ webhookUrl: string; warning?: string }> {
  const webhookUrl = webhookUrlFor(baseUrl, bot.id);
  await registerTelegramWebhook(bot.token, webhookUrl, bot.webhook_secret);

  let warning: string | undefined;
  try {
    await registerTelegramCommands(bot.token);
    await registerTelegramMenuButton(bot.token, baseUrl);
  } catch (err) {
    warning = formatError(err);
    log("warn", "bots.menu_registration_failed", { botId: bot.id, error: warning });
  }

  await updateBot(db, bot.id, {
    webhook_url: webhookUrl,
    registered_at: new Date().toISOString(),
    last_error: warning ?? null,
  });
  return warning === undefined ? { webhookUrl } : { webhookUrl, warning };
}

/** A per-bot webhook secret. Telegram allows 1–256 chars of [A-Za-z0-9_-]. */
export function newWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Seed the `bots` table from TELEGRAM_BOT_TOKEN the first time someone looks at
 * it, so an install that predates this table shows its existing bot in the
 * dashboard (and can then be edited there) instead of an empty list.
 *
 * Returns the rows the caller should display.
 */
export async function listBotsWithBootstrap(
  env: Env,
  db: Db,
  ownerUserId: string
): Promise<BotRow[]> {
  const rows = await listBots(db);
  if (rows.length > 0 || !env.TELEGRAM_BOT_TOKEN) return rows;

  const existing = await findBotByToken(db, env.TELEGRAM_BOT_TOKEN);
  if (existing) return [existing];

  let identity: BotIdentity | null = null;
  try {
    identity = await fetchBotIdentity(env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    log("warn", "bots.bootstrap_getme_failed", { error: formatError(err) });
  }
  const seeded = await insertBot(db, {
    user_id: ownerUserId,
    channel: "telegram",
    token: env.TELEGRAM_BOT_TOKEN,
    webhook_secret: env.TELEGRAM_WEBHOOK_SECRET || newWebhookSecret(),
    bot_external_id: identity?.id ?? null,
    username: identity?.username ?? null,
    title: identity?.title ?? null,
    is_default: true,
    is_active: true,
  });
  return [seeded];
}
