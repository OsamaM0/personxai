/**
 * MCP tool execution. Runs INSIDE the per-user Durable Object, reached over RPC
 * from the worker's /mcp route, so an MCP call is serialized against that same
 * user's Telegram traffic and gets the real DO SQLite handle (confirmations,
 * callback tokens) and the DO's live MCP client manager.
 *
 * Two paths:
 *   ask_assistant — a full agent turn. PersonXAI picks its own tools, so the
 *     calling client cannot show the human what will run; the turn therefore
 *     keeps the confirmation gate for irreversible and confirm-always tools
 *     (those still ask on Telegram) while ordinary writes proceed.
 *   a named tool — the client already showed the human the exact call and its
 *     arguments, which is the same assurance a Telegram confirmation button
 *     gives, so the gate is not run a second time. RBAC and scope still apply,
 *     and every call is audited.
 */
import { z } from "zod";
import type { AgentContext } from "../../agent/context";
import { kvGet, kvSet } from "../../agent/do-schema";
import { buildUserContext, runConversationTurn, type OrchestratorDeps } from "../../agent/orchestrator";
import { insertAudit } from "../../database/repos/audit";
import { takeToken, type BucketState } from "../../security/ratelimit";
import { redactToolArgs, summarizeToolResult } from "../../security/redact";
import { executeToolDirect } from "../../tools/registry";
import { getToolByName } from "../../tools";
import { formatError, log } from "../../utils/logger";
import { truncate } from "../../utils/text";
import { ASK_ASSISTANT, parseAskAssistantInput, toolAllowed } from "./catalog";
import type { McpScope } from "./tokens";

/** Provenance recorded on messages started from this surface. */
export const MCP_CHANNEL = "mcp";

export interface McpToolRequest {
  userId: string;
  toolName: string;
  input: unknown;
  scope: McpScope;
  /** Client name from `initialize`, recorded in the audit trail. */
  client?: string;
}

/** Serialized across the DO RPC boundary, so: plain JSON only. */
export interface McpToolOutcome {
  text: string;
  isError: boolean;
}

const fail = (text: string): McpToolOutcome => ({ text, isError: true });

/** Zod issues read far better than a stringified ZodError in a client's tool pane. */
function describeInputError(err: unknown): string | null {
  if (!(err instanceof z.ZodError)) return null;
  const issues = err.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return `invalid arguments — ${issues.join("; ")}`;
}

export async function executeMcpTool(
  deps: OrchestratorDeps,
  req: McpToolRequest
): Promise<McpToolOutcome> {
  const ctx = await buildUserContext(deps, req.userId, { channel: MCP_CHANNEL });
  if (!ctx) return fail("this account is not reachable — sign in to the bot on Telegram first");

  try {
    return req.toolName === ASK_ASSISTANT
      ? await runAssistantTurn(ctx, req)
      : await runNamedTool(ctx, req);
  } catch (err) {
    const invalid = describeInputError(err);
    if (invalid) return fail(invalid);
    const message = formatError(err);
    log("warn", "mcp_server.tool_failed", { tool: req.toolName, error: message });
    await auditCall(ctx, req, "error", message).catch(() => {});
    return fail(truncate(message, 500));
  }
}

/**
 * An assistant turn costs an LLM call, so it draws on the same per-minute
 * bucket a Telegram message does — one budget per user, however they reach it.
 * Named tool calls are a single query and are governed by the token instead.
 */
function withinRateLimit(ctx: AgentContext): boolean {
  const raw = kvGet(ctx.do, "rate");
  const stored: BucketState | null = raw ? (JSON.parse(raw) as BucketState) : null;
  const rate = takeToken(stored, ctx.now.getTime(), {
    capacity: ctx.config.limits.rateLimitPerMinute,
    refillPerMinute: ctx.config.limits.rateLimitPerMinute,
  });
  kvSet(ctx.do, "rate", JSON.stringify(rate.state));
  return rate.allowed;
}

async function runAssistantTurn(ctx: AgentContext, req: McpToolRequest): Promise<McpToolOutcome> {
  if (req.scope !== "full" || ctx.user.role === "viewer") {
    return fail(`${ASK_ASSISTANT} needs a full-scope token`);
  }
  const input = parseAskAssistantInput(req.input);
  if (!withinRateLimit(ctx)) {
    return fail("rate limited — this account has used its assistant turns for the minute");
  }

  // The MCP client is the human's approval surface for THIS call, but not for
  // the tools the assistant then picks on its own — so lift autonomy to 3,
  // which still leaves irreversible and confirm-always tools asking on Telegram.
  const turnCtx: AgentContext = {
    ...ctx,
    user: { ...ctx.user, autonomy_level: Math.max(ctx.user.autonomy_level, 3) },
  };

  const reply = await runConversationTurn(turnCtx, input.message, {
    trigger: "message",
    deliver: input.deliver_to_telegram === true,
  });
  await auditCall(ctx, req, "ok", null);
  return {
    text:
      reply.trim().length > 0
        ? reply
        : "The assistant sent an interactive prompt to Telegram instead of a text reply (a confirmation is waiting there).",
    isError: false,
  };
}

async function runNamedTool(ctx: AgentContext, req: McpToolRequest): Promise<McpToolOutcome> {
  const def = getToolByName(req.toolName);
  if (!def) return fail(`unknown tool: ${req.toolName}`);
  if (!toolAllowed(def, req.scope, ctx.user.role)) {
    return fail(
      req.scope === "read"
        ? `${def.name} is not available to a read-scope token`
        : `permission denied: your role cannot use ${def.name}`
    );
  }

  const result = await executeToolDirect(def, req.input, ctx);
  const failed =
    result !== null && typeof result === "object" && "error" in (result as Record<string, unknown>);
  await auditCall(ctx, req, failed ? "error" : "ok", null, result);

  const rendered = JSON.stringify(result ?? { ok: true }, null, 2);
  return {
    text:
      rendered.length > ctx.config.limits.toolResultChars
        ? summarizeToolResult(result, ctx.config.limits.toolResultChars)
        : rendered,
    isError: failed,
  };
}

function auditCall(
  ctx: AgentContext,
  req: McpToolRequest,
  status: "ok" | "error",
  error: string | null,
  result?: unknown
): Promise<void> {
  return insertAudit(ctx.db, {
    user_id: ctx.user.id,
    actor: "user",
    action: `mcp:${req.toolName}`,
    status,
    details: JSON.parse(
      JSON.stringify({
        client: req.client ?? null,
        scope: req.scope,
        args: redactToolArgs(req.input),
        result: result === undefined ? null : truncate(summarizeToolResult(result, 300), 300),
        error,
      })
    ),
  });
}
