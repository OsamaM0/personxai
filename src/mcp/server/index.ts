/**
 * PersonXAI as an MCP server.
 *
 * `POST /mcp` speaks MCP over Streamable HTTP, so Claude Code, Codex, or any
 * other MCP client can call the assistant's own tools — and the assistant
 * itself, via `ask_assistant` — against the same data, memory and audit trail
 * as the Telegram bot. See docs/MCP_SERVER.md.
 *
 * The transport is stateless: no session ids, no server-initiated stream. Each
 * POST carries its own bearer token, is authorised on its own, and is answered
 * on the same connection. That is a legal Streamable-HTTP server (a GET is
 * refused with 405) and it is all a tools-only server needs.
 */
import { getAgentByName } from "agents";
import type { Env } from "../../env";
import { loadConfig } from "../../config";
import { createDb, type Db } from "../../database/client";
import { getToolByName } from "../../tools";
import { formatError, log } from "../../utils/logger";
import { ASK_ASSISTANT, catalogFor, toolAllowed } from "./catalog";
import type { McpToolOutcome } from "./execute";
import {
  RPC,
  isMcpRoute,
  negotiateProtocolVersion,
  parseRpcBody,
  rpcError,
  rpcResult,
  wantsSse,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RpcId,
} from "./protocol";
import { authenticateMcp, type McpSession } from "./tokens";

export { MCP_PATH, isMcpRoute } from "./protocol";

const SERVER_NAME = "personxai";
/** Bumped by hand alongside package.json — clients only ever display it. */
const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "PersonXAI is the user's personal assistant: their projects, tasks, notes, files, links,",
  "reminders, long-term memory and stored facts all live here, shared with the Telegram bot",
  "and the web dashboard. Anything you write is immediately visible to the user there.",
  "",
  "Prefer a specific tool when you already know the operation. Use `ask_assistant` for",
  "open-ended requests — it runs a full assistant turn with the user's conversation history,",
  "memory and saved skills, and records the exchange in their conversation.",
  "",
  "Times are the user's local wall time: call `current_time` before computing anything relative.",
].join("\n");

const CORS_HEADERS: Record<string, string> = {
  // Safe as a wildcard: this route authenticates with a bearer token only and
  // never reads the dashboard's session cookie.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-protocol-version",
  "access-control-max-age": "86400",
};

function rpcJson(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...headers },
  });
}

function sse(payload: unknown): Response {
  const body = "event: message\ndata: " + JSON.stringify(payload) + "\n\n";
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

const unauthorized = (message: string): Response =>
  rpcJson({ error: "unauthorized", error_description: message }, 401, {
    // RFC 6750 — tells a compliant client that the credential was the problem.
    "www-authenticate": 'Bearer realm="' + SERVER_NAME + '", error="invalid_token"',
  });

/**
 * Owns every `/mcp` request; returns null for anything else so the worker's
 * other routes keep handling it.
 */
export async function handleMcpServer(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (!isMcpRoute(url.pathname)) return null;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  // No server-initiated stream, and the spec's prescribed answer to that is 405.
  if (request.method === "GET" || request.method === "HEAD") {
    return rpcJson({ error: "this MCP endpoint accepts POST only" }, 405, {
      allow: "POST, DELETE, OPTIONS",
    });
  }
  // Stateless, so there is no session to terminate — but say so politely.
  if (request.method === "DELETE") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return rpcJson({ error: request.method + " is not supported" }, 405, {
      allow: "POST, DELETE, OPTIONS",
    });
  }

  let db: Db;
  let session: McpSession | null;
  try {
    const config = loadConfig(env);
    db = createDb(config.supabase.url, config.supabase.serviceRoleKey);
    session = await authenticateMcp(request, env, db, Date.now());
  } catch (err) {
    log("error", "mcp_server.auth_failed", { error: formatError(err) });
    return rpcJson({ error: "server misconfigured" }, 500);
  }
  if (!session) return unauthorized("provide a PersonXAI MCP token as a bearer credential");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcJson(rpcError(null, RPC.parseError, "request body is not valid JSON"), 400);
  }

  const parsed = parseRpcBody(body);
  if (!parsed) {
    return rpcJson(rpcError(null, RPC.invalidRequest, "not a JSON-RPC 2.0 message"), 400);
  }

  // Stateless, so the client name from `initialize` is not available on a later
  // call: the User-Agent is the provenance the audit trail actually gets.
  const client = (request.headers.get("user-agent") ?? "").slice(0, 120) || undefined;

  const responses: JsonRpcResponse[] = [];
  for (const message of parsed.messages) {
    const response = await dispatch(message, env, session, client);
    if (response) responses.push(response);
  }

  // Every message was a notification: acknowledged, nothing to answer with.
  if (responses.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });

  const payload = parsed.batch ? responses : responses[0];
  return wantsSse(request.headers.get("accept")) ? sse(payload) : rpcJson(payload);
}

