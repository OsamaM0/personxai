# Architecture

<p align="center"><img src="images/architecture.png" width="1000" alt="Architecture diagram"></p>

PersonXAI is three cooperating pieces — a **Cloudflare Worker** (ingress, dispatcher, dashboard API, static assets), one **Durable Object per user** (the agent), and **Supabase Postgres** (the only source of truth) — plus a private Telegram channel used as a file vault. Chat channels (Telegram, WhatsApp) plug into the Worker through one `ChannelAdapter` seam; the same Worker also runs in a container ([DOCKER.md](DOCKER.md)) and can sit behind a Vercel-hosted dashboard ([VERCEL.md](VERCEL.md)).

## 1 · Request lifecycle

### Chat message (Telegram or WhatsApp)

```
Telegram ──POST /channels/telegram/webhook──▶ Worker
WhatsApp ──POST /channels/whatsapp/webhook──▶ (GET = Meta's hub.challenge handshake)
  1. verifyWebhook: constant-time compare — Telegram's secret-token header, or
     WhatsApp's X-Hub-Signature-256 HMAC over the raw body
  2. parseUpdate → IncomingMessage (channel-neutral), or null (ignored: receipts, edits…)
  3. channel_post from the vault? log channel_post_seen, ack
  4. ctx.waitUntil(getAgentByName(UserAgent, "u:<channel>:<userId>").ingest(msg))
  5. 200 OK  ← the provider sees ~50 ms; no retries, no duplicate deliveries
```

One user can own several identities (`user_identities`): the owner's first WhatsApp message is linked to the account Telegram created, so both channels share one brain. Replies go out through the adapter's `OutboundPort`; where a channel lacks a primitive (WhatsApp cannot edit messages, has at most 3 reply buttons) the adapter degrades rather than the core adapting.

Inside the Durable Object (`src/agent/user-agent.ts` → `orchestrator.ts`):

```
ingest(msg)
  ├─ dedupe by update id (ring buffer in DO SQLite)
  ├─ load/bootstrap user + identity; allowlist + rate limit (20/min)
  ├─ routeMessage(msg)                                   ← src/agent/router.ts, pure
  │    command   → handleCommand()          (0 LLM calls)
  │    callback  → callback registry: cfm / inbox / file buttons (0 LLM calls)
  │    url       → ingest-url workflow: fetch, summarise*, bookmark
  │    media     → ingest-file workflow: forward to vault, extract, chunk, embed
  │    voice     → STT → treated as text
  │    llm       → runConversationTurn()
  └─ audit + agent_runs row
```

`*` the URL summary uses the cheap classifier role only when the page has enough text; the capture itself never waits on it.

### Conversation turn

```
runConversationTurn(text)
  1. selectTopics(text)         regex over EN/AR keywords → tasks | projects | notes | inbox |
                                reminders | search | memory | files | settings  (src/tools/topics.ts)
  2. retrieveContext(text)      user facts (always) · pending counts · if text ≥ 20 chars:
                                embed → matchMessages (this context) + matchMemories (hybrid)
  3. matchSkills(text)          trigger keywords / names → "call run_skill for …"
  4. assemble prompt            SYSTEM_CORE (immutable) + personalisation layer (versioned)
                                + topic fragments + live context (local time, tz, counts)
                                + retrieved block + last 20 messages (history window)
  5. buildToolSet(topics)       only tools whose topics matched + MCP tools (gated)
  6. generateText loop          ≤ 8 iterations, ≤ 12 tool calls, 60 s LLM timeout, 15 s per tool
  7. reply · persist messages · embed user text in background · agent_runs + tool_calls
```

Topic scoping is what keeps prompts small: a "remind me" message carries reminder + project tools, not all 50.

### Dashboard request

```
GET  /              → static asset (never reaches the Worker)
GET  /api/tasks     → handleWeb → session cookie (HMAC, pxa.session.v1) → repo call → JSON
POST /api/chat      → same Durable Object as the webhook → reply lands in Telegram
```

`run_worker_first` in `wrangler.jsonc` lists the only paths that invoke the Worker; everything else is served from the edge asset host and is not billed as an invocation.

### List page (chat)

```
/files #renovation by:channel  →  parseListArgs → ListState {k, p, tg, by, …}
  load(): one indexed query (limit 200) → group sort → paginate (6/page)
  render: numbered lines + number buttons + ◀ n/m ▶ + ⊞ group
  token (DO callbacks, 24 h) holds the state AND the ids on the page
tap "3"  →  consume token → showDetail(kind, id, back)
  card: fields + actions (Done / Snooze / Pin / Send / Move / Delete² / Back)
  every action re-renders the same message; Back re-renders the list page
```

