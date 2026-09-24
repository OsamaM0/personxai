/**
 * Tool assembly: the flat registry + topic filtering + confirmation execution.
 * Importing this module also registers the callback handlers (cfm, inbox).
 */
import type { ToolSet } from "ai";
import type { AgentContext } from "../agent/context";
import { registerCallbackKind } from "../agent/callback-registry";
import { insertAudit } from "../database/repos/audit";
import { t } from "../i18n";
import { formatError, log } from "../utils/logger";
import { truncate } from "../utils/text";
import { getMcpExecutor } from "../mcp/permissions";
import { coreTools } from "./defs/core";
import { fileTools } from "./defs/files";
import { inboxTools } from "./defs/inbox";
import { linkTools } from "./defs/links";
import { memoryTools } from "./defs/memories";
import { noteTools } from "./defs/notes";
import { projectTools } from "./defs/projects";
import { reminderTools } from "./defs/reminders";
import { searchTools } from "./defs/search";
import { skillTools } from "./defs/skills";
import { taskTools } from "./defs/tasks";
import { tagTools } from "./defs/tags";
import { walletTools } from "./defs/wallet";
import {
  executeToolDirect,
  toAiToolSet,
  ToolCallCollector,
  type AnyToolDef,
  type PendingToolCall,
} from "./registry";
import type { Topic } from "./topics";

export const toolRegistry: AnyToolDef[] = [
  ...coreTools,
  ...projectTools,
  ...taskTools,
  ...noteTools,
  ...reminderTools,
  ...inboxTools,
  ...fileTools,
  ...memoryTools,
  ...linkTools,
  ...searchTools,
  ...skillTools,
  ...tagTools,
  ...walletTools,
];

const byName = new Map(toolRegistry.map((def) => [def.name, def]));

export function getToolByName(name: string): AnyToolDef | undefined {
  return byName.get(name);
}

export function toolsForTopics(topics: Topic[]): AnyToolDef[] {
  const topicSet = new Set(topics);
  return toolRegistry.filter(
    (def) => def.topics.length === 0 || def.topics.some((topic) => topicSet.has(topic))
  );
}

export function buildToolSet(
  topics: Topic[],
  ctx: AgentContext,
  collector: ToolCallCollector
): ToolSet {
  return toAiToolSet(toolsForTopics(topics), ctx, collector);
}

// ── Confirmation execution (inline Confirm/Cancel buttons) ───────────────────
registerCallbackKind("cfm", async (ctx, payload, verb, messageId) => {
  const pending = payload as PendingToolCall;
  const finish = async (text: string) => {
    if (messageId) {
      await ctx.out.editText(ctx.chatRef, messageId, text, { removeButtons: true }).catch(() => {});
    } else {
      await ctx.out.sendText(ctx.chatRef, text);
    }
  };

  if (verb !== "y") {
    await finish(t(ctx.locale, "confirm_cancelled"));
    return;
  }
  const isMcp = pending.tool.startsWith("mcp:");
  const def = isMcp ? undefined : getToolByName(pending.tool);
  const mcpExec = isMcp ? getMcpExecutor(pending.tool.slice(4)) : undefined;
  if (!def && !mcpExec) {
    await finish(t(ctx.locale, "confirm_expired"));
    return;
  }
  try {
    const result = def
      ? await executeToolDirect(def, pending.input, ctx)
      : await mcpExec!(pending.input);
    const summary =
      result && typeof result === "object" && "error" in (result as Record<string, unknown>)
        ? String((result as Record<string, unknown>)["error"])
        : null;
    await insertAudit(ctx.db, {
      user_id: ctx.user.id,
      actor: "user",
      action: `confirm:${pending.tool}`,
      details: { label: pending.label },
      status: summary ? "error" : "ok",
    });
    await finish(
      summary
        ? `${t(ctx.locale, "error_generic")} (${truncate(summary, 120)})`
        : `${t(ctx.locale, "confirm_executed")} ${pending.label}`
    );
  } catch (err) {
    log("warn", "confirmed_tool_failed", { tool: pending.tool, error: formatError(err) });
    await finish(t(ctx.locale, "error_generic"));
  }
});
