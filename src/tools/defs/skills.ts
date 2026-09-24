import { z } from "zod";
import { defineTool } from "../registry";
import {
  createSkill,
  deleteMcpServer,
  deleteSkill,
  findSkillByName,
  listMcpServers,
  listSkills,
  setSystemPrompt,
  updateSkill,
  upsertMcpServer,
} from "../../database/repos/skills";
import { insertAudit } from "../../database/repos/audit";
import { truncate } from "../../utils/text";

const triggersSchema = z.object({
  keywords: z.array(z.string()).max(10).optional(),
  commands: z.array(z.string()).max(5).optional(),
});

export const skillTools = [
  defineTool({
    name: "create_skill",
    description:
      "Save a reusable skill: a named set of instructions (plus which tools it may use and what phrases trigger it). Use when the user describes a repeatable workflow they want you to follow.",
    inputSchema: z.object({
      name: z.string().min(1).max(60),
      description: z.string().max(300).optional(),
      instructions: z
        .string()
        .min(10)
        .max(4000)
        .describe("what you should do when this skill runs, written as directions to yourself"),
      tools: z
        .array(z.string())
        .max(20)
        .optional()
        .describe("tool names the skill may use; omit or use ['*'] for all"),
      triggers: triggersSchema.optional(),
    }),
    topics: ["settings"],
    permissionLevel: "write",
    isCreate: true,
    confirmLabel: (i) => `Create skill "${i.name}"`,
    execute: async (input, ctx) => {
      const existing = await findSkillByName(ctx.db, ctx.user.id, input.name);
      if (existing && existing.user_id === ctx.user.id) {
        await updateSkill(ctx.db, ctx.user.id, existing.id, {
          description: input.description ?? existing.description,
          instructions: input.instructions,
          tools: input.tools ?? existing.tools,
          triggers: (input.triggers ?? existing.triggers) as never,
          version: existing.version + 1,
        });
        return { updated: true, skillId: existing.id, version: existing.version + 1 };
      }
      const row = await createSkill(ctx.db, {
        user_id: ctx.user.id,
        name: input.name,
        description: input.description ?? null,
        instructions: input.instructions,
        tools: input.tools ?? ["*"],
        triggers: (input.triggers ?? {}) as never,
      });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "skill.create",
        entity_kind: "skill",
        entity_id: row.id,
      });
      return { created: true, skillId: row.id, name: row.name };
    },
  }),

  defineTool({
    name: "list_skills",
    description: "List saved skills and whether each is enabled.",
    inputSchema: z.object({}),
    topics: ["settings"],
    permissionLevel: "read",
    execute: async (_input, ctx) => {
      const rows = await listSkills(ctx.db, ctx.user.id);
      return {
        skills: rows.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          enabled: s.enabled,
          version: s.version,
          global: s.user_id === null,
        })),
      };
    },
  }),

  defineTool({
    name: "run_skill",
    description:
      "Load a saved skill's instructions so you can follow them for this request. Call it, then carry out the returned instructions with your other tools.",
    inputSchema: z.object({
      name: z.string().min(1),
      input: z.string().max(2000).optional().describe("what the user asked, in their words"),
    }),
    topics: ["settings"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const skill = await findSkillByName(ctx.db, ctx.user.id, input.name);
      if (!skill) return { error: `no skill named "${input.name}"` };
      if (!skill.enabled) return { error: `skill "${skill.name}" is disabled` };
      return {
        skill: skill.name,
        instructions: skill.instructions,
        allowedTools: skill.tools,
        userInput: input.input ?? null,
        note: "Follow these instructions now, using only the tools listed (or any tool if '*').",
      };
    },
  }),

  defineTool({
    name: "toggle_skill",
    description: "Enable or disable a saved skill.",
    inputSchema: z.object({ name: z.string().min(1), enabled: z.boolean() }),
    topics: ["settings"],
    permissionLevel: "write",
    confirmLabel: (i) => `${i.enabled ? "Enable" : "Disable"} skill "${i.name}"`,
    execute: async (input, ctx) => {
      const skill = await findSkillByName(ctx.db, ctx.user.id, input.name);
      if (!skill || skill.user_id !== ctx.user.id) return { error: `no editable skill "${input.name}"` };
      await updateSkill(ctx.db, ctx.user.id, skill.id, { enabled: input.enabled });
      return { ok: true, name: skill.name, enabled: input.enabled };
    },
  }),

  defineTool({
    name: "delete_skill",
    description: "Delete a saved skill permanently.",
    inputSchema: z.object({ name: z.string().min(1) }),
    topics: ["settings"],
    permissionLevel: "destructive",
    irreversible: true,
    confirmLabel: (i) => `Delete skill "${i.name}"`,
    execute: async (input, ctx) => {
      const skill = await findSkillByName(ctx.db, ctx.user.id, input.name);
      if (!skill || skill.user_id !== ctx.user.id) return { error: `no editable skill "${input.name}"` };
      const ok = await deleteSkill(ctx.db, ctx.user.id, skill.id);
      return ok ? { deleted: true, name: skill.name } : { error: "not found" };
    },
  }),

  defineTool({
    name: "set_personalization",
    description:
      "Update the user's personalization layer — durable instructions about how you should behave with them (tone, defaults, habits). Replaces the previous version; the base rules always still apply.",
    inputSchema: z.object({
      instructions: z.string().min(5).max(2000),
      description: z.string().max(200).optional(),
    }),
    topics: ["settings", "memory"],
    permissionLevel: "write",
    requiresConfirmation: true,
    confirmLabel: (i) => `Update how I behave: ${truncate(i.instructions, 80)}`,
    execute: async (input, ctx) => {
      const row = await setSystemPrompt(
        ctx.db,
        ctx.user.id,
        input.instructions,
        "assistant",
        input.description
      );
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "personalization.set",
        entity_kind: "setting",
        entity_id: row.id,
      });
      return { saved: true, version: row.version };
    },
  }),

  defineTool({
    name: "add_mcp_server",
    description:
      "Register an MCP server so its tools become available in future turns (e.g. GitHub, Notion). Reconnects on the next message.",
    inputSchema: z.object({
      name: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/, "lowercase slug"),
      url: z.string().url(),
      authHeader: z
        .string()
        .max(500)
        .optional()
        .describe("full Authorization header value, e.g. 'Bearer xxx'"),
    }),
    topics: ["settings"],
    permissionLevel: "external",
    requiresConfirmation: true,
    confirmLabel: (i) => `Connect MCP server "${i.name}" (${truncate(i.url, 50)})`,
    execute: async (input, ctx) => {
      const row = await upsertMcpServer(ctx.db, {
        user_id: ctx.user.id,
        name: input.name,
        url: input.url,
        auth_header: input.authHeader ?? null,
        enabled: true,
      });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "mcp.add",
        details: { name: row.name, url: row.url },
      });
      return {
        added: true,
        name: row.name,
        note: "Its tools become available from your next message.",
      };
    },
  }),

  defineTool({
    name: "list_mcp_servers",
    description: "List registered MCP servers and their connection health.",
    inputSchema: z.object({}),
    topics: ["settings"],
    permissionLevel: "read",
    execute: async (_input, ctx) => {
      const rows = await listMcpServers(ctx.db, ctx.user.id, false);
      return {
        servers: rows.map((s) => ({
          name: s.name,
          url: s.url,
          enabled: s.enabled,
          lastConnectedAt: s.last_connected_at,
          lastError: s.last_error,
          authenticated: !!s.auth_header,
        })),
      };
    },
  }),

  defineTool({
    name: "remove_mcp_server",
    description: "Unregister an MCP server.",
    inputSchema: z.object({ name: z.string().min(1) }),
    topics: ["settings"],
    permissionLevel: "destructive",
    confirmLabel: (i) => `Disconnect MCP server "${i.name}"`,
    execute: async (input, ctx) => {
      const ok = await deleteMcpServer(ctx.db, ctx.user.id, input.name);
      return ok ? { removed: true, name: input.name } : { error: `no server named "${input.name}"` };
    },
  }),
];
