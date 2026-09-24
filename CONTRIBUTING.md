# Contributing to PersonXAI

Thanks for helping. This is a small, opinionated codebase; the rules below keep it that way.

## Dev loop

```bash
npm install
cp .dev.vars.example .dev.vars     # or `npm run setup`
npm run dev                         # wrangler dev on :8787 (bot API + dashboard)
npm test                            # vitest — ~200 tests, ~3 s
npm run check                       # tsc --noEmit
npm run schema                      # regenerate supabase/schema.sql after adding a migration
docker compose up -d --build        # same stack in a container (docs/DOCKER.md)
```

CI runs `check`, `test`, and verifies `schema.sql` is up to date on every PR ([.github/workflows/ci.yml](.github/workflows/ci.yml)). Pushes to `main` deploy via [deploy.yml](.github/workflows/deploy.yml) when the Cloudflare secrets are configured.

## Hard rules (a PR that breaks one is a bug, not a trade-off)

1. **Free-tier first.** New features state their footprint against the table in [docs/FREE_TIER.md](docs/FREE_TIER.md).
2. **Never add a per-message LLM call to a deterministic path** — commands, callbacks, bare media/URL captures, the dispatcher, the heartbeat's all-clear.
3. **Never store file bytes in Postgres.** The Telegram vault holds bytes; Postgres holds metadata, extracted text and chunks.
4. **The core never imports channel-specific types.** `src/agent/`, `src/tools/`, `src/workflows/` see only `src/channels/types.ts`.
5. **Tools implement `execute` only.** RBAC, autonomy gating, timeouts, truncation and auditing live in the registry wrapper — don't re-implement them inside a tool.
6. **Schema before code.** A migration ships in the same PR as the code that needs it, is additive, and `npm run schema` is re-run.
7. **Secrets never reach the browser.** The dashboard shows endpoints and model ids; keys stay Worker secrets.

## Adding things

| What | Where | Also |
|---|---|---|
| A slash command | `src/agent/commands.ts` (`handlers`) | add it to `BOT_COMMANDS` (en + ar) in `src/channels/telegram/index.ts` and to `help_text` in both locales — `test/unit/telegram-commands.test.ts` enforces the first |
| A tool | `src/tools/defs/<area>.ts` with `defineTool` | pick `topics` and `permissionLevel`; add a test in `test/unit/registry.test.ts` if it has gating rules |
| A topic / prompt fragment | `src/tools/topics.ts`, `src/agent/prompts/topic-fragments.ts` | keep fragments short — they cost tokens every turn |
| A migration | `supabase/migrations/NNNN_name.sql` | `npm run schema`; update `src/database/types.ts` |
| A dashboard view | `public/app.js` (`VIEWS`, `ACTIONS`, `NAV`) + a route in `src/web/api.ts` | every write audits with a `web.*` action |
| A channel | `src/channels/<name>/` implementing `ChannelAdapter` (copy `channels/whatsapp/`) | register in `src/channels/registry.ts`; add a media branch in `services/media/fetch.ts`; tests like `test/unit/whatsapp-*.test.ts`; see [docs/EXTENDING.md](docs/EXTENDING.md) |
| A locale string | `src/i18n/locales/en.ts` **and** `ar.ts` | `test/unit/i18n.test.ts` checks key parity |

## Style

- TypeScript strict; no `any` without a comment saying why.
- Zod schemas describe every tool input; `.describe()` text is what the model reads — write it for the model.
- Log with `log(level, event, fields)`; never log tokens, keys or message bodies.
- Comments explain *why*, not *what*. Ported code keeps its attribution comment.
- Prefer a pure function + a unit test over an integration test; the [manual E2E checklist](docs/MANUAL_E2E.md) covers what only Telegram can prove.

## Pull requests

- One concern per PR. Include the free-tier footprint line if it touches a hot path.
- Screenshots for dashboard changes; a transcript snippet for bot-behaviour changes.
- Update docs in the same PR — `docs/COMMANDS.md` for commands, `docs/SKILLS.md` for skills/MCP, `docs/DEPLOYMENT.md` for config.

## Reporting security issues

Please don't open a public issue. Email the maintainer (see `package.json`) with details; you'll get a reply within a few days.