Zero model calls; every press is one consumed token and one query, so stale buttons can never act on stale data.

### File ingest with several vault channels

```
media arrives → ensureDefaultVault() → classifier (project · channel · tags, one cheap call)
  channelConfidence ≥ 0.6 → forward straight into that channel
  else → forward to default, reply "Where does it belong?" with channel buttons
insert files row with tags[] · background extraction/embeddings
buttons: 📁 Project · 📁 Channel… (copyMessage + deleteMessage) · Keep · Ignore
```

### Cron tick (every minute)

```
scheduled() → dispatchTick(env)
  claim_due_jobs(limit, lease 2 min)  -- SELECT … FOR UPDATE SKIP LOCKED
  for each job:
    static/recurring reminder → deliver via channel outbound → mark delivered
                                 recurring: advance next_trigger_at with rrule in user tz
    dynamic (daily_brief / heartbeat) → re-enter the user's DO as role system_routine_task
  failures → exponential backoff (2^n), dead-letter after 5
```

Idempotency key `rem:<id>:<epoch>` means a paused/restored Supabase project resumes without duplicates. No pg_cron, no daemons.

## 2 · Data model (Supabase, 26 tables)

| Area | Tables |
|---|---|
| Identity | `users` (role, timezone, language, autonomy, allowlist) · `user_identities` (channel + external id → user) · `settings` (per-user JSON, e.g. login nonces) |
| Conversation | `conversations` (contexts) · `messages` (+ `vector(1024)` embedding) · `agent_runs` · `tool_calls` · `audit_logs` |
| Work | `projects` · `project_members` · `tasks` (+ `task_dependencies`, RRULE) · `notes` · `inbox_items` |
| Money | `wallet_entries` (direction in/out, amount + currency, category, quantity/unit, soft delete) |
| Time | `reminders` (static / recurring / dynamic + template) · `job_outbox` |
| Files | `files` (vault channel + message id, extraction status, summary, embedding, `tags[]`) · `file_chunks` · `vault_channels` (chat id, category, tags, default) · `tags` · `file_tags` (legacy join, kept in sync) |
| Memory | `memories` (typed, importance, embedding) · `user_facts` · `links` |
| Extensibility | `skills` · `mcp_servers` · `system_prompts` (versioned personalisation) |

Every entity table carries `tags text[]` with a GIN index; `tag_counts(user_id)` returns the per-kind facets in one call, and `searchByTags` is one `@>` query per kind — the "fast path" the bot and dashboard use for `#tag` filters.

SQL functions: `wallet_summary`, `wallet_category_totals`, `tag_counts`, `select_due_reminders`, `claim_due_jobs`, `mark_job_delivered`, `mark_job_failed`, `match_messages`, `match_memories`, `match_notes`, `match_file_chunks`, `hybrid_search` (pg_trgm keyword ∪ pgvector similarity, ranked together). Every `embedding` column has a partial HNSW index (`where embedding is not null`) so rows without vectors are never candidates.

RLS is enabled on every table with **no policies**: the anon and authenticated roles can do nothing; the Worker uses `service_role` and scopes every query by `user_id` in code.

## 3 · Tool registry

```ts
defineTool({
  name: "create_task",
  description: "…",                       // what the model reads
  inputSchema: z.object({ … }),           // validated before execute
  topics: ["tasks"],                      // when it is offered to the model
  permissionLevel: "write",               // read | write | destructive | external
  irreversible?: true, requiresConfirmation?: true, confirmLabel?: (input) => string,
  execute: async (input, ctx) => { … },   // ctx: db, user, out (channel), config, env, now, waitUntil
});
```

`toAiToolSet()` wraps each tool with, in order: budget check → `roleAllowsPermission` → `needsConfirmation` (may send Confirm/Cancel buttons and return `awaiting_confirmation`) → timeout → execute → result truncation (4 000 chars, summarised) → `tool_calls` record. Confirmed actions re-enter through `executeToolDirect` from the callback registry, so a confirmation is a real execution, not a replay of the model.

MCP tools from `this.mcp.getAITools()` are wrapped by `src/mcp/permissions.ts` with the same policy at level `external`.

## 4 · Retrieval

