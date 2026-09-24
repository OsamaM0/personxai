import { z } from "zod";
import { defineTool } from "../registry";
import { createNote, deleteNote, getNote, listNotes, updateNote } from "../../database/repos/notes";
import { insertAudit } from "../../database/repos/audit";
import { normalizeTags, truncate } from "../../utils/text";
import { embedText } from "../../services/llm/embeddings";
import { setNoteEmbeddingSafe } from "./notes-embedding";
import { resolveProjectRef } from "./util";

export const noteTools = [
  defineTool({
    name: "create_note",
    description: "Save a note (plain text or markdown). Optionally attach to a project and tag it.",
    inputSchema: z.object({
      content: z.string().min(1).max(20000),
      title: z.string().max(300).optional(),
      project: z.string().optional().describe("project name/slug/id"),
      tags: z.array(z.string()).max(10).optional(),
      pinned: z.boolean().optional(),
    }),
    topics: ["notes"],
    permissionLevel: "write",
    isCreate: true,
    confirmLabel: (i) => `Save note "${truncate(i.title ?? i.content, 60)}"`,
    execute: async (input, ctx) => {
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (notFound) return { error: `no project matching "${notFound}"` };
      const row = await createNote(ctx.db, {
        user_id: ctx.user.id,
        title: input.title ?? null,
        content: input.content,
        project_id: project?.id ?? null,
        tags: normalizeTags(input.tags ?? []),
        pinned: input.pinned ?? false,
        source: "manual",
      });
      ctx.waitUntil(
        embedText(`${input.title ?? ""}\n${input.content}`.trim(), ctx.config.embeddings, ctx.env).then(
          (vec) => (vec ? setNoteEmbeddingSafe(ctx, row.id, vec) : undefined)
        )
      );
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "note.create",
        entity_kind: "note",
        entity_id: row.id,
      });
      return { created: true, noteId: row.id, title: row.title, project: project?.name ?? null };
    },
  }),

  defineTool({
    name: "list_notes",
    description: "List/search notes by text, tag, or project. Returns previews — use get_note for the full content.",
    inputSchema: z.object({
      query: z.string().optional().describe("text to match in title/content"),
      project: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    topics: ["notes"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (notFound) return { error: `no project matching "${notFound}"` };
      const rows = await listNotes(ctx.db, ctx.user.id, {
        query: input.query,
        projectId: project?.id,
        tag: input.tag,
        limit: input.limit,
      });
      return {
        notes: rows.map((n) => ({
          id: n.id,
          title: n.title,
          preview: truncate(n.content, 200),
          tags: n.tags,
          pinned: n.pinned,
        })),
      };
    },
  }),

  defineTool({
    name: "get_note",
    description: "Get one note's full content by id.",
    inputSchema: z.object({ noteId: z.string().uuid() }),
    topics: ["notes"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const note = await getNote(ctx.db, ctx.user.id, input.noteId);
      if (!note) return { error: "note not found" };
      return { id: note.id, title: note.title, content: note.content, tags: note.tags };
    },
  }),

  defineTool({
    name: "update_note",
    description: "Update a note's content, title, tags, or pin state.",
    inputSchema: z.object({
      noteId: z.string().uuid(),
      title: z.string().max(300).nullable().optional(),
      content: z.string().min(1).max(20000).optional(),
      tags: z.array(z.string()).max(10).optional(),
      pinned: z.boolean().optional(),
    }),
    topics: ["notes"],
    permissionLevel: "write",
    confirmLabel: () => "Update note",
    execute: async (input, ctx) => {
      const note = await getNote(ctx.db, ctx.user.id, input.noteId);
      if (!note) return { error: "note not found" };
      await updateNote(ctx.db, ctx.user.id, note.id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      });
      if (input.content !== undefined && input.content !== note.content) {
        ctx.waitUntil(
          embedText(input.content, ctx.config.embeddings, ctx.env).then((vec) =>
            vec ? setNoteEmbeddingSafe(ctx, note.id, vec) : undefined
          )
        );
      }
      return { updated: true, noteId: note.id };
    },
  }),

  defineTool({
    name: "delete_note",
    description: "Delete a note (soft delete — recoverable by an admin, treated as gone in the UI).",
    inputSchema: z.object({ noteId: z.string().uuid() }),
    topics: ["notes"],
    permissionLevel: "destructive",
    confirmLabel: () => "Delete note",
    execute: async (input, ctx) => {
      const ok = await deleteNote(ctx.db, ctx.user.id, input.noteId);
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "note.delete",
        entity_kind: "note",
        entity_id: input.noteId,
        status: ok ? "ok" : "noop",
      });
      return ok ? { deleted: true } : { error: "note not found" };
    },
  }),
];
