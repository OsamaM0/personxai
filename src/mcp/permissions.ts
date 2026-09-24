/**
 * MCP tools reach the model through the same gate as native tools: they are all
 * treated as permissionLevel 'external' (confirmation at autonomy 0–1), get the
 * same timeout and truncation, and land in tool_calls for audit.
 */
import type { Tool, ToolSet } from "ai";
import type { AgentContext } from "../agent/context";
import { createCallbackToken, encodeCallbackData } from "../agent/confirmations";
import { needsConfirmation } from "../security/autonomy";
import { roleAllowsPermission } from "../security/rbac";
import { redactToolArgs, summarizeToolResult } from "../security/redact";
import type { ToolCallCollector, PendingToolCall } from "../tools/registry";
import { t } from "../i18n";
import { truncate } from "../utils/text";
import { formatError, log } from "../utils/logger";

/** Pending MCP calls are executed on confirm by tools/index.ts via this registry. */
const pendingExecutors = new Map<string, (input: unknown) => Promise<unknown>>();

export function getMcpExecutor(toolName: string): ((input: unknown) => Promise<unknown>) | undefined {
  return pendingExecutors.get(toolName);
}

export function gateMcpTools(
  raw: ToolSet,
  ctx: AgentContext,
  collector: ToolCallCollector
): ToolSet {
  const gated: ToolSet = {};
  for (const [name, tool] of Object.entries(raw)) {
    const original = tool as Tool & {
      execute?: (input: unknown, options: unknown) => Promise<unknown>;
    };
    if (typeof original.execute !== "function") {
      gated[name] = tool;
      continue;
    }
    const run = original.execute.bind(original);
    pendingExecutors.set(name, (input: unknown) => run(input, { toolCallId: name, messages: [] }));

    gated[name] = {
      ...original,
      execute: async (input: unknown, options: unknown) => {
        const started = Date.now();
        const record = (status: string, result: unknown, error?: string) => {
          collector.rows.push({
            tool_name: `mcp:${name}`,
            args: redactToolArgs(input) as never,
            result_summary: truncate(summarizeToolResult(result, 500), 500),
            status,
            error: error ?? null,
            duration_ms: Date.now() - started,
          });
        };
        try {
          if (collector.toolBudget <= 0) {
            const out = { error: "tool budget for this turn is exhausted" };
            record("budget_exceeded", out);
            return out;
          }
          collector.toolBudget--;

          if (!roleAllowsPermission(ctx.user.role, "external")) {
            const out = { error: `permission denied: your role cannot use external tools` };
            record("denied", out);
            return out;
          }

          const decision = needsConfirmation({ level: "external", autonomy: ctx.user.autonomy_level });
          if (decision.requires) {
            const label = `${name}(${truncate(JSON.stringify(input ?? {}), 100)})`;
            const token = createCallbackToken<PendingToolCall>(
              ctx.do,
              "cfm",
              { tool: `mcp:${name}`, input, label },
              ctx.now.getTime()
            );
            await ctx.out.sendButtons(
              ctx.chatRef,
              t(ctx.locale, "confirm_prompt", { action: label }),
              [
                [
                  { label: t(ctx.locale, "btn_confirm"), data: encodeCallbackData("cfm", token, "y") },
                  { label: t(ctx.locale, "btn_cancel"), data: encodeCallbackData("cfm", token, "n") },
                ],
              ]
            );
            const out = {
              status: "awaiting_confirmation",
              note: "A confirmation button was sent. Tell the user briefly and stop — do not retry.",
            };
            record("awaiting_confirmation", out);
            return out;
          }

          const result = await run(input, options);
          record("ok", result);
          const json = JSON.stringify(result ?? null);
          if (json.length > ctx.config.limits.toolResultChars) {
            return {
              truncated: true,
              summary: summarizeToolResult(result, ctx.config.limits.toolResultChars),
            };
          }
          return result ?? { ok: true };
        } catch (err) {
          const message = formatError(err);
          log("warn", "mcp_tool_failed", { tool: name, error: message });
          const out = { error: truncate(message, 300) };
          record("error", out, message);
          return out;
        }
      },
    } as Tool;
  }
  return gated;
}
