import { z } from "zod";
import { defineTool } from "../registry";
import {
  createMemory,
  deleteUserFact,
  forgetMemory,
  getMemory,
  listMemories,
  listUserFacts,
  matchMemories,
  setMemoryEmbedding,
  touchMemories,
  upsertUserFact,
} from "../../database/repos/memories";
import { insertAudit } from "../../database/repos/audit";
import { embedText } from "../../services/llm/embeddings";
import { normalizeTags, truncate } from "../../utils/text";
import { Constants } from "../../database/types";
import { resolveProjectRef } from "./util";

const memoryType = z.enum(Constants.public.Enums.memory_type);

/** Callers apply the similarity floor; matching openmemo's tuning. */
const SIMILARITY_FLOOR = 0.3;

export const memoryTools = [
  defineTool({
    name: "remember",
    description:
      "Save a durable memory the user explicitly asked you to keep, or a decision/preference clearly worth remembering across conversations. Do NOT save routine chat.",
    inputSchema: z.object({
      content: z.string().min(3).max(1000).describe("the fact, stated plainly and self-contained"),
      memoryType: memoryType.optional().describe("default: fact"),
      importance: z.number().int().min(1).max(5).optional().describe("default 3; 5 = never forget"),
      project: z.string().optional(),
      tags: z.array(z.string()).max(5).optional(),
    }),
    topics: ["memory"],
    permissionLevel: "write",
    isCreate: true,
    confirmLabel: (i) => `Remember: ${truncate(i.content, 80)}`,
    execute: async (input, ctx) => {
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (notFound) return { error: `no project matching "${notFound}"` };
      const row = await createMemory(ctx.db, {
        user_id: ctx.user.id,
        content: input.content,
        memory_type: input.memoryType ?? "fact",
        importance: input.importance ?? 3,
        project_id: project?.id ?? null,
        tags: normalizeTags(input.tags ?? []),
      });
      ctx.waitUntil(
        embedText(input.content, ctx.config.embeddings, ctx.env)
          .then((vec) => (vec ? setMemoryEmbedding(ctx.db, ctx.user.id, row.id, vec) : undefined))
          .catch(() => {})
      );
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "memory.create",
        entity_kind: "memory",
        entity_id: row.id,
      });
      return { remembered: true, memoryId: row.id, type: row.memory_type };
    },
  }),

  defineTool({
    name: "recall_memories",
    description:
      "Search long-term memory semantically. Use for 'what do you remember about X' and before answering questions that depend on past decisions or preferences.",
    inputSchema: z.object({
      query: z.string().min(1).max(300),
      project: z.string().optional(),
      types: z.array(memoryType).optional(),
      limit: z.number().int().min(1).max(15).optional(),
    }),
    topics: ["memory"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const { project } = await resolveProjectRef(ctx, input.project);
      const embedding = await embedText(input.query, ctx.config.embeddings, ctx.env);
      if (embedding) {
        const hits = await matchMemories(ctx.db, ctx.user.id, embedding, {
          projectId: project?.id,
          limit: input.limit ?? 8,
        });
        const relevant = hits.filter((h) => h.similarity >= SIMILARITY_FLOOR);
        if (relevant.length > 0) {
          ctx.waitUntil(touchMemories(ctx.db, relevant.map((h) => h.id)).catch(() => {}));
          return {
            memories: relevant.map((h) => ({
              id: h.id,
              content: h.content,
              type: h.memory_type,
              importance: h.importance,
              tags: h.tags,
              similarity: Number(h.similarity.toFixed(3)),
            })),
          };
        }
      }
      // Fallback to keyword when embeddings are unavailable or nothing cleared the floor.
      const rows = await listMemories(ctx.db, ctx.user.id, {
        query: input.query,
        types: input.types,
        projectId: project?.id,
        limit: input.limit ?? 8,
      });
      return {
        memories: rows.map((m) => ({
          id: m.id,
          content: m.content,
          type: m.memory_type,
          importance: m.importance,
          tags: m.tags,
        })),
        note: embedding ? "no strong semantic match; keyword results" : "semantic search unavailable",
      };
    },
  }),

  defineTool({
    name: "list_memories",
    description: "List stored memories, newest and most important first (optionally by type or project).",
    inputSchema: z.object({
      types: z.array(memoryType).optional(),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    topics: ["memory"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const { project } = await resolveProjectRef(ctx, input.project);
      const rows = await listMemories(ctx.db, ctx.user.id, {
        types: input.types,
        projectId: project?.id,
        limit: input.limit,
      });
      return {
        memories: rows.map((m) => ({
          id: m.id,
          content: truncate(m.content, 200),
          type: m.memory_type,
          importance: m.importance,
        })),
      };
    },
  }),

  defineTool({
    name: "forget_memory",
    description:
      "Delete a stored memory. ONLY when the user explicitly asks to forget something — find the id with recall_memories first.",
    inputSchema: z.object({ memoryId: z.string().uuid() }),
    topics: ["memory"],
    permissionLevel: "destructive",
    confirmLabel: () => "Forget this memory",
    execute: async (input, ctx) => {
      const memory = await getMemory(ctx.db, ctx.user.id, input.memoryId);
      if (!memory) return { error: "memory not found" };
      const ok = await forgetMemory(ctx.db, ctx.user.id, input.memoryId);
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "memory.forget",
        entity_kind: "memory",
        entity_id: input.memoryId,
        status: ok ? "ok" : "noop",
      });
      return ok ? { forgotten: true, content: truncate(memory.content, 100) } : { error: "already gone" };
    },
  }),

  defineTool({
    name: "remember_about_user",
    description:
      "Store a short, stable fact about the user under a key (e.g. wake_time, role, preferred_stack). These are shown to you every turn — reuse them instead of asking again.",
    inputSchema: z.object({
      key: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, "lowercase snake_case"),
      value: z.string().min(1).max(300),
      category: z.enum(["general", "personal", "work", "health", "learning", "preferences"]).optional(),
    }),
    topics: ["memory"],
    permissionLevel: "write",
    execute: async (input, ctx) => {
      const row = await upsertUserFact(
        ctx.db,
        ctx.user.id,
        input.key,
        input.value,
        input.category ?? "general"
      );
      return { saved: true, key: row.key, value: row.value };
    },
  }),

  defineTool({
    name: "forget_about_user",
    description: "Remove a stored fact about the user by key. Only on explicit request.",
    inputSchema: z.object({ key: z.string().min(1).max(60) }),
    topics: ["memory"],
    permissionLevel: "destructive",
    confirmLabel: (i) => `Forget "${i.key}"`,
    execute: async (input, ctx) => {
      const ok = await deleteUserFact(ctx.db, ctx.user.id, input.key);
      return ok ? { forgotten: true, key: input.key } : { error: `no fact stored under "${input.key}"` };
    },
  }),

  defineTool({
    name: "list_user_facts",
    description: "List every stored fact about the user (the same set shown in your live context).",
    inputSchema: z.object({}),
    topics: ["memory"],
    permissionLevel: "read",
    execute: async (_input, ctx) => {
      const rows = await listUserFacts(ctx.db, ctx.user.id);
      return { facts: rows.map((f) => ({ key: f.key, value: f.value, category: f.category })) };
    },
  }),
];
