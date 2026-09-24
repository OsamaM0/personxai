# Deployment runbook

Zero-to-live in **~10 minutes with the wizard** or ~20 by hand. Everything runs on free tiers.

**Prerequisites:** Node 20+ · a [Cloudflare](https://dash.cloudflare.com/sign-up) account · a [Supabase](https://database.new) account · a Telegram account.

| Path | When |
|---|---|
| [**A. `npm run setup`**](#a-the-wizard) | You have a terminal. It does steps 1–7 below interactively and verifies each one. |
| [**B. Deploy-to-Cloudflare button**](#b-one-click-deploy) | You want CI/CD from a fork with no local tooling. |
| [**C. By hand**](#c-by-hand) | You want to understand every step (or you're scripting it). |
| [**D. Docker / self-hosted**](DOCKER.md) | You'd rather run it on your own box (same code on workerd; Supabase stays the database). |

Add-ons once it's live: [**WhatsApp**](WHATSAPP.md) as a second channel into the same account, and [**Vercel**](VERCEL.md) to host the dashboard on a Vercel domain in front of the Worker.

Whichever path you take, you first need the three accounts below. Each takes about two minutes.

> Want the detail on one specific value — where to click, what it should look like, how to verify or rotate it? **[CONFIGURATION.md](CONFIGURATION.md)** walks through every secret and variable one at a time.

---

## Step 1 · Telegram — bot + private vault channel

<img src="images/setup-telegram.png" width="900" alt="BotFather flow and the three Telegram values">

1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → pick a name and a username ending in `bot` → **copy the token** → `TELEGRAM_BOT_TOKEN`.
2. Create a **private channel** (Telegram → New Channel → Private). This is the file vault: every document, photo and voice note you send the bot is forwarded here and retrieved from here later. Add your bot as **Administrator** with *Post messages*.
3. Get the two ids:
   - **Your user id** → `OWNER_TELEGRAM_ID`: DM [@userinfobot](https://t.me/userinfobot), or let the wizard read it.
   - **Channel id** → `VAULT_CHANNEL_ID` (format `-100…`): forward any post from the channel to [@userinfobot](https://t.me/userinfobot), or post something in the channel and let the wizard read it. After deploying, the Worker also logs `channel_post_seen` with the id in `wrangler tail`.

> **Why a channel and not a group?** Channels let the bot post as itself and keep messages for ever; `copyMessage` returns files without a "forwarded from" header, and Telegram allows 2 GB per file — far beyond the 20 MB the Bot API can *download*. Bytes never transit the Worker.

## Step 2 · Supabase — the brain

<img src="images/setup-supabase.png" width="900" alt="Supabase project, schema and keys">

1. Create a project at [database.new](https://database.new) (free plan; note it allows 2 active projects and pauses after ~7 days idle — the bot's 1-minute cron keeps it warm).
2. Apply the schema, **one of**:
   - **SQL editor (easiest):** *SQL Editor → New query*, paste all of [`supabase/schema.sql`](../supabase/schema.sql), press **Run**. It is one transaction; a failure leaves nothing half-applied.
   - **Supabase CLI:** `supabase link --project-ref <ref> && supabase db push` (applies `supabase/migrations/*.sql` in order).
   - **Supabase MCP** from your editor: `apply_migration` per file.
3. From **Project Settings → API** copy:
   - `SUPABASE_URL` — `https://<ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — the **service_role** secret. Never the anon key, never in a client: the Worker is the only holder.

> RLS is enabled deny-all on every table by design — only the service role (the Worker) can touch data. The Supabase advisor shows INFO-level "RLS enabled, no policy" notices; that is expected.

## Step 3 · Language model

Pick **one** preset with a single variable (`LLM_PRESET`); details and mixing in [FREE_TIER.md](FREE_TIER.md).

| Preset | Key to set | Cost | Notes |
|---|---|---|---|
| `cloudflare` | *none* | $0 | Everything on Workers AI. Zero external accounts. Weakest at multi-step tool calls. |
| `groq` | `GROQ_API_KEY` ([console](https://console.groq.com/keys)) | $0 | **Recommended.** `gpt-oss-120b` chat, `gpt-oss-20b` classifier, Whisper STT. Very fast. |
| `openrouter` | `OPENROUTER_API_KEY` ([keys](https://openrouter.ai/keys)) | $0 | Widest choice of `:free` models. |
| `openai` | `OPENAI_API_KEY` | paid | `gpt-4.1` / `gpt-4.1-mini` / `whisper-1`. |
| `custom` | `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MAIN_MODEL` | — | **Any** OpenAI-compatible endpoint — vLLM, Ollama gateway, a proxy, a provider that launched last week. |

Embeddings default to Workers AI `@cf/baai/bge-m3` (1024-dim, multilingual) whatever preset you choose. Changing embedding dimensions later needs [RE_EMBEDDING.md](RE_EMBEDDING.md).

---

## A. The wizard

```bash
git clone https://github.com/osamam0/personxai && cd personxai
npm install
npm run setup
```

<img src="images/setup-cloudflare.png" width="900" alt="npm run setup: deploy, secrets, webhook, verify">

The wizard ([`scripts/setup.mjs`](../scripts/setup.mjs), zero dependencies) will:

1. **Verify the bot token** with `getMe`, then **auto-detect your user id and the vault channel id** from `getUpdates` (send `/start` to the bot and post anything in the channel when asked) and check the bot is a channel admin.
2. **Check the Supabase schema** through the REST API and, if missing, print the exact SQL-editor URL to paste `schema.sql` into — then re-check.
3. Ask for the **LLM preset** and its key.
4. **Generate** `TELEGRAM_WEBHOOK_SECRET`, `DISPATCH_SECRET`, `WEB_SESSION_SECRET` and write `secrets.json` + `.dev.vars` (both git-ignored).
5. `wrangler login` (browser) → `wrangler deploy` → `wrangler secret bulk secrets.json` → `wrangler deploy`.
6. `POST /admin/register-webhook` — registers the webhook **and publishes the `/` command menu and bot description in English and Arabic** (`setMyCommands`, `setMyDescription`).
7. Verify `GET /health` and `getWebhookInfo`.

Then go to [Step 8 · First contact](#step-8--first-contact). Re-run `npm run setup` any time: it keeps your values as defaults and every step is idempotent.

## B. One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/osamam0/personxai)

1. Press the button. Cloudflare forks the repository into your GitHub account, creates the Worker from [`wrangler.jsonc`](../wrangler.jsonc) (Durable Object, cron, Workers AI, static assets) and sets up Workers Builds so every push to `main` redeploys.
2. Add the secrets in **Workers & Pages → personxai → Settings → Variables and Secrets** — the list is [`secrets.example.json`](../secrets.example.json). Mark each as *Secret*. Generate the three random ones with `openssl rand -hex 32`.
3. Redeploy once (Deployments → Retry, or push a commit) so the secrets are live.
4. Register the webhook and the command menu:
   ```bash
   curl -X POST "https://personxai.<your-subdomain>.workers.dev/admin/register-webhook?secret=<DISPATCH_SECRET>"
   # → {"ok":true,"webhook":"https://…/channels/telegram/webhook","commands":"ok"}
   ```
5. Continue at [Step 8 · First contact](#step-8--first-contact).

> GitHub Actions alternative: the repo ships [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). Add `CLOUDFLARE_API_TOKEN` (template *Edit Cloudflare Workers*) and `CLOUDFLARE_ACCOUNT_ID` as repository secrets; every push to `main` runs typecheck + tests, then deploys. Runtime secrets stay in Cloudflare and persist across deploys.

## C. By hand

### Step 4 · Deploy the Worker

```bash
npm install
npx wrangler login
npx wrangler deploy            # prints https://personxai.<subdomain>.workers.dev
```

### Step 5 · Set secrets

Copy [`secrets.example.json`](../secrets.example.json) to `secrets.json` (git-ignored), fill it in, and upload in one go:

```bash
npx wrangler secret bulk secrets.json
npx wrangler deploy            # redeploy so the secrets are live
```

Or one at a time with `npx wrangler secret put <NAME>`:

```
TELEGRAM_BOT_TOKEN  TELEGRAM_WEBHOOK_SECRET  OWNER_TELEGRAM_ID  VAULT_CHANNEL_ID
SUPABASE_URL  SUPABASE_SERVICE_ROLE_KEY  DISPATCH_SECRET
WEB_SESSION_SECRET                 # optional — dashboard sessions; falls back to DISPATCH_SECRET
LLM_PRESET                         # cloudflare | groq | openrouter | openai | custom
GROQ_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / LLM_API_KEY   (for that preset)
LLM_*  STT_*  EMBEDDINGS_*  VISION_*  SEARCH_API_KEY                                (optional overrides)
```

With `LLM_PRESET=cloudflare` there is no LLM key to set at all.

Per-value instructions — how to obtain each one, its expected shape, and what to do when it leaks — are in [CONFIGURATION.md](CONFIGURATION.md).

### Step 6 · Register the webhook + command menu

```bash
curl -X POST "https://personxai.<your-subdomain>.workers.dev/admin/register-webhook?secret=<DISPATCH_SECRET>"
```

This calls Telegram `setWebhook` (with the secret token and `allowed_updates` `["message","edited_message","callback_query","channel_post"]`), then `setMyCommands` for English and Arabic, `setMyDescription` and `setMyShortDescription`. Idempotent — call it again after changing commands.

<p><img src="images/telegram-commands-menu.png" width="260" alt="Slash-command menu in Telegram"></p>

### Step 7 · Verify

1. `curl https://personxai.<subdomain>.workers.dev/health` → `{"ok":true,"service":"personxai"}`
2. `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` → your Worker URL, `pending_update_count: 0`, no `last_error_message`.
3. `npx wrangler tail` in a second terminal while you do Step 8.

---

## Step 8 · First contact

<p><img src="images/telegram-first-run.png" width="300" alt="First run"></p>

1. DM your bot `/start` **from the owner account** — the first message from `OWNER_TELEGRAM_ID` auto-provisions the owner.
2. Answer the timezone prompt: `/tz Africa/Cairo` (IANA name) or `/tz 21:30` (your current local time — the bot guesses the zone).
3. Say *"remind me in 2 minutes to stretch"* → the reminder arrives within ~1 minute of due time (cron granularity).
4. Send a PDF, then *"summarise the PDF I just sent"*.
5. From a second, non-owner account, DM the bot — it must politely refuse (once).

## Step 9 · Open the dashboard

<p><img src="images/dashboard-login.png" width="600" alt="Dashboard login"></p>

Visit `https://personxai.<subdomain>.workers.dev/` and press **Send me a login link**, or DM the bot `/dashboard`. The link arrives in Telegram, is valid for 10 minutes and works once. Full reference: [DASHBOARD.md](DASHBOARD.md).

<p><img src="images/dashboard-overview.png" width="900" alt="Dashboard overview"></p>

### Custom domain (optional)

Add a route in `wrangler.jsonc` (the domain must be on Cloudflare) and redeploy:

```jsonc
"routes": [{ "pattern": "assistant.example.com", "custom_domain": true }]
```

Optionally put **Cloudflare Access** (Zero Trust, free for 50 users) in front of the hostname for a second factor before the page even loads.

### Recommended after go-live

- `/brief on 08:00` — a daily brief built from real rows.
- `/heartbeat on 4` — a nudge every 4 waking hours *only* when something is overdue (zero LLM calls otherwise).
- `/settings autonomy 2` once you trust it — see the [autonomy matrix](SKILLS.md#the-permission-matrix).

---

## Local development

```bash
cp .dev.vars.example .dev.vars   # or let `npm run setup` write it
npm run dev                       # http://localhost:8787 — bot API + dashboard, same as production
docker compose up -d --build      # the same thing in a container — see DOCKER.md
```

`wrangler dev` requires a Cloudflare login because of the Workers AI (`ai`) binding. For a fully offline loop, create a git-ignored `wrangler.dev.jsonc` that is a copy of `wrangler.jsonc` **minus** the `ai` binding and the `triggers`, and run `npx wrangler dev -c wrangler.dev.jsonc`. With an external LLM preset (e.g. `groq`) chat, classification and STT are plain HTTPS; only embeddings degrade, and embedding failures are non-fatal by design.

To drive the bot locally you need a public URL for the webhook (e.g. `cloudflared tunnel --url http://localhost:8787`), then `POST /admin/register-webhook` on that URL. The dashboard needs no tunnel.

## Upgrades

Apply new migrations **before** deploying new code (schema-before-code). Upgrading an existing install to the tags + multi-channel release means running `supabase/migrations/0013_tags_vaults.sql` (it backfills file tags and registers your existing `VAULT_CHANNEL_ID` as the default channel on first use), deploying, and re-running `POST /admin/register-webhook` so `/tags` and `/vault` appear in the menu.

In general: `npm run schema` regenerates `supabase/schema.sql`; individual migration files are in `supabase/migrations/` and are safe to apply one by one. Then `npx wrangler deploy` and re-run `POST /admin/register-webhook` if commands changed.

## Resetting the database

`npm run db:reset` wipes one module, several, or everything — for a fresh start after testing, or to clear a single feature without touching the rest. It uses the same `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` as the Worker (from `secrets.json` / `.dev.vars` / the environment), shows row counts first, and asks you to type the module name before deleting.

```bash
npm run db:reset -- list                    # modules and their tables
npm run db:reset -- wallet                  # wipe wallet entries, keep everything else
npm run db:reset -- tasks notes --dry-run   # only show what would go
npm run db:reset -- all                     # every row in every table (users too; the owner is re-created on their next message)
npm run db:reset -- all --drop              # drop every table/type/function and rebuild from supabase/schema.sql
```

Modules: `core` `conversations` `runs` `projects` `tasks` `notes` `inbox` `reminders` `files` `vaults` `memory` `links` `skills` `wallet`. Per-module resets keep the schema and delete rows (in batches, through the REST API). `--drop` needs a SQL connection: pass `--db-url <connection string>` (or set `DATABASE_URL`) with `psql` installed, otherwise it writes the SQL to a file and prints the SQL-editor URL to paste it into. `--yes` skips the prompt for scripts.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| **Bot silent** | `npx wrangler tail` while sending a message. `403` → `TELEGRAM_WEBHOOK_SECRET` mismatch, re-register the webhook. Nothing at all → webhook not registered (Step 6). |
| **`Missing/invalid required secrets: …`** in logs | That secret wasn't uploaded. `npx wrangler secret bulk secrets.json` and redeploy. |
| **"/" menu doesn't show commands** | Re-run `POST /admin/register-webhook`; the response's `commands` field says `ok` or the Telegram error. Telegram clients cache the menu — close and reopen the chat. |
| **Reminders never fire** | Check the cron ran (`wrangler tail` shows `dispatch_tick`) and the Supabase project isn't paused. |
| **Supabase paused** | Restore it from the dashboard; everything resumes (the outbox is idempotent). |
| **Files aren't stored / "vault forward failed"** | The bot isn't an admin of the vault channel, or `VAULT_CHANNEL_ID` is wrong (must start with `-100`). |
| **Voice notes not transcribed** | With `openrouter`, STT falls back to Workers AI — make sure the `ai` binding deployed. Check `STT_*` overrides. |
| **Dashboard login link never arrives** | The Worker finds its own URL via `getWebhookInfo`, so register the webhook first, or set `PUBLIC_BASE_URL`. "No owner account yet" → nobody has sent `/start` from `OWNER_TELEGRAM_ID`. |
| **"This link has already been used" on a fresh link** | Something fetched the URL before you. The login DM disables previews and redeem is a POST precisely to prevent this; check `audit_logs` for `web.signed_in` landing within a second of `web.login_link_issued`. |
| **`{"error":"cross-origin request rejected"}`** | The browser sent `Origin: null` on the redeem POST without `Sec-Fetch-Site: same-origin`. See [DASHBOARD.md](DASHBOARD.md#why-redeeming-is-a-post). |
| **Signed out right after signing in** | Rotating `WEB_SESSION_SECRET` / `DISPATCH_SECRET` invalidates sessions; sign in again. |
| **`EMBEDDINGS_DIMS=… but bge-m3 produces 1024`** | Config mismatch with the `vector(1024)` columns — see [RE_EMBEDDING.md](RE_EMBEDDING.md). |
| **`WhatsApp is partially configured — also set …`** | The four `WHATSAPP_*` secrets go together. Set the missing ones or remove them all — [WHATSAPP.md](WHATSAPP.md). |
| **Meta can't verify the WhatsApp webhook** | Verify token mismatch or secrets not yet deployed. `curl "https://<worker>/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=1"` must print `1`. |
| **Dashboard on Vercel says "cross-origin request rejected"** | Add the Vercel origin to `ALLOWED_ORIGINS` and set `PUBLIC_BASE_URL` — [VERCEL.md](VERCEL.md). |
| **A preset model was retired by the provider** | Override just that role: `LLM_MAIN_MODEL=…` keeps the preset's endpoint and key. |
