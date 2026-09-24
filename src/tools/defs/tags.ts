import { z } from "zod";
import { defineTool } from "../registry";
import { searchByTags, setEntityTags, tagCounts, TAGGABLE_KINDS } from "../../database/repos/tags";
import { tagFile, getFileById, updateFile } from "../../database/repos/files";
import { findVault, listVaultChannels } from "../../database/repos/vaults";
import { connectVaultChannel, ensureDefaultVault, moveVaultMessage } from "../../services/storage/vault";
import { insertAudit } from "../../database/repos/audit";
import { normalizeTags, truncate } from "../../utils/text";

const taggable = z.enum(TAGGABLE_KINDS as [string, ...string[]]);

export const tagTools = [
  defineTool({
    name: "list_tags",
    description:
      "List the user's tags with how many tasks/projects/notes/files/links/memories carry each. Call before tagging something so you reuse existing tags instead of inventing near-duplicates.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    topics: ["tasks", "projects", "notes", "files", "search", "memory", "inbox"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const facets = await tagCounts(ctx.db, ctx.user.id);
      return { tags: facets.slice(0, input.limit ?? 40).map((f) => ({ name: f.name, total: f.total, ...f.counts })) };
    },
  }),

  defineTool({
    name: "find_by_tag",
    description:
      "Everything carrying ALL the given tags, across tasks, projects, notes, files, links and memories. Fast (indexed) — prefer it over search_all when the user names a tag or hashtag.",
    inputSchema: z.object({
      tags: z.array(z.string()).min(1).max(5),
      kinds: z.array(taggable).optional().describe("restrict to these kinds"),
    }),
    topics: ["search", "tasks", "notes", "files", "projects"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const hits = await searchByTags(ctx.db, ctx.user.id, normalizeTags(input.tags), {
        kinds: input.kinds as never,
        limitPerKind: 15,
      });
      return { results: hits.map((h) => ({ kind: h.kind, id: h.id, title: h.title, snippet: h.snippet ? truncate(h.snippet, 120) : null, tags: h.tags })) };
    },
  }),

  defineTool({
    name: "set_tags",
    description:
      "Add tags to (or replace the tags of) a task, project, note, file, link or memory. Tags are short lowercase words; reuse existing ones from list_tags when they fit.",
    inputSchema: z.object({
      kind: taggable,
      id: z.string().uuid(),
      tags: z.array(z.string()).min(0).max(10),
      mode: z.enum(["add", "replace"]).optional().describe("default: add"),
    }),
    topics: ["tasks", "projects", "notes", "files", "memory", "search"],
    permissionLevel: "write",
    confirmLabel: (i) => `Tag ${i.kind} with ${i.tags.join(", ") || "(clear)"}`,
    execute: async (input, ctx) => {
      const tags = normalizeTags(input.tags);
      const mode = input.mode ?? "add";
      if (input.kind === "file") {
        const file = await getFileById(ctx.db, ctx.user.id, input.id);
        if (!file) return { error: "file not found" };
        const finalTags = await tagFile(ctx.db, ctx.user.id, file.id, tags, mode);
        return { ok: true, kind: "file", tags: finalTags };
      }
      const finalTags = await setEntityTags(ctx.db, ctx.user.id, input.kind as never, input.id, tags, mode);
      if (!finalTags) return { error: `${input.kind} not found` };
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: `${input.kind}.tags`,
        entity_kind: input.kind as never,
        entity_id: input.id,
        details: { tags: finalTags },
      });
      return { ok: true, kind: input.kind, tags: finalTags };
    },
  }),

  defineTool({
    name: "list_vault_channels",
    description:
      "The private Telegram channels files can be stored in, each with a category and tags. Use to decide (or ask) where a file belongs, and before move_file_to_channel.",
    inputSchema: z.object({}),
    topics: ["files"],
    permissionLevel: "read",
    execute: async (_input, ctx) => {
      const rows = await ensureDefaultVault(ctx.env, ctx.db, ctx.user.id);
      return {
        channels: rows.map((v) => ({
          id: v.id,
          title: v.title,
          category: v.category,
          tags: v.tags,
          isDefault: v.is_default,
          enabled: v.enabled,
        })),
      };
    },
  }),

  defineTool({
    name: "move_file_to_channel",
    description:
      "Re-file a stored file into another vault channel (by channel title, category, or id). Use when the user says a file belongs somewhere else.",
    inputSchema: z.object({ fileId: z.string().uuid(), channel: z.string().min(1) }),
    topics: ["files"],
    permissionLevel: "write",
    confirmLabel: (i) => `Move file to "${i.channel}"`,
    execute: async (input, ctx) => {
      const file = await getFileById(ctx.db, ctx.user.id, input.fileId);
      if (!file) return { error: "file not found" };
      const target = await findVault(ctx.db, ctx.user.id, input.channel);
      if (!target || !target.enabled) return { error: `no vault channel matching "${input.channel}"` };
      if (target.chat_id === file.vault_chat_id) return { ok: true, note: "already in that channel" };
      const moved = await moveVaultMessage(ctx.env, file, target.chat_id);
      if (!moved) return { error: "could not copy the file into that channel (is the bot an admin there?)" };
      await updateFile(ctx.db, ctx.user.id, file.id, {
        vault_chat_id: moved.vaultChatId,
        vault_message_id: moved.vaultMessageId,
      });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "file.move_channel",
        entity_kind: "file",
        entity_id: file.id,
        details: { to: target.title ?? target.chat_id },
      });
      return { moved: true, name: file.file_name, channel: target.title ?? target.category ?? target.chat_id };
    },
  }),

  defineTool({
    name: "connect_vault_channel",
    description:
      "Connect a private Telegram channel (the bot must already be its admin) as a vault channel with a category and tags. Users usually do this by forwarding a post from the channel; use this tool only when they give the channel id (-100…).",
    inputSchema: z.object({
      chatId: z.string().regex(/^-100\d+$/),
      category: z.string().max(60).optional(),
      tags: z.array(z.string()).max(10).optional(),
    }),
    topics: ["files", "settings"],
    permissionLevel: "external",
    confirmLabel: (i) => `Connect channel ${i.chatId} as a vault${i.category ? ` (${i.category})` : ""}`,
    execute: async (input, ctx) => {
      const result = await connectVaultChannel(ctx.env, ctx.db, ctx.user.id, input.chatId, {
        category: input.category ?? null,
        tags: input.tags ?? [],
      });
      if ("error" in result) return { error: result.error };
      const all = await listVaultChannels(ctx.db, ctx.user.id);
      return { connected: true, title: result.row.title, category: result.row.category, tags: result.row.tags, totalChannels: all.length };
    },
  }),
];
