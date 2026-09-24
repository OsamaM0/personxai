# Docker / self-hosting

PersonXAI is written for Cloudflare Workers — Durable Objects for the per-user agent, a Workers AI binding, cron triggers. The container does not reimplement any of that for Node. It runs the **same code on the same runtime (workerd)** through `wrangler dev` / Miniflare, which is a full local implementation of Workers, Durable Objects (with SQLite persisted to a volume) and static assets. Two things a container cannot provide are swapped for equivalents:

| On Cloudflare | In the container |
|---|---|
| Cron trigger `* * * * *` → `scheduled()` | the `cron` sidecar POSTs `/dispatch` every minute (the same code path the cron calls) |
| Workers AI binding (`env.AI`) | any external LLM preset — `groq`, `openrouter`, `openai` or `custom`; embeddings and STT can point at any OpenAI-compatible endpoint |
| Public HTTPS URL | your reverse proxy, or the `tunnel` profile (Cloudflare Tunnel, free) |

Supabase stays the database either way.

## Quick start

```bash
cp .dev.vars.example .dev.vars      # or let `npm run setup` write it (skip the deploy step)
# fill in Telegram, Supabase, an LLM preset — and NOT LLM_PRESET=cloudflare
docker compose up -d --build
curl http://localhost:8787/health   # {"ok":true,"service":"personxai","channels":{…}}
```

`docker compose` reads `.dev.vars` as an env file for both containers; the app's entrypoint turns those variables into the `.dev.vars` file wrangler expects (`docker/entrypoint.sh`). You can also mount a ready-made file at `/app/.dev.vars`, or pass `-e` flags to `docker run` — every variable in [`src/env.d.ts`](../src/env.d.ts) is recognised.

State (Durable Object SQLite, dedup tables, pending confirmations) lives in the `personxai-data` volume; Postgres remains the source of truth, so the volume can be thrown away at the cost of in-flight confirmations.

### Getting webhooks in

Telegram and WhatsApp need a public HTTPS URL. Any of:

- **Cloudflare Tunnel** (free, no open ports): Zero Trust → Networks → Tunnels → create → route a hostname to `http://app:8787` → copy the token.
  ```bash
  TUNNEL_TOKEN=eyJ... docker compose --profile tunnel up -d
  ```
- A reverse proxy you already run (Caddy, nginx, Traefik) in front of `:8787`.
- For a quick test: `cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`.

Then set `PUBLIC_BASE_URL=https://<your hostname>` in `.dev.vars` (so `/dashboard` links and the Telegram Mini App button are reachable) and register the webhook:

```bash
curl -X POST "https://<your hostname>/admin/register-webhook?secret=<DISPATCH_SECRET>"
```

### LLM in a container

There is no Workers AI without a Cloudflare session, so:

- `LLM_PRESET` must be `groq`, `openrouter`, `openai` or `custom` (the entrypoint warns otherwise).
- **Embeddings** default to Workers AI and will fail — non-fatally (search falls back to keywords). To keep semantic search, point `EMBEDDINGS_BASE_URL` / `EMBEDDINGS_API_KEY` / `EMBEDDINGS_MODEL` at any OpenAI-compatible `/embeddings` endpoint serving a **1024-dim** model (bge-m3 is available from several providers and from a local `text-embeddings-inference` container). Changing dimensions needs [RE_EMBEDDING.md](RE_EMBEDDING.md).
- **Voice notes** need `STT_*` unless the preset provides it (`groq` and `openai` do).

> Want Workers AI anyway? Run with the production config and remote bindings: `PERSONXAI_WRANGLER_CONFIG=wrangler.jsonc CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…`. The `ai` binding then proxies to your Cloudflare account (billed there); everything else still runs locally.

## Image

```
ghcr.io/osamam0/personxai:latest      built by .github/workflows/docker.yml on every push to main
ghcr.io/osamam0/personxai:<version>   on v* tags
```

Or build locally: `npm run docker:build` (`docker build -t personxai .`). The Dockerfile is a two-stage `node:22-bookworm-slim` build (workerd needs glibc, so not Alpine), runs as the unprivileged `node` user, exposes `8787`, and has a `/health` healthcheck.

| Env (container) | Default | Purpose |
|---|---|---|
| `PERSONXAI_PORT` | `8787` | listen port |
| `PERSONXAI_WRANGLER_CONFIG` | `wrangler.docker.jsonc` | `wrangler.jsonc` to enable remote bindings |
| `PERSONXAI_DATA_DIR` | `/data` | Durable Object / cache persistence |
| `PERSONXAI_REGENERATE_VARS` | `0` | `1` to overwrite a mounted `.dev.vars` from the environment |
| `WRANGLER_LOG` | `log` | `debug` for verbose wrangler output |

## Operations

```bash
npm run docker:logs           # docker compose logs -f app
docker compose restart app    # picks up a changed .dev.vars (the entrypoint rewrites it)
docker compose pull && docker compose up -d   # upgrade to the latest image
docker compose down -v        # stop and drop the state volume
```

Apply new Supabase migrations **before** pulling a new image (schema-before-code), exactly as on Cloudflare.

## Trade-offs vs. Cloudflare

- One process, one region, your uptime. The Worker version is global and idles at $0; the container needs a host.
- `wrangler dev` is a development server. It is stable and used here deliberately for fidelity, but it is not tuned for high throughput — fine for a personal assistant, not for thousands of users.
- Durable Object hibernation, Cloudflare observability and the Deploy-to-Cloudflare button do not apply.

If you can use Cloudflare, the [runbook](DEPLOYMENT.md) is still the recommended path; the container exists for air-gapped setups, corporate policies, and "I want it on my NAS".
