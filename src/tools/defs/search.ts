import { z } from "zod";
import { defineTool } from "../registry";
import { hybridSearch, matchFileChunks } from "../../database/repos/search";
import { embedText } from "../../services/llm/embeddings";
import { truncate } from "../../utils/text";
import { Constants } from "../../database/types";
import { resolveProjectRef } from "./util";

const entityKind = z.enum(Constants.public.Enums.entity_kind);

export const searchTools = [
  defineTool({
    name: "search_all",
    description:
      "Unified search across projects, tasks, notes, files, links, and memories — keyword and semantic combined. Use for broad 'find everything about X' questions.",
    inputSchema: z.object({
      query: z.string().min(1).max(300),
      kinds: z.array(entityKind).optional().describe("restrict to these entity kinds"),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    topics: ["search"],
    permissionLevel: "read",
    timeoutMs: 25_000,
    execute: async (input, ctx) => {
      const embedding = await embedText(input.query, ctx.config.embeddings, ctx.env);
      const hits = await hybridSearch(ctx.db, ctx.user.id, input.query, {
        embedding,
        kinds: input.kinds,
        limit: input.limit ?? 15,
      });
      if (hits.length === 0) {
        return { results: [], note: "nothing matched — say so plainly rather than guessing" };
      }
      const grouped: Record<string, { id: string; title: string; snippet: string }[]> = {};
      for (const hit of hits) {
        const bucket = (grouped[hit.kind] ??= []);
        bucket.push({ id: hit.id, title: hit.title, snippet: truncate(hit.snippet ?? "", 160) });
      }
      return { results: grouped, semantic: !!embedding };
    },
  }),

  defineTool({
    name: "search_documents",
    description:
      "Semantic search INSIDE stored documents (PDF/doc text). Use to answer content questions across files without naming one.",
    inputSchema: z.object({
      query: z.string().min(1).max(300),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    topics: ["files", "search"],
    permissionLevel: "read",
    timeoutMs: 25_000,
    execute: async (input, ctx) => {
      const embedding = await embedText(input.query, ctx.config.embeddings, ctx.env);
      if (!embedding) return { error: "semantic search is unavailable right now" };
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (notFound) return { error: `no project matching "${notFound}"` };
      const hits = await matchFileChunks(ctx.db, ctx.user.id, embedding, {
        projectId: project?.id,
        limit: input.limit ?? 6,
      });
      const relevant = hits.filter((h) => h.similarity >= 0.3);
      return {
        passages: relevant.map((h) => ({
          fileId: h.file_id,
          fileName: h.file_name,
          chunk: h.chunk_index,
          text: truncate(h.content, 800),
          similarity: Number(h.similarity.toFixed(3)),
        })),
      };
    },
  }),
];