- **Embeddings**: `bge-m3` (1024-d) — one multilingual space for Arabic and English; skipped for texts < 20 chars and for commands.
- **Messages**: cosine top-5 within the current context, excluding what is already in the history window.
- **Memories**: `match_memories` — vector similarity with importance and recency as tie-breakers; `last_accessed_at` is updated on hit.
- **Files**: `match_file_chunks` over `file_chunks`; `get_file_text` returns the best chunks for a question, not the whole document.
- **Search**: `hybrid_search` — trigram keyword *and* vector, fused; the dashboard calls it with a null vector (keyword only) to avoid an embedding call per keystroke.

The retrieved block is capped and labelled; the prompt never contains a table dump.

## 5 · LLM roles & providers

| Role | Used for | Default |
|---|---|---|
| `main` | the conversation loop | preset's chat model |
| `classifier` | inbox classification, URL summaries, cheap decisions | preset's small model |
| `embeddings` | everything above | Workers AI `bge-m3` |
| `stt` | voice notes | preset's Whisper or Workers AI |
| `vision` | photo descriptions (optional) | unset |

`src/config.ts` resolves a preset then lets any `LLM_<ROLE>_{BASE_URL,API_KEY,MODEL}` override field by field. `provider.ts` strips `reasoning_content` from outgoing history (some providers reject it on the next call) and pins `EMBEDDINGS_DIMS` against the `vector(1024)` columns at startup.

## 6 · Channels

`src/channels/types.ts` is the whole contract:

```ts
interface ChannelAdapter {
  name: string;
  verifyWebhook(req, env): boolean;          // constant-time
  parseUpdate(body): IncomingMessage | null; // never throws
  outbound(env): OutboundPort;               // sendText / sendButtons / editText / sendFile / copyMessage…
}
```

The Telegram adapter (`src/channels/telegram/`) adds: retrying `tgCall` with token redaction, Markdown fallback to plain text, inline keyboards with 64-byte callback tokens (`kind:token:verb`) resolved in the DO, `copyMessage` for vault delivery, and `registerTelegramCommands` for the `/` menu.

## 7 · Security model

| Concern | Mechanism |
|---|---|
| Webhook forgery | secret token, constant-time compare |
| Unknown users | allowlist; one refusal then silence |
| Abuse | 20 msg/min token bucket per user; 3 login links then 1/min |
| Model over-reach | topic-scoped tools, Zod validation, RBAC, autonomy gate, per-tool timeout, result truncation, 8-iteration cap |
| Dashboard auth | Telegram DM is the factor; HMAC-signed magic link (10 min, single-use nonce, redeemed by **POST**), HttpOnly SameSite=Lax session (7 d), domain-separated token purposes |
| CSRF | `Origin` check with `Sec-Fetch-Site` fallback on every non-GET |
| Secrets | Worker secrets only; never in the DB, logs (token redaction), or browser |
| Auditing | every tool call, command, confirmation and dashboard write → `audit_logs` |

## 8 · What lives where

| Path | Purpose |
|---|---|
| `src/index.ts` | Worker entry: health, web, webhook ingress, `/dispatch`, `/admin/register-webhook`, cron |
| `src/agent/` | `user-agent.ts` (DO), `orchestrator.ts` (turn), `router.ts`, `commands.ts`, `confirmations.ts`, `context.ts`, `prompts/` |
| `src/tools/` | `registry.ts` (wrapper), `topics.ts`, `defs/*.ts` (tools by area) |
| `src/channels/` | `types.ts`, `registry.ts`, `telegram/` |
| `src/database/` | Supabase client, `repos/*` (one per table group), `types.ts` |
| `src/scheduler/` | `dispatcher.ts`, `rrule.ts`, `tz.ts` |
| `src/services/` | `llm/` (provider, classify, embeddings, stt, usage), `media/` (extract, chunk, fetch), `storage/vault.ts`, `url/metadata.ts` |
| `src/workflows/` | `ingest-file.ts`, `ingest-url.ts`, `daily-brief.ts` (+ heartbeat) |
| `src/mcp/` | client policy + permission wrapper |
| `src/security/` | `autonomy.ts`, `rbac.ts`, `ratelimit.ts`, `redact.ts` |
| `src/web/` | dashboard API, auth, sessions, http helpers |
| `public/` | dashboard SPA (three files, no build) |
| `supabase/` | `migrations/*.sql` (source of truth), `schema.sql` (generated) |
| `scripts/` | `setup.mjs` (wizard), `build-schema.mjs` |
| `test/unit/` | 200+ Vitest specs on the Workers pool |
