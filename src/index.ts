/**
 * Worker entry: webhook ingress (fast-ACK), health, dispatcher, cron.
 */
import { getAgentByName } from "agents";
import type { Env } from "./env";
import { channelStatus, getAdapter } from "./channels/registry";
import {
  registerTelegramCommands,
  registerTelegramMenuButton,
  registerTelegramWebhook,
} from "./channels/telegram";
import { isWhatsAppConfigured } from "./channels/whatsapp";
import { constantTimeEquals } from "./utils/crypto";
import { dispatchTick } from "./scheduler/dispatcher";
import { handleMcpServer } from "./mcp/server";
import { handleWeb } from "./web";
import { log, formatError } from "./utils/logger";

export { UserAgent } from "./agent/user-agent";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "personxai", channels: channelStatus(env) });
    }

    // Dashboard API + sign-in. Returns null for every other path.
    const web = await handleWeb(request, env, url, (p) => ctx.waitUntil(p));
    if (web) return web;

    // MCP server (docs/MCP_SERVER.md) — bearer-authenticated, cookie-blind.
    const mcp = await handleMcpServer(request, env, url);
    if (mcp) return mcp;

    // /channels/<name>/webhook — provider handshake on GET, fast-ACK ingress on POST
    const webhookMatch = url.pathname.match(/^\/channels\/([a-z0-9_-]+)\/webhook$/);
    if (webhookMatch) {
      const adapter = getAdapter(webhookMatch[1] ?? "");
      if (!adapter) return new Response("not found", { status: 404 });

      if (request.method === "GET") {
        const handshake = adapter.handshake?.(request, env, url) ?? null;
        return handshake ?? new Response("method not allowed", { status: 405 });
      }
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

      // The body is read once as text: signature schemes hash the exact bytes.
      const rawBody = await request.text();
      if (!(await adapter.verifyWebhook(request, env, rawBody))) {
        return new Response("forbidden", { status: 403 });
      }
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return new Response("ok", { status: 200 });
      }
      const msg = adapter.parseUpdate(body);
      if (!msg) return new Response("ok", { status: 200 });

      // Vault-channel posts are infrastructure, not conversations — log the chat
      // id so setup can discover it, then ack.
      if (msg.kind === "channel_post") {
        log("info", "channel_post_seen", { chatId: msg.externalChatId });
        return new Response("ok", { status: 200 });
      }

      const agentName = `u:${msg.channel}:${msg.externalUserId}`;
      ctx.waitUntil(
        (async () => {
          try {
            const stub = await getAgentByName(env.UserAgent, agentName);
            await stub.ingest(msg);
          } catch (err) {
            log("error", "webhook_dispatch_failed", { error: formatError(err) });
          }
        })()
      );
      return new Response("ok", { status: 200 });
    }

    // POST /dispatch — manual dispatcher trigger (bearer-gated)
    if (url.pathname === "/dispatch" && request.method === "POST") {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!constantTimeEquals(token, env.DISPATCH_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }
      const stats = await dispatchTick(env);
      return json({ ok: true, ...stats });
    }

    // POST /admin/register-webhook?secret=<DISPATCH_SECRET> — one-time setup helper
    // (webhook + command menu + bot description; idempotent, re-run any time)
    if (url.pathname === "/admin/register-webhook" && request.method === "POST") {
      const secret = url.searchParams.get("secret") ?? "";
      if (!constantTimeEquals(secret, env.DISPATCH_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }
      const publicOrigin = env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || url.origin;
      const webhookUrl = `${url.origin}/channels/telegram/webhook`;
      await registerTelegramWebhook(env.TELEGRAM_BOT_TOKEN, webhookUrl, env.TELEGRAM_WEBHOOK_SECRET);
      // Also publish the "/" command menu + bot description so the bot is
      // discoverable inside Telegram without reading any docs.
      let commands: "ok" | string = "ok";
      // The dashboard is also the bot's Mini App, so the same call points the
      // chat menu button at it (see src/web/miniapp.ts).
      try {
        await registerTelegramCommands(env.TELEGRAM_BOT_TOKEN);
        await registerTelegramMenuButton(env.TELEGRAM_BOT_TOKEN, publicOrigin);
      } catch (err) {
        commands = formatError(err);
        log("warn", "register_commands_failed", { error: commands });
      }
      // WhatsApp has no registration call: Meta's dashboard is told this URL and
      // verifies it with a GET handshake (docs/WHATSAPP.md). Report it here so
      // the wizard and humans can copy it.
      const whatsapp = {
        configured: isWhatsAppConfigured(env),
        webhook: `${url.origin}/channels/whatsapp/webhook`,
      };
      return json({ ok: true, webhook: webhookUrl, commands, miniApp: publicOrigin, whatsapp });
    }

    // The static dashboard normally never reaches the worker (assets are served
    // ahead of it), but `run_worker_first` paths and asset-less configs land here.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      dispatchTick(env).catch((err) => {
        log("error", "cron_dispatch_failed", { error: formatError(err) });
      })
    );
  },
} satisfies ExportedHandler<Env>;
