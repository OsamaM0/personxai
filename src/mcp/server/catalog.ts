/**
 * The tool catalogue advertised over MCP.
 *
 * There is no second registry: this is `src/tools`'s flat registry, converted
 * to MCP descriptors, plus one synthetic tool (`ask_assistant`) that runs a
 * full agent turn. Anything added to the native registry shows up here for
 * free, which is the point — the MCP surface can never drift from Telegram's.
 */
import { z } from "zod";
import type { Enums } from "../../database/types";
import { roleAllowsPermission } from "../../security/rbac";
import { toolRegistry } from "../../tools";
import type { AnyToolDef } from "../../tools/registry";
import { formatError, log } from "../../utils/logger";
import type { McpScope } from "./tokens";

export const ASK_ASSISTANT = "ask_assistant";

/** MCP tool annotations (spec: all hints, never guarantees — clients may ignore them). */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

const askAssistantSchema = z.object({
  message: z
    .string()
    .min(1)
    .max(4000)
    .describe("What to ask or tell the assistant, exactly as you would type it in Telegram."),
  deliver_to_telegram: z
    .boolean()
    .optional()
    .describe("Also send the reply to the user's Telegram chat. Default false — the answer is returned here."),
});

const ASK_ASSISTANT_DESCRIPTION = [
  "Ask PersonXAI itself — one full assistant turn with the user's conversation history,",
  "long-term memory, stored facts, saved skills and every one of its own tools available to it.",
  "Use this for anything open-ended ('what should I focus on today?', 'organise this into my projects'),",
  "and use the specific tools below when you already know the exact operation you want.",
  "The turn is recorded in the user's conversation, so it is visible from Telegram and the dashboard.",
].join(" ");

/**
 * Zod → JSON Schema. Cached: the registry is static for the lifetime of the
 * isolate, and `tools/list` is called on every client connect.
 */
const schemaCache = new Map<string, Record<string, unknown>>();

export function jsonSchemaFor(name: string, schema: z.ZodType): Record<string, unknown> {
  const cached = schemaCache.get(name);
  if (cached) return cached;
  let converted: Record<string, unknown>;
  try {
    converted = z.toJSONSchema(schema, {
      target: "draft-7",
      io: "input",
      // A tool whose schema has an unrepresentable corner must still be
      // callable; `any` degrades that one field rather than the whole tool.
      unrepresentable: "any",
    }) as Record<string, unknown>;
  } catch (err) {
    log("warn", "mcp_server.schema_conversion_failed", { tool: name, error: formatError(err) });
    converted = { type: "object", properties: {} };
  }
  // `$schema` is noise inside an MCP inputSchema, and some clients reject it.
  delete converted["$schema"];
  if (converted["type"] !== "object") converted = { type: "object", properties: {} };
  if (!converted["properties"]) converted["properties"] = {};
  schemaCache.set(name, converted);
  return converted;
}

function annotationsFor(def: AnyToolDef): McpToolAnnotations {
  const readOnly = def.permissionLevel === "read";
  return {
    readOnlyHint: readOnly,
    // `irreversible` is the tool's own word for "cannot be undone"; destructive
    // permission means it deletes something the user owns.
    destructiveHint: Boolean(def.irreversible) || def.permissionLevel === "destructive",
    // Creates are not idempotent by construction; reads always are.
    idempotentHint: readOnly ? true : !def.isCreate,
    // Only `external` tools reach anything outside the user's own data.
    openWorldHint: def.permissionLevel === "external",
  };
}

function describe(def: AnyToolDef): McpToolDescriptor {
  const suffix =
    def.irreversible || def.permissionLevel === "destructive"
      ? " (destructive: this cannot be undone)"
      : "";
  return {
    name: def.name,
    description: def.description + suffix,
    inputSchema: jsonSchemaFor(def.name, def.inputSchema),
    annotations: annotationsFor(def),
  };
}

/** True when this grant may see (and therefore call) the tool at all. */
export function toolAllowed(
  def: AnyToolDef,
  scope: McpScope,
  role: Enums<"user_role">
): boolean {
  if (!roleAllowsPermission(role, def.permissionLevel)) return false;
  if (scope === "read") return def.permissionLevel === "read";
  return true;
}

export function askAssistantDescriptor(): McpToolDescriptor {
  return {
    name: ASK_ASSISTANT,
    description: ASK_ASSISTANT_DESCRIPTION,
    inputSchema: jsonSchemaFor(ASK_ASSISTANT, askAssistantSchema),
    annotations: {
      title: "Ask PersonXAI",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      // The turn may reach the user's connected MCP servers and the web.
      openWorldHint: true,
    },
  };
}

export function parseAskAssistantInput(input: unknown): z.infer<typeof askAssistantSchema> {
  return askAssistantSchema.parse(input);
}

/** The full catalogue for one grant, in registry order. */
export function catalogFor(scope: McpScope, role: Enums<"user_role">): McpToolDescriptor[] {
  const tools = toolRegistry.filter((def) => toolAllowed(def, scope, role)).map(describe);
  // A read-only grant gets no assistant turn: the turn can call write tools.
  if (scope === "full" && role !== "viewer") tools.unshift(askAssistantDescriptor());
  return tools;
}
