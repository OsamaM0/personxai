/**
 * Tool registry. Pattern adapted from Stacks (getstacksapp.com, AGPL — used
 * with the author's knowledge): one flat registry of typed tool definitions,
 * adapted into an AI-SDK ToolSet with a uniform gate wrapper.
 *
 * The wrapper enforces, in order: RBAC → autonomy/confirmation → same-turn
 * create dedup → timeout → result truncation → tool_calls audit collection.
 * Tools themselves only implement `execute`.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "../agent/context";
import { createCallbackToken, encodeCallbackData } from "../agent/confirmations";
import { needsConfirmation } from "../security/autonomy";
import { roleAllowsPermission, type PermissionLevel } from "../security/rbac";
import { redactToolArgs, summarizeToolResult } from "../security/redact";
import { t } from "../i18n";
import { contentHash, truncate } from "../utils/text";
import { formatError, log } from "../utils/logger";
import type { Topic } from "./topics";
import type { TablesInsert } from "../database/types";

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;
  topics: Topic[];
  permissionLevel: PermissionLevel;
  /** Force confirmation regardless of autonomy level. */
  requiresConfirmation?: boolean;
  /** Cannot be undone (permanent delete, external send) — confirmed even at autonomy 3. */
  irreversible?: boolean;
  timeoutMs?: number;
  /** Human-readable one-liner shown on the confirmation button prompt. */
  confirmLabel?: (input: z.infer<S>) => string;
  /** Creates an entity — enables same-turn duplicate suppression. */
  isCreate?: boolean;
  execute: (input: z.infer<S>, ctx: AgentContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

// biome-ignore format: registry assembled in ./index.ts
export type AnyToolDef = ToolDef<z.ZodType>;

/** Payload stored behind a confirmation token; executed on button press. */
export interface PendingToolCall {
  tool: string;
  input: unknown;
  label: string;
}

/** Collects tool_calls rows during a turn; the orchestrator persists them with the run id. */
export class ToolCallCollector {
  rows: Omit<TablesInsert<"tool_calls">, "run_id" | "user_id">[] = [];
  private createSignatures = new Set<string>();
  toolBudget: number;

  constructor(budget: number) {
    this.toolBudget = budget;
  }

  seenCreate(name: string, input: unknown): boolean {
    const sig = `${name}:${contentHash(JSON.stringify(input ?? null))}`;
    if (this.createSignatures.has(sig)) return true;
    this.createSignatures.add(sig);
    return false;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool ${name} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Execute a tool definition directly (used by the confirmation callback path). */
export async function executeToolDirect(
  def: AnyToolDef,
  input: unknown,
  ctx: AgentContext
): Promise<unknown> {
  const parsed = def.inputSchema.parse(input);
  return withTimeout(def.execute(parsed, ctx), def.timeoutMs ?? ctx.config.limits.toolTimeoutMs, def.name);
}

export function toAiToolSet(
  defs: AnyToolDef[],
  ctx: AgentContext,
  collector: ToolCallCollector
): ToolSet {
  const set: ToolSet = {};
  for (const def of defs) {
    set[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (rawInput: unknown) => {
        const started = Date.now();
        const record = (status: string, result: unknown, error?: string) => {
          collector.rows.push({
            tool_name: def.name,
            args: redactToolArgs(rawInput) as never,
            result_summary: truncate(summarizeToolResult(result, 500), 500),
            status,
            error: error ?? null,
            duration_ms: Date.now() - started,
          });
        };

        try {
          if (collector.toolBudget <= 0) {
            const out = { error: "tool budget for this turn is exhausted; answer with what you have" };
            record("budget_exceeded", out);
            return out;
          }
          collector.toolBudget--;

          if (!roleAllowsPermission(ctx.user.role, def.permissionLevel)) {
            const out = { error: `permission denied: your role cannot use ${def.name}` };
            record("denied", out);
            return out;
          }

          const decision = needsConfirmation({
            level: def.permissionLevel,
            autonomy: ctx.user.autonomy_level,
            toolFlag: def.requiresConfirmation,
            irreversible: def.irreversible,
          });
          if (decision.requires) {
            const input = def.inputSchema.parse(rawInput);
            const label = def.confirmLabel
              ? def.confirmLabel(input)
              : `${def.name}(${truncate(JSON.stringify(input), 120)})`;
            const token = createCallbackToken<PendingToolCall>(
              ctx.do,
              "cfm",
              { tool: def.name, input, label },
              ctx.now.getTime()
            );
            await ctx.out.sendButtons(ctx.chatRef, t(ctx.locale, "confirm_prompt", { action: label }), [
              [
                { label: t(ctx.locale, "btn_confirm"), data: encodeCallbackData("cfm", token, "y") },
                { label: t(ctx.locale, "btn_cancel"), data: encodeCallbackData("cfm", token, "n") },
              ],
            ]);
            const out = {
              status: "awaiting_confirmation",
              note: "A confirmation button was sent to the user. Tell them briefly what awaits confirmation and stop — do not retry this tool.",
            };
            record("awaiting_confirmation", out);
            return out;
          }

          if (def.isCreate && collector.seenCreate(def.name, rawInput)) {
            const out = { error: "duplicate of an item already created in this turn; skipped" };
            record("deduped", out);
            return out;
          }

          const input = def.inputSchema.parse(rawInput);
          const result = await withTimeout(
            def.execute(input, ctx),
            def.timeoutMs ?? ctx.config.limits.toolTimeoutMs,
            def.name
          );
          record("ok", result);

          const json = JSON.stringify(result ?? null);
          if (json.length > ctx.config.limits.toolResultChars) {
            return { truncated: true, summary: summarizeToolResult(result, ctx.config.limits.toolResultChars) };
          }
          return result ?? { ok: true };
        } catch (err) {
          const message = formatError(err);
          log("warn", "tool_failed", { tool: def.name, error: message });
          const out = { error: truncate(message, 300) };
          record("error", out, message);
          return out;
        }
      },
    });
  }
  return set;
}
