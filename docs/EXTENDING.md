# Extending PersonXAI

The core is deliberately small; capability grows through four seams.

## 1. New chat channel (Discord, Slack, Signal, …)

Two channels ship — [`channels/telegram/`](../src/channels/telegram/) and [`channels/whatsapp/`](../src/channels/whatsapp/) ([WHATSAPP.md](WHATSAPP.md)); the second one is the worked example of adding a channel without touching the core. Implement `ChannelAdapter` from [`src/channels/types.ts`](../src/channels/types.ts):

```ts
export interface ChannelAdapter {
  name: string;                                                  // 'discord'
  isConfigured?(env: Env): boolean;                              // reported by /health
  handshake?(req: Request, env: Env, url: URL): Response | null; // provider GET verification, if any
  verifyWebhook(req: Request, env: Env, rawBody: string): boolean | Promise<boolean>; // constant-time!
  parseUpdate(body: unknown): IncomingMessage | null;            // normalize; never throw
  outbound(env: Env, incoming?: IncomingMessage): OutboundPort;  // sendText/buttons/edit/...
}
```

1. Create `src/channels/<name>/` (mirror the WhatsApp adapter: `api.ts`, `webhook.ts`, `normalize.ts`, `send.ts`, `index.ts`). Where the provider lacks a Telegram primitive, **degrade, don't fail** — WhatsApp turns `editText` into a fresh message and inline keyboards into reply buttons or lists.
2. Register it in [`src/channels/registry.ts`](../src/channels/registry.ts).
3. The webhook route `/channels/<name>/webhook` starts working immediately (GET → `handshake`, POST → `verifyWebhook` with the raw body, then `parseUpdate`); per-user agents are addressed `u:<name>:<externalUserId>`.
4. Media: add a branch to [`services/media/fetch.ts`](../src/services/media/fetch.ts) that downloads bytes from the provider. The ingest pipeline relays non-Telegram media into the Telegram vault automatically.
5. Owner linking: extend `isOwnerIdentity` in [`src/config.ts`](../src/config.ts) with an `OWNER_<NAME>_ID` variable so the owner's first message links the identity to the existing account (`addIdentity`) — same brain, new channel.

The core (`src/agent/`, `src/tools/`, `src/workflows/`) must never import channel-specific types — only `channels/types.ts`.

## 2. New tools

Define with the registry (`src/tools/registry.ts`):

```ts
defineTool({
  name: "create_task",
  description: "...",
  inputSchema: z.object({ ... }),          // zod v4 — validated before execute
  topics: ["tasks"],                        // topic-based selection keeps prompts small
  permissionLevel: "write",                // read | write | destructive | external
  execute: async (input, ctx) => { ... },  // ctx: AgentContext (db, user, out, ...)
});
```

The wrapper enforces RBAC, autonomy/confirmation gating, timeout, result truncation, and tool_calls auditing — tools only implement `execute`.

## 3. MCP servers (GitHub, Notion, Gmail, …)

The Agents SDK `MCPClientManager` (`this.mcp` on the DO) is wired in `src/mcp/`: add a server URL from chat or the dashboard ([SKILLS.md](SKILLS.md)), and its tools appear to the model through the same permission gate (`external` level → confirmation per the autonomy matrix). No core changes per integration.

## 4. Scheduled behaviors

Insert a `reminders` row with `kind='dynamic'` and a `template_id`; the dispatcher re-enters the agent loop with role `system_routine_task`. `daily_brief` and `heartbeat` are the built-in templates — add new ones in `src/workflows/`.

## 5. Hosting

- **Cloudflare** (default): [DEPLOYMENT.md](DEPLOYMENT.md).
- **Docker / self-hosted**: the same Worker on workerd via `wrangler dev`, cron replaced by a sidecar — [DOCKER.md](DOCKER.md).
- **Vercel**: hosts the dashboard SPA and proxies `/api`, `/auth`, `/mcp` to the Worker through Edge Middleware — [VERCEL.md](VERCEL.md). Any other static host + reverse proxy works the same way given `PUBLIC_BASE_URL` and `ALLOWED_ORIGINS`.

## Roadmap notes (not yet built — PRs welcome)

- **WhatsApp message templates** for reminders outside the 24-hour customer-service window (see [WHATSAPP.md](WHATSAPP.md#limitations)).
- **Discord / Slack** adapters — the WhatsApp adapter is the template.
- **GitHub / Notion / Google Calendar / Gmail / Drive**: prefer MCP servers (hosted or self-run) over bespoke REST tools; they arrive pre-gated.
- **Browser automation**: Cloudflare Browser Rendering has a Workers binding; wrap as a `research` tool.
- **OCR**: Workers AI vision models or an external OCR API as a `file` tool; extraction pipeline already stores `extracted_text` + chunks.
- **Image generation**: Workers AI image models; store outputs via the vault (`sendDocument`) or R2 when enabled.
