# Free-tier fit

PersonXAI's hard product goal: **run at $0/month for personal use** without losing functionality. Any change that breaks one of these budgets is a bug.

## Budget vs. free caps (~300 messages/day personal load)

| Service | Free cap | PersonXAI usage | Guardrail in the code |
|---|---|---|---|
| Workers requests | 100k/day | ~2k/day (webhooks + 1,440 cron ticks + dispatch) | fast-ACK webhook; single 1-min cron |
| Workers CPU | 10 ms/invocation | LLM await time is wall-clock, not CPU | extraction capped ~500KB; lazy chunking |
| Durable Objects (free plan, SQLite-backed) | 100k req/day, 13k GB-s/day, 5 GB storage | ~600 GB-s/day (300 turns × ~15 s × 128 MB) | DO holds only ephemeral state; pruned rings |
| Workers AI | 10k neurons/day | embeddings (bge-m3), STT (whisper), optional chat | skip embeddings for <20-char texts and commands; classifier cache; deterministic-first heartbeat |
| Cron Triggers | free (≤5 per Worker) | 1 (`* * * * *`) | — |
| Worker bundle size | 3 MB gzipped (free plan) | ~1.3 MB gzipped | `unpdf` (pdf.js) is the bulk; keep an eye on new deps |
| Supabase free | 500 MB DB, 2 active projects, pauses after ~7 days idle | MBs of rows; the 1-min cron's REST calls keep it active | tool results truncated; **no file bytes in DB** (vault holds them); prune old agent_runs |
| Telegram Bot API | free; 2 GB/file | primary UI + file vault | forward/copyMessage — bytes never transit the Worker |
| R2 | 10 GB free **but requires a payment card** | **disabled by default** | generated artifacts go to the vault channel instead; R2 is opt-in (below) |
| LLM | OpenRouter `:free` models / Groq free tier / Gemini AI Studio free / Workers AI | main + classifier roles | deterministic routing first; small model for classification; `/status` shows usage |

## The three $0 recipes

Pick one with a single variable. A preset fills in base URLs and model ids for every role; any explicit per-role variable (`LLM_MAIN_MODEL`, `STT_BASE_URL`, …) still overrides it.

### 1. All-Cloudflare — zero external accounts

```ini
LLM_PRESET=cloudflare
```

Chat, classification, embeddings, and voice all run on the Workers AI binding. Nothing else to configure. Llama-on-Workers-AI is the weakest of the three at multi-step tool calling, but everything works.

### 2. Groq free tier — best tool calling, very fast

```ini
LLM_PRESET=groq
GROQ_API_KEY=gsk_...
```

Chat (`openai/gpt-oss-120b`), classification (`openai/gpt-oss-20b`), and voice (`whisper-large-v3-turbo`) go to Groq; embeddings stay on Workers AI. Free tier has per-minute token caps.

> Model catalogs drift — Groq retired the Llama models this build originally targeted. If a preset model disappears, override just that role (`LLM_MAIN_MODEL=...`) rather than abandoning the preset.

### 3. OpenRouter free models — widest model choice

```ini
LLM_PRESET=openrouter
OPENROUTER_API_KEY=sk-or-...
```

Chat and classification use `:free` models; embeddings and voice stay on Workers AI (OpenRouter has no audio endpoint). Free models have daily request caps, raised by a small one-time credit top-up.

### 4. OpenAI

```ini
LLM_PRESET=openai
OPENAI_API_KEY=sk-...
```

Chat `gpt-4.1`, classification `gpt-4.1-mini`, voice `whisper-1`. Not free, but the least surprising. Embeddings deliberately stay on Workers AI — `text-embedding-3-small` is 1536-dim and would not fit the `vector(1024)` columns.

### 5. Any OpenAI-compatible service

```ini
LLM_PRESET=custom
LLM_BASE_URL=https://your-endpoint/v1
LLM_API_KEY=...
LLM_MAIN_MODEL=your-model
LLM_CLASSIFIER_MODEL=your-smaller-model   # optional; defaults to the main model
```

This is the escape hatch: a self-hosted vLLM/Ollama gateway, a corporate proxy, an aggregator such as inxai, a new provider that launched last week. There is no provider-specific handling on this path — the endpoint, key and model ids you give are used as-is. If your gateway has a routing alias (e.g. `auto`), put that in `LLM_MAIN_MODEL` and the gateway picks the model. Embeddings and voice stay on Workers AI unless you point `EMBEDDINGS_*` / `STT_*` at the same endpoint.

## Mixing

Presets and explicit variables compose **field by field** — you can keep a preset's endpoint and override only the model:

```ini
LLM_PRESET=groq
GROQ_API_KEY=gsk_...
LLM_MAIN_MODEL=qwen/qwen3.8-27b     # same Groq endpoint, different model
```

Or route roles to different providers entirely:

```ini
LLM_PRESET=custom
LLM_BASE_URL=https://your-gateway/v1
LLM_API_KEY=...
LLM_MAIN_MODEL=your-model
LLM_CLASSIFIER_BASE_URL=https://api.groq.com/openai/v1
LLM_CLASSIFIER_API_KEY=gsk_...
LLM_CLASSIFIER_MODEL=openai/gpt-oss-20b
```

> Changing the **embedding** model to one with different dimensions requires a migration — see [RE_EMBEDDING.md](RE_EMBEDDING.md). The Worker refuses to start on a mismatch rather than corrupting search.

## A note on model catalogs

Provider catalogs drift fast — Groq retired the Llama models this project originally targeted. Every preset's models were verified live on 2026-08-27. If one disappears, override just that role's model rather than abandoning the preset.

## Enabling R2 (optional, needs a card on the Cloudflare account)

1. `npx wrangler r2 bucket create personxai-artifacts`
2. In `wrangler.jsonc` add:
   ```jsonc
   "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "personxai-artifacts" }]
   ```
3. Add `"R2_ENABLED": "true"` to `vars` and redeploy.

Without R2, generated artifacts are uploaded to the vault channel as documents.

## Rules for contributors

- New features must state their footprint against the table above.
- Never add a per-message LLM call to a deterministic path (commands, callbacks, dispatch).
- Never store file bytes in Postgres.
- Heartbeat/daily-brief must stay zero-LLM when there is nothing to report.
