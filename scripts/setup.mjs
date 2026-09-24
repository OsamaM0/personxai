#!/usr/bin/env node
/**
 * PersonXAI one-command setup wizard.
 *
 *   npm run setup
 *
 * Walks a first-time user from "I have a Cloudflare, Supabase and Telegram
 * account" to a live bot with the webhook and command menu registered, without
 * reading any docs. Zero dependencies — Node 20+ only. Everything it writes is
 * git-ignored (secrets.json, .dev.vars). Re-running is safe: every step is
 * idempotent and existing values are offered as defaults.
 *
 * What it does, in order:
 *   1. Telegram   — verifies the bot token (getMe), auto-detects your user id
 *                   and the vault channel id from getUpdates.
 *   2. Supabase   — takes URL + service_role key, checks the schema is applied
 *                   (and tells you exactly where to paste supabase/schema.sql).
 *   3. LLM        — picks a preset and its key.
 *   4. Secrets    — generates the random ones, writes secrets.json + .dev.vars.
 *   5. Cloudflare — wrangler login → deploy → secret bulk → deploy.
 *   6. Webhook    — POST /admin/register-webhook (webhook + "/" menu + description).
 *   7. Verify     — GET /health and getWebhookInfo.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rl = createInterface({ input: stdin, output: stdout });
const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const say = (s = "") => console.log(s);
const ok = (s) => say(c.green("  ✔ ") + s);
const warn = (s) => say(c.yellow("  ! ") + s);
const fail = (s) => say(c.red("  ✖ ") + s);
const step = (n, title) => say(`\n${c.bold(c.cyan(`Step ${n}`))} ${c.bold(title)}\n`);
// Self-hosting instead? docker-compose.yml + docs/DOCKER.md reuse the .dev.vars this wizard writes.

const UA = { "user-agent": "personxai-setup/1.0" };
const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";

function run(cmd, args, opts = {}) {
  say(c.dim(`  $ ${cmd} ${args.join(" ")}`));
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: opts.capture ? "pipe" : "inherit", shell: isWin, encoding: "utf8" });
  if (res.status !== 0 && !opts.allowFail) {
    fail(`${cmd} exited with ${res.status}`);
    if (opts.capture) say(res.stdout + res.stderr);
    process.exit(1);
  }
  return res;
}

async function ask(label, { def, secret = false, validate, help } = {}) {
  if (help) say(c.dim("  " + help));
  for (;;) {
    const suffix = def ? c.dim(` [${secret ? mask(def) : def}]`) : "";
    const raw = (await rl.question(`  ${label}${suffix}: `)).trim();
    const value = raw || def || "";
    if (!value) { warn("required"); continue; }
    const err = validate?.(value);
    if (err) { warn(err); continue; }
    return value;
  }
}
const mask = (s) => (s.length <= 8 ? "••••" : s.slice(0, 4) + "…" + s.slice(-4));
const yes = async (q, def = true) => /^y/i.test((await rl.question(`  ${q} ${def ? "[Y/n]" : "[y/N]"}: `)).trim() || (def ? "y" : "n"));

function loadExisting() {
  const out = {};
  const secretsPath = join(ROOT, "secrets.json");
  if (existsSync(secretsPath)) {
    try { Object.assign(out, JSON.parse(readFileSync(secretsPath, "utf8"))); } catch {}
  }
  const devVars = join(ROOT, ".dev.vars");
  if (existsSync(devVars)) {
    for (const line of readFileSync(devVars, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in out)) out[m[1]] = m[2].trim();
    }
  }
  for (const k of Object.keys(out)) if (/REPLACE|your-|123456:ABC|^gsk_\.\.\.$|^sk-/.test(out[k]) && /\.\.\.$/.test(out[k])) delete out[k];
  return out;
}

async function tg(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json", ...UA }, body: JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description ?? `${method} failed (${r.status})`);
  return j.result;
}

// ─────────────────────────────────────────────────────────────────────────────

say(c.bold("\nPersonXAI setup — a personal AI assistant in Telegram, on Cloudflare Workers + Supabase.\n"));
say("You'll need (all free): a Telegram account, a Cloudflare account, a Supabase project.");
say("Docs with screenshots: docs/DEPLOYMENT.md. Press Enter to accept a [default].\n");

const S = loadExisting();

// 1 ── Telegram ───────────────────────────────────────────────────────────────
step(1, "Telegram bot");
say("  Open @BotFather in Telegram → /newbot → copy the token it gives you.");
let me;
S.TELEGRAM_BOT_TOKEN = await ask("Bot token", {
  def: S.TELEGRAM_BOT_TOKEN, secret: true,
  validate: (v) => (/^\d+:[\w-]{30,}$/.test(v) ? null : "doesn't look like a bot token (123456:ABC…)"),
});
try {
  me = await tg(S.TELEGRAM_BOT_TOKEN, "getMe");
  ok(`token works — bot is @${me.username}`);
} catch (e) {
  fail(`Telegram rejected the token: ${e.message}`);
  process.exit(1);
}

say("\n  Now the private file vault: create a PRIVATE CHANNEL (not a group) and add");
say(`  @${me.username} as an administrator with permission to post messages.`);
say("  Then, so the wizard can read the ids for you:");
say(`    • send /start to @${me.username} from YOUR account`);
say("    • post any message (e.g. \"vault\") in the private channel");
await rl.question(c.dim("  Press Enter when both are done… "));

let detectedOwner, detectedChannel;
try {
  const info = await tg(S.TELEGRAM_BOT_TOKEN, "getWebhookInfo");
  if (info.url) {
    // getUpdates is unavailable while a webhook is set; the wizard registers it again in step 6.
    await tg(S.TELEGRAM_BOT_TOKEN, "deleteWebhook", { drop_pending_updates: false });
  }
  const updates = await tg(S.TELEGRAM_BOT_TOKEN, "getUpdates", { allowed_updates: ["message", "channel_post"], limit: 100 });
  for (const u of updates) {
    if (u.message?.chat?.type === "private") detectedOwner = { id: String(u.message.from.id), name: u.message.from.first_name };
    if (u.channel_post?.chat?.type === "channel") detectedChannel = { id: String(u.channel_post.chat.id), title: u.channel_post.chat.title };
  }
  if (detectedOwner) ok(`your Telegram id is ${detectedOwner.id} (${detectedOwner.name})`);
  else warn("couldn't see a DM from you — you can type the id manually (DM @userinfobot to get it)");
  if (detectedChannel) ok(`vault channel "${detectedChannel.title}" id is ${detectedChannel.id}`);
  else warn("couldn't see a channel post — forward a post from the channel to @userinfobot to get its id (-100…)");
} catch (e) {
  warn(`auto-detect failed (${e.message}); enter the ids manually`);
}
S.OWNER_TELEGRAM_ID = await ask("Your Telegram user id", {
  def: detectedOwner?.id ?? S.OWNER_TELEGRAM_ID, validate: (v) => (/^\d{5,}$/.test(v) ? null : "numeric id expected"),
});
S.VAULT_CHANNEL_ID = await ask("Vault channel id", {
  def: detectedChannel?.id ?? S.VAULT_CHANNEL_ID, validate: (v) => (/^-100\d+$/.test(v) ? null : "channel ids look like -1001234567890"),
});
try {
  const member = await tg(S.TELEGRAM_BOT_TOKEN, "getChatMember", { chat_id: S.VAULT_CHANNEL_ID, user_id: me.id });
  if (member.status === "administrator" || member.status === "creator") ok("bot is an admin of the vault channel");
  else warn(`bot is "${member.status}" in the vault channel — make it an administrator or file storage will fail`);
} catch (e) {
  warn(`couldn't verify channel membership: ${e.message}`);
}

// 2 ── Supabase ───────────────────────────────────────────────────────────────
step(2, "Supabase (Postgres + pgvector)");
say("  Create a free project at https://database.new, then open Project Settings → API.");
S.SUPABASE_URL = await ask("Project URL", {
  def: S.SUPABASE_URL, validate: (v) => (/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(v) ? null : "expected https://<ref>.supabase.co"),
});
S.SUPABASE_URL = S.SUPABASE_URL.replace(/\/+$/, "");
S.SUPABASE_SERVICE_ROLE_KEY = await ask("service_role key (secret, NOT anon)", {
  def: S.SUPABASE_SERVICE_ROLE_KEY, secret: true, validate: (v) => (v.length > 20 ? null : "too short"),
});
const ref = S.SUPABASE_URL.match(/https:\/\/([a-z0-9-]+)\.supabase\.co/)[1];
async function schemaApplied() {
  const r = await fetch(`${S.SUPABASE_URL}/rest/v1/mcp_servers?select=id&limit=1`, {
    headers: { apikey: S.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${S.SUPABASE_SERVICE_ROLE_KEY}`, ...UA },
  });
  if (r.status === 401) throw new Error("service_role key rejected (401)");
  return r.ok;
}
for (;;) {
  let applied = false;
  try { applied = await schemaApplied(); } catch (e) { fail(e.message); process.exit(1); }
  if (applied) { ok("schema is applied (all migrations present)"); break; }
  warn("schema not applied yet. Two ways:");
  say(`     a) Open  ${c.cyan(`https://supabase.com/dashboard/project/${ref}/sql/new`)}`);
  say(`        paste the whole file  ${c.cyan("supabase/schema.sql")}  and press Run.`);
  say("     b) With the Supabase CLI:  supabase link --project-ref " + ref + " && supabase db push");
  await rl.question(c.dim("  Press Enter to re-check… "));
}

// 3 ── LLM ────────────────────────────────────────────────────────────────────
step(3, "Language model");
const PRESETS = {
  cloudflare: { note: "zero external accounts — Workers AI for everything ($0)", key: null },
  groq: { note: "best free tool calling, very fast ($0) — key from https://console.groq.com/keys", key: "GROQ_API_KEY" },
  openrouter: { note: "widest choice of :free models ($0) — key from https://openrouter.ai/keys", key: "OPENROUTER_API_KEY" },
  openai: { note: "gpt-4.1 / whisper-1 (paid)", key: "OPENAI_API_KEY" },
  custom: { note: "any OpenAI-compatible endpoint (self-hosted, proxy, new provider)", key: "LLM_API_KEY" },
};
for (const [name, p] of Object.entries(PRESETS)) say(`    ${c.bold(name.padEnd(11))} ${p.note}`);
S.LLM_PRESET = await ask("Preset", { def: S.LLM_PRESET ?? "groq", validate: (v) => (v in PRESETS ? null : "pick one of the names above") });
const preset = PRESETS[S.LLM_PRESET];
if (preset.key) S[preset.key] = await ask(preset.key, { def: S[preset.key], secret: true, validate: (v) => (v.length > 8 ? null : "too short") });
if (S.LLM_PRESET === "custom") {
  S.LLM_BASE_URL = await ask("LLM_BASE_URL", { def: S.LLM_BASE_URL, validate: (v) => (/^https?:\/\//.test(v) ? null : "must be a URL") });
  S.LLM_MAIN_MODEL = await ask("LLM_MAIN_MODEL", { def: S.LLM_MAIN_MODEL });
  S.LLM_CLASSIFIER_MODEL = await ask("LLM_CLASSIFIER_MODEL (smaller/faster; Enter = same as main)", { def: S.LLM_CLASSIFIER_MODEL ?? S.LLM_MAIN_MODEL });
}
ok(`preset ${S.LLM_PRESET}`);

// 3b ── WhatsApp (optional) ───────────────────────────────────────────────────
step("3b", "WhatsApp (optional — same brain, second channel)");
say("  Needs a Meta app with the WhatsApp product: https://developers.facebook.com/apps → your app → WhatsApp → API Setup.");
say("  Skip now and add it later with docs/WHATSAPP.md; nothing else depends on it.");
const WA_KEYS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "OWNER_WHATSAPP_ID"];
if (await yes("Connect WhatsApp?", WA_KEYS.some((k) => S[k]))) {
  S.WHATSAPP_ACCESS_TOKEN = await ask("Access token (a permanent System User token, not the 24h test one)", {
    def: S.WHATSAPP_ACCESS_TOKEN, secret: true, validate: (v) => (v.length > 20 ? null : "too short"),
  });
  S.WHATSAPP_PHONE_NUMBER_ID = await ask("Phone number ID (API Setup → \"Phone number ID\", digits)", {
    def: S.WHATSAPP_PHONE_NUMBER_ID, validate: (v) => (/^\d{5,}$/.test(v) ? null : "digits expected"),
  });
  S.WHATSAPP_APP_SECRET = await ask("App secret (App settings → Basic → App secret)", {
    def: S.WHATSAPP_APP_SECRET, secret: true, validate: (v) => (v.length >= 16 ? null : "too short"),
  });
  if (!S.WHATSAPP_VERIFY_TOKEN || S.WHATSAPP_VERIFY_TOKEN.length < 16) { S.WHATSAPP_VERIFY_TOKEN = randomBytes(24).toString("hex"); ok("WHATSAPP_VERIFY_TOKEN generated (you paste it into Meta's webhook form)"); }
  S.OWNER_WHATSAPP_ID = (await ask("Your WhatsApp number (E.164, e.g. +201001234567)", {
    def: S.OWNER_WHATSAPP_ID, validate: (v) => (/^\+?[\d\s()-]{8,}$/.test(v) ? null : "a phone number with country code"),
  })).replace(/\D/g, "");
  ok(`WhatsApp will link +${S.OWNER_WHATSAPP_ID} to the owner account on first message`);
} else {
  for (const k of WA_KEYS) delete S[k];
  say(c.dim("  skipped"));
}

// 4 ── Secrets ────────────────────────────────────────────────────────────────
step(4, "Generated secrets");
for (const k of ["TELEGRAM_WEBHOOK_SECRET", "DISPATCH_SECRET", "WEB_SESSION_SECRET"]) {
  if (!S[k] || S[k].length < 16) { S[k] = randomBytes(32).toString("hex"); ok(`${k} generated`); } else ok(`${k} kept`);
}
const KEEP = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "OWNER_TELEGRAM_ID", "VAULT_CHANNEL_ID",
  "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_API_VERSION", "OWNER_WHATSAPP_ID",
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DISPATCH_SECRET", "WEB_SESSION_SECRET", "ALLOWED_ORIGINS", "LLM_PRESET",
  "GROQ_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY",
  "LLM_BASE_URL", "LLM_API_KEY", "LLM_MAIN_MODEL", "LLM_CLASSIFIER_MODEL",
  "LLM_MAIN_BASE_URL", "LLM_MAIN_API_KEY", "LLM_CLASSIFIER_BASE_URL", "LLM_CLASSIFIER_API_KEY",
  "EMBEDDINGS_BASE_URL", "EMBEDDINGS_API_KEY", "EMBEDDINGS_MODEL", "STT_BASE_URL", "STT_API_KEY", "STT_MODEL",
  "VISION_BASE_URL", "VISION_API_KEY", "VISION_MODEL", "SEARCH_API_KEY", "PUBLIC_BASE_URL",
];
const secrets = Object.fromEntries(KEEP.filter((k) => S[k]).map((k) => [k, String(S[k])]));
writeFileSync(join(ROOT, "secrets.json"), JSON.stringify(secrets, null, 2) + "\n");
writeFileSync(join(ROOT, ".dev.vars"), Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
ok("wrote secrets.json and .dev.vars (both git-ignored)");

// 5 ── Cloudflare ─────────────────────────────────────────────────────────────
step(5, "Cloudflare Workers");
if (!(await yes("Deploy to Cloudflare now?"))) {
  say("\n  Later, run:  npx wrangler login && npx wrangler deploy && npx wrangler secret bulk secrets.json && npx wrangler deploy");
  say("  then:        npm run setup   (to register the webhook)\n");
  rl.close();
  process.exit(0);
}
if (!existsSync(join(ROOT, "node_modules"))) run("npm", ["install"]);
const who = run(npx, ["wrangler", "whoami"], { capture: true, allowFail: true });
if (!/You are logged in|Account Name/i.test(who.stdout + who.stderr)) {
  say("  A browser window will open to authorize wrangler.");
  run(npx, ["wrangler", "login"]);
}
const first = run(npx, ["wrangler", "deploy"], { capture: true });
process.stdout.write(first.stdout);
const urlMatch = (first.stdout + first.stderr).match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
let workerUrl = urlMatch?.[0] ?? S.PUBLIC_BASE_URL;
workerUrl = await ask("Worker URL", { def: workerUrl, validate: (v) => (/^https:\/\//.test(v) ? null : "must be https://…") });
run(npx, ["wrangler", "secret", "bulk", "secrets.json"]);
ok("secrets uploaded");
run(npx, ["wrangler", "deploy"]);
ok("deployed with secrets live");

// 6 ── Webhook + command menu ─────────────────────────────────────────────────
step(6, "Register the Telegram webhook and command menu");
{
  const r = await fetch(`${workerUrl}/admin/register-webhook?secret=${encodeURIComponent(S.DISPATCH_SECRET)}`, { method: "POST", headers: UA });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) { fail(`register-webhook failed (${r.status}): ${JSON.stringify(j)}`); process.exit(1); }
  ok(`webhook → ${j.webhook}`);
  ok(j.commands === "ok" ? "\"/\" command menu + bot description published (en + ar)" : `command menu: ${j.commands}`);
  if (j.whatsapp?.configured) {
    say("\n  WhatsApp has no registration API — paste these into Meta → your app → WhatsApp → Configuration → Webhook:");
    say(`    Callback URL:  ${c.cyan(j.whatsapp.webhook)}`);
    say(`    Verify token:  ${c.cyan(S.WHATSAPP_VERIFY_TOKEN)}`);
    say("  then press \"Verify and save\" and subscribe to the \"messages\" field (docs/WHATSAPP.md).");
  }
}

// 7 ── Verify ─────────────────────────────────────────────────────────────────
step(7, "Verify");
{
  const h = await fetch(`${workerUrl}/health`, { headers: UA }).then((r) => r.json()).catch(() => null);
  if (h?.ok) ok("GET /health → ok"); else fail("health check failed — run `npx wrangler tail` and send the bot a message");
  const info = await tg(S.TELEGRAM_BOT_TOKEN, "getWebhookInfo");
  if (info.url?.startsWith(workerUrl)) ok(`Telegram confirms webhook (${info.pending_update_count} pending)`); else warn(`Telegram reports webhook at ${info.url}`);
  if (info.last_error_message) warn(`last webhook error: ${info.last_error_message}`);
}

say(`
${c.bold(c.green("Done!"))}

  1. Open Telegram → @${me.username} → send ${c.bold("/start")}   (your account becomes the owner)
  2. Answer the timezone prompt, e.g. ${c.bold("/tz Africa/Cairo")}
  3. Say ${c.dim('"remind me in 2 minutes to stretch"')} — the reminder arrives within a minute of due time
  4. Dashboard: ${c.cyan(workerUrl + "/")}  → "Send me a login link"  (or DM the bot /dashboard)
  5. Logs:      npx wrangler tail

  Re-run ${c.bold("npm run setup")} any time — it keeps your values as defaults.
`);
rl.close();