async function dispatch(
  message: JsonRpcRequest,
  env: Env,
  session: McpSession,
  client?: string
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  const params = message.params ?? {};

  try {
    switch (message.method) {
      case "initialize": {
        const clientInfo = params["clientInfo"] as { name?: string } | undefined;
        log("info", "mcp_server.initialize", {
          scope: session.scope,
          client: clientInfo?.name ?? "unknown",
        });
        return rpcResult(id, {
          protocolVersion: negotiateProtocolVersion(params["protocolVersion"]),
          // Tools only: no resources, prompts, sampling or server-side logging.
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: "PersonXAI", version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, { tools: catalogFor(session.scope, session.user.role) });

      case "tools/call":
        return await callTool(id, params, env, session, client);

      // The declared capabilities say these are absent; clients probe anyway.
      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "resources/templates/list":
        return rpcResult(id, { resourceTemplates: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });

      default:
        // Notifications (initialized, cancelled, progress) are already covered
        // by the 202 above; only a request deserves "no such method".
        if (isNotification) return null;
        return rpcError(id, RPC.methodNotFound, "unsupported method: " + message.method);
    }
  } catch (err) {
    const error = formatError(err);
    log("error", "mcp_server.dispatch_failed", { method: message.method, error });
    if (isNotification) return null;
    return rpcError(id, RPC.internalError, error);
  }
}

async function callTool(
  id: RpcId,
  params: Record<string, unknown>,
  env: Env,
  session: McpSession,
  client?: string
): Promise<JsonRpcResponse> {
  const name = params["name"];
  if (typeof name !== "string" || name.length === 0) {
    return rpcError(id, RPC.invalidParams, "tools/call requires a string `name`");
  }
  const args = params["arguments"] ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return rpcError(id, RPC.invalidParams, "`arguments` must be an object");
  }

  // Reject an unknown or out-of-scope name here rather than paying for a
  // Durable Object round trip to say the same thing.
  if (name === ASK_ASSISTANT) {
    if (session.scope !== "full" || session.user.role === "viewer") {
      return rpcError(id, RPC.invalidParams, ASK_ASSISTANT + " needs a full-scope token");
    }
  } else {
    const def = getToolByName(name);
    if (!def) return rpcError(id, RPC.invalidParams, "unknown tool: " + name);
    if (!toolAllowed(def, session.scope, session.user.role)) {
      return rpcError(id, RPC.invalidParams, "tool not available to this token: " + name);
    }
  }

  // The per-user Durable Object owns the SQLite handle, the MCP client manager
  // and the serialization guarantee — so the call runs there, exactly as an
  // incoming Telegram message would.
  const agentName = "u:" + session.identity.channel + ":" + session.identity.external_id;
  const stub = await getAgentByName(env.UserAgent, agentName);
  const outcome = (await stub.callMcpTool({
    userId: session.user.id,
    toolName: name,
    input: args,
    scope: session.scope,
    client,
  })) as McpToolOutcome;

  return rpcResult(id, {
    content: [{ type: "text", text: outcome.text }],
    isError: outcome.isError,
  });
}
