# Vercel — hosting the dashboard in front of the Worker

The assistant itself cannot run on Vercel: it depends on Cloudflare Durable Objects for the per-user agent. What Vercel *can* host is the **web dashboard** — the static SPA in [`public/`](../public/) — on your own Vercel domain, with the dashboard API transparently proxied to the Worker. Reasons to do that:

- a nicer domain for the dashboard without putting the domain on Cloudflare;
- Vercel's preview deployments for dashboard changes;
- a team that already lives in Vercel.

```
browser ──▶ https://your-app.vercel.app/            static SPA (Vercel CDN)
            https://your-app.vercel.app/api/*  ──┐
            https://your-app.vercel.app/auth/* ──┼─ Edge Middleware rewrite ─▶ https://personxai.<sub>.workers.dev
            https://your-app.vercel.app/mcp    ──┘  (server-side; the browser never sees the Worker)
Telegram / WhatsApp ───────────────────────────────▶ https://personxai.<sub>.workers.dev/channels/*/webhook  (unchanged)
```

The proxy is [`middleware.js`](../middleware.js) (Vercel Edge Middleware, `@vercel/edge`'s `rewrite`) and the static config is [`vercel.json`](../vercel.json). Webhooks, `/dispatch` and `/admin/*` are intentionally not proxied — providers keep talking to the Worker directly.

## Setup

### 1 · Deploy the Worker first

Follow [DEPLOYMENT.md](DEPLOYMENT.md). Note its URL, e.g. `https://personxai.you.workers.dev`.

### 2 · Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fosamam0%2Fpersonxai&env=PERSONXAI_WORKER_URL&envDescription=Your%20PersonXAI%20Worker%20URL&envLink=https%3A%2F%2Fgithub.com%2Fosamam0%2Fpersonxai%2Fblob%2Fmain%2Fdocs%2FVERCEL.md&project-name=personxai-dashboard)

or from the repo:

```bash
npm i -g vercel
vercel link                                   # creates .vercel/ (git-ignored)
vercel env add PERSONXAI_WORKER_URL production # https://personxai.you.workers.dev
vercel --prod                                 # or: npm run vercel:deploy
```

`PERSONXAI_WORKER_URL` is the only Vercel-side setting. No build step: `vercel.json` sets `outputDirectory: public`, and the middleware is compiled by Vercel.

### 3 · Tell the Worker about its new front door

Two Worker secrets:

```jsonc
"PUBLIC_BASE_URL": "https://your-app.vercel.app",   // magic links + Mini App button point here
"ALLOWED_ORIGINS": "https://your-app.vercel.app"    // CSRF guard accepts POSTs from this origin
```

```bash
npx wrangler secret bulk secrets.json && npx wrangler deploy
curl -X POST "https://personxai.you.workers.dev/admin/register-webhook?secret=<DISPATCH_SECRET>"   # re-points the Telegram menu button
```

`ALLOWED_ORIGINS` is comma-separated; add a preview domain (`https://personxai-git-main-you.vercel.app`) if you use preview deployments.

### 4 · Sign in

Open `https://your-app.vercel.app`, press **Send me a login link** (or DM the bot `/dashboard`). The link now targets the Vercel domain; redeeming it sets the session cookie on that domain, because the `Set-Cookie` header travels back through the same rewrite.

## How the pieces fit

| Concern | Where it is solved |
|---|---|
| Same-origin CSRF check on the Worker rejects `Origin: https://your-app.vercel.app` | `ALLOWED_ORIGINS` → [`assertSameOrigin`](../src/web/http.ts) |
| Magic links must open on the Vercel domain, not the Worker | `PUBLIC_BASE_URL` → [`handleLoginRequest`](../src/web/auth.ts) and `/dashboard` |
| The session cookie has no `Domain` attribute | the browser scopes it to the origin it received it from — Vercel's |
| Telegram Mini App | `registerTelegramMenuButton` uses `PUBLIC_BASE_URL`; the Mini App login (`/api/auth/miniapp`) is proxied like any other API call |
| MCP clients (Claude Code, Codex) | `/mcp` is proxied too, so either URL works in `/connect` output |

Latency: one extra hop (Vercel edge → Cloudflare edge), typically 20–60 ms. Asset requests never touch the Worker.

## Not on Vercel

- The bot, the Durable Objects, the cron and the MCP server all stay on Cloudflare. A Vercel-only deployment does nothing.
- Vercel Serverless/Edge Functions could in principle host a Node port of the Worker with an external store replacing Durable Objects; that is a rewrite, not a config change, and is out of scope. [DOCKER.md](DOCKER.md) is the self-hosting path.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `{"error":"PERSONXAI_WORKER_URL is not set on this Vercel project"}` | Add the env var in Vercel → Settings → Environment Variables and redeploy. It must be `https://…` with no path. |
| `{"error":"cross-origin request rejected"}` on login | `ALLOWED_ORIGINS` is missing the exact origin (scheme + host, no trailing slash). |
| Login link opens the Worker URL instead of Vercel | `PUBLIC_BASE_URL` not set, or set after the link was minted — request a new link. |
| Signed in on Vercel but the Worker URL shows signed out | Expected: cookies are per origin. Use one front door. |
