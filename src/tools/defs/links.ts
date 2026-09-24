import { z } from "zod";
import { defineTool } from "../registry";
import { deleteLink, findLinkByUrl, listLinks } from "../../database/repos/links";
import { fetchUrlMetadata } from "../../services/url/metadata";
import { truncate } from "../../utils/text";
import { ingestUrl } from "../../workflows/ingest-url";
import { resolveProjectRef } from "./util";

export const linkTools = [
  defineTool({
    name: "save_link",
    description:
      "Fetch a URL, summarize it, and save it as a bookmark (optionally under a project). Use when the user sends a link to keep or asks to save/summarize a page.",
    inputSchema: z.object({
      url: z.string().url(),
      project: z.string().optional(),
      tags: z.array(z.string()).max(5).optional(),
      note: z.string().max(500).optional().describe("the user's own comment about the link"),
    }),
    topics: ["files", "notes", "search"],
    permissionLevel: "external",
    isCreate: true,
    timeoutMs: 30_000,
    confirmLabel: (i) => `Fetch and save ${truncate(i.url, 60)}`,
    execute: async (input, ctx) => {
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (notFound) return { error: `no project matching "${notFound}"` };
      const row = await ingestUrl(ctx, input.url, {
        projectId: project?.id ?? null,
        note: input.note,
        tags: input.tags,
      });
      if (!row) return { error: "could not fetch or save that URL" };
      return {
        saved: true,
        linkId: row.id,
        title: row.title,
        summary: row.summary ? truncate(row.summary, 600) : null,
        tags: row.tags,
        project: project?.name ?? null,
      };
    },
  }),

  defineTool({
    name: "read_url",
    description:
      "Fetch a web page and return its readable text WITHOUT saving it. Use to answer a question about a link or to compare pages.",
    inputSchema: z.object({
      url: z.string().url(),
      maxChars: z.number().int().min(500).max(12000).optional(),
    }),
    topics: ["search", "notes"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    confirmLabel: (i) => `Fetch ${truncate(i.url, 60)}`,
    execute: async (input, ctx) => {
      const meta = await fetchUrlMetadata(input.url, { maxChars: input.maxChars ?? 8000 });
      if (!meta) return { error: "could not fetch that URL" };
      void ctx;
      return {
        url: meta.finalUrl,
        title: meta.title,
        siteName: meta.siteName,
        text: meta.text,
      };
    },
  }),

  defineTool({
    name: "list_links",
    description: "List or search saved bookmarks.",
    inputSchema: z.object({
      query: z.string().optional(),
      project: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    topics: ["search", "notes"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (notFound) return { error: `no project matching "${notFound}"` };
      const rows = await listLinks(ctx.db, ctx.user.id, {
        query: input.query,
        projectId: project?.id,
        tag: input.tag,
        limit: input.limit,
      });
      return {
        links: rows.map((l) => ({
          id: l.id,
          url: l.url,
          title: l.title,
          summary: l.summary ? truncate(l.summary, 200) : null,
          tags: l.tags,
        })),
      };
    },
  }),

  defineTool({
    name: "delete_link",
    description: "Remove a saved bookmark.",
    inputSchema: z.object({ linkId: z.string().uuid() }),
    topics: ["search", "notes"],
    permissionLevel: "destructive",
    confirmLabel: () => "Delete bookmark",
    execute: async (input, ctx) => {
      const ok = await deleteLink(ctx.db, ctx.user.id, input.linkId);
      return ok ? { deleted: true } : { error: "bookmark not found" };
    },
  }),

  defineTool({
    name: "lookup_saved_link",
    description: "Check whether a URL is already bookmarked (before re-fetching it).",
    inputSchema: z.object({ url: z.string().url() }),
    topics: ["search", "notes"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const row = await findLinkByUrl(ctx.db, ctx.user.id, input.url);
      if (!row || row.deleted_at) return { found: false };
      return {
        found: true,
        linkId: row.id,
        title: row.title,
        summary: row.summary ? truncate(row.summary, 400) : null,
        tags: row.tags,
      };
    },
  }),
];
