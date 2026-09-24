import { z } from "zod";
import { defineTool } from "../registry";
import {
  fileTagNames,
  getFileById,
  searchFiles,
  searchFilesByTag,
  tagFile,
  updateFile,
} from "../../database/repos/files";
import { insertAudit } from "../../database/repos/audit";
import { formatFileSize, normalizeTags, truncate } from "../../utils/text";
import { formatDateTime } from "../../i18n";
import { resolveProjectRef } from "./util";
import type { AgentContext } from "../../agent/context";
import type { FileRow } from "../../database/types";

function fileBrief(ctx: AgentContext, f: FileRow) {
  return {
    id: f.id,
    name: f.file_name,
    kind: f.media_kind,
    mime: f.mime_type,
    size: f.file_size ? formatFileSize(f.file_size) : null,
    caption: f.caption ? truncate(f.caption, 100) : null,
    receivedAt: formatDateTime(f.created_at, ctx.user.timezone, ctx.locale),
    hasText: f.extraction_status === "done",
  };
}

export const fileTools = [
  defineTool({
    name: "find_files",
    description:
      "Search stored files by name/caption/extracted text, tag, project, kind (document/photo/video/audio), or date range. Use for 'find the PDF I sent about X'.",
    inputSchema: z.object({
      query: z.string().optional(),
      tag: z.string().optional(),
      project: z.string().optional(),
      kind: z.enum(["document", "photo", "video", "animation", "audio", "voice", "video_note", "sticker"]).optional(),
      afterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      beforeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    topics: ["files", "search"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      if (input.tag) {
        const rows = await searchFilesByTag(ctx.db, ctx.user.id, input.tag, input.limit ?? 10);
        return { files: rows.map((f) => fileBrief(ctx, f)) };
      }
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (notFound) return { error: `no project matching "${notFound}"` };
      const rows = await searchFiles(ctx.db, ctx.user.id, {
        query: input.query,
        projectId: project?.id,
        mediaKind: input.kind,
        after: input.afterDate ? `${input.afterDate}T00:00:00Z` : undefined,
        before: input.beforeDate ? `${input.beforeDate}T23:59:59Z` : undefined,
        limit: input.limit,
      });
      return { files: rows.map((f) => fileBrief(ctx, f)) };
    },
  }),

  defineTool({
    name: "send_file",
    description: "Send a stored file back to the user in the chat (find its id with find_files first).",
    inputSchema: z.object({ fileId: z.string().uuid() }),
    topics: ["files"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const file = await getFileById(ctx.db, ctx.user.id, input.fileId);
      if (!file) return { error: "file not found" };
      if (!ctx.out.sendMediaByRef) return { error: "this channel cannot deliver files" };
      const ref: Record<string, string | number> = {};
      if (file.vault_chat_id && file.vault_message_id) {
        ref["vault_chat_id"] = file.vault_chat_id;
        ref["vault_message_id"] = file.vault_message_id;
      }
      if (file.tg_file_id) ref["file_id"] = file.tg_file_id;
      if (Object.keys(ref).length === 0) return { error: "file has no deliverable reference" };
      await ctx.out.sendMediaByRef(ctx.chatRef, ref, { caption: file.file_name });
      return { sent: true, name: file.file_name };
    },
  }),

  defineTool({
    name: "get_file_text",
    description:
      "Get the extracted text of a stored document/PDF/image for summarizing or answering questions about it.",
    inputSchema: z.object({
      fileId: z.string().uuid(),
      maxChars: z.number().int().min(500).max(12000).optional(),
    }),
    topics: ["files"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const file = await getFileById(ctx.db, ctx.user.id, input.fileId);
      if (!file) return { error: "file not found" };
      if (file.extraction_status === "pending") {
        return { status: "pending", note: "extraction is still running — try again shortly" };
      }
      if (file.extraction_status !== "done" || !file.extracted_text) {
        return {
          status: file.extraction_status,
          note: "no text available (unsupported format or file over the 20MB extraction cap)",
        };
      }
      return {
        name: file.file_name,
        text: truncate(file.extracted_text, input.maxChars ?? 8000),
        totalChars: file.extracted_text.length,
      };
    },
  }),

  defineTool({
    name: "tag_file",
    description: "Add tags to a stored file.",
    inputSchema: z.object({ fileId: z.string().uuid(), tags: z.array(z.string()).min(1).max(10) }),
    topics: ["files"],
    permissionLevel: "write",
    confirmLabel: (i) => `Tag file with ${i.tags.join(", ")}`,
    execute: async (input, ctx) => {
      const file = await getFileById(ctx.db, ctx.user.id, input.fileId);
      if (!file) return { error: "file not found" };
      const tags = await tagFile(ctx.db, ctx.user.id, file.id, normalizeTags(input.tags));
      return { tagged: true, tags };
    },
  }),

  defineTool({
    name: "assign_file_to_project",
    description: "Attach a stored file to a project.",
    inputSchema: z.object({ fileId: z.string().uuid(), project: z.string().min(1) }),
    topics: ["files"],
    permissionLevel: "write",
    confirmLabel: (i) => `Attach file to "${i.project}"`,
    execute: async (input, ctx) => {
      const file = await getFileById(ctx.db, ctx.user.id, input.fileId);
      if (!file) return { error: "file not found" };
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (!project) return { error: `no project matching "${notFound ?? input.project}"` };
      await updateFile(ctx.db, ctx.user.id, file.id, { project_id: project.id });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "file.assign_project",
        entity_kind: "file",
        entity_id: file.id,
      });
      return { assigned: true, name: file.file_name, project: project.name };
    },
  }),

  defineTool({
    name: "file_details",
    description: "Get one file's metadata (project, tags, extraction status).",
    inputSchema: z.object({ fileId: z.string().uuid() }),
    topics: ["files"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const file = await getFileById(ctx.db, ctx.user.id, input.fileId);
      if (!file) return { error: "file not found" };
      const tags = await fileTagNames(ctx.db, file.id).catch(() => []);
      return { ...fileBrief(ctx, file), tags, projectId: file.project_id, extraction: file.extraction_status };
    },
  }),

  defineTool({
    name: "delete_file",
    description:
      "Remove a file from the assistant's index (metadata soft-delete; the vault copy in the private channel is kept).",
    inputSchema: z.object({ fileId: z.string().uuid() }),
    topics: ["files"],
    permissionLevel: "destructive",
    confirmLabel: () => "Remove file from index",
    execute: async (input, ctx) => {
      const file = await getFileById(ctx.db, ctx.user.id, input.fileId);
      if (!file) return { error: "file not found" };
      await updateFile(ctx.db, ctx.user.id, file.id, { deleted_at: new Date().toISOString() });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "file.delete",
        entity_kind: "file",
        entity_id: file.id,
      });
      return { deleted: true, name: file.file_name };
    },
  }),
];
