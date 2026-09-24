import { z } from "zod";
import { defineTool } from "../registry";
import {
  createTask,
  deleteTask,
  findTaskByTitle,
  getTask,
  listTasks,
  updateTask,
} from "../../database/repos/tasks";
import { insertAudit } from "../../database/repos/audit";
import { normalizeTags } from "../../utils/text";
import { Constants, type TaskRow } from "../../database/types";
import { parseUserDateTime, resolveProjectRef } from "./util";
import { formatDateTime } from "../../i18n";
import type { AgentContext } from "../../agent/context";

const taskStatus = z.enum(Constants.public.Enums.task_status);
const priority = z.enum(Constants.public.Enums.priority_level);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveTaskRef(ctx: AgentContext, ref: string): Promise<TaskRow | null> {
  if (UUID_RE.test(ref.trim())) {
    const byId = await getTask(ctx.db, ctx.user.id, ref.trim());
    if (byId) return byId;
  }
  return findTaskByTitle(ctx.db, ctx.user.id, ref);
}

export const taskTools = [
  defineTool({
    name: "create_task",
    description:
      "Create a task/to-do. Optionally attach to a project by name and set a due time (user's LOCAL time, YYYY-MM-DDTHH:mm).",
    inputSchema: z.object({
      title: z.string().min(1).max(300),
      description: z.string().max(2000).optional(),
      project: z.string().optional().describe("project name/slug/id to attach to"),
      priority: priority.optional().describe("default: medium"),
      dueAt: z
        .string()
        .optional()
        .describe("due datetime in the user's LOCAL time, format YYYY-MM-DDTHH:mm (call current_time first for relative times)"),
      tags: z.array(z.string()).max(10).optional(),
      parentTaskId: z.string().uuid().optional(),
    }),
    topics: ["tasks"],
    permissionLevel: "write",
    isCreate: true,
    confirmLabel: (i) => `Create task "${i.title}"`,
    execute: async (input, ctx) => {
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (notFound) return { error: `no project matching "${notFound}" — create it first or omit it` };
      let dueIso: string | null = null;
      if (input.dueAt) {
        const parsed = parseUserDateTime(input.dueAt, ctx.user.timezone);
        if ("error" in parsed) return { error: parsed.error };
        dueIso = parsed.date.toISOString();
      }
      const row = await createTask(ctx.db, {
        user_id: ctx.user.id,
        title: input.title,
        description: input.description ?? null,
        project_id: project?.id ?? null,
        priority: input.priority ?? "medium",
        due_at: dueIso,
        tags: normalizeTags(input.tags ?? []),
        parent_task_id: input.parentTaskId ?? null,
        source: "chat",
      });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "task.create",
        entity_kind: "task",
        entity_id: row.id,
      });
      return {
        created: true,
        taskId: row.id,
        title: row.title,
        project: project?.name ?? null,
        dueAtLocal: dueIso ? formatDateTime(dueIso, ctx.user.timezone, ctx.locale) : null,
      };
    },
  }),

  defineTool({
    name: "list_tasks",
    description:
      "List tasks with filters. Use for 'what are my tasks', 'what's overdue', 'tasks for project X'. Default: open tasks sorted by due date then priority.",
    inputSchema: z.object({
      statuses: z.array(taskStatus).optional().describe("default: all open statuses"),
      project: z.string().optional(),
      overdueOnly: z.boolean().optional(),
      dueBefore: z.string().optional().describe("user-local YYYY-MM-DDTHH:mm"),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    topics: ["tasks"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const { project, notFound } = await resolveProjectRef(ctx, input.project);
      if (notFound) return { error: `no project matching "${notFound}"` };
      let dueBefore: string | undefined;
      if (input.dueBefore) {
        const parsed = parseUserDateTime(input.dueBefore, ctx.user.timezone);
        if ("error" in parsed) return { error: parsed.error };
        dueBefore = parsed.date.toISOString();
      }
      const rows = await listTasks(ctx.db, ctx.user.id, {
        statuses: input.statuses,
        projectId: project?.id,
        overdueOnly: input.overdueOnly,
        dueBefore,
        tag: input.tag,
        limit: input.limit,
      });
      return {
        tasks: rows.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          priority: r.priority,
          dueAtLocal: r.due_at ? formatDateTime(r.due_at, ctx.user.timezone, ctx.locale) : null,
          overdue: !!r.due_at && r.status !== "done" && new Date(r.due_at) < ctx.now,
          tags: r.tags,
        })),
      };
    },
  }),

  defineTool({
    name: "complete_task",
    description: "Mark a task done. Accepts the task id or a title fragment.",
    inputSchema: z.object({ task: z.string().min(1).describe("task id or title fragment") }),
    topics: ["tasks"],
    permissionLevel: "write",
    confirmLabel: (i) => `Complete task "${i.task}"`,
    execute: async (input, ctx) => {
      const task = await resolveTaskRef(ctx, input.task);
      if (!task) return { error: `no open task matching "${input.task}"` };
      await updateTask(ctx.db, ctx.user.id, task.id, { status: "done" });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "task.complete",
        entity_kind: "task",
        entity_id: task.id,
      });
      return { completed: true, title: task.title };
    },
  }),

  defineTool({
    name: "update_task",
    description: "Update a task's fields (status, priority, due time, title, description, tags).",
    inputSchema: z.object({
      task: z.string().min(1).describe("task id or title fragment"),
      title: z.string().min(1).max(300).optional(),
      description: z.string().max(2000).optional(),
      status: taskStatus.optional(),
      priority: priority.optional(),
      dueAt: z.string().nullable().optional().describe("user-local YYYY-MM-DDTHH:mm, or null to clear"),
      tags: z.array(z.string()).max(10).optional(),
    }),
    topics: ["tasks"],
    permissionLevel: "write",
    confirmLabel: (i) => `Update task "${i.task}"`,
    execute: async (input, ctx) => {
      const task = await resolveTaskRef(ctx, input.task);
      if (!task) return { error: `no task matching "${input.task}"` };
      let dueIso: string | null | undefined = undefined;
      if (input.dueAt === null) dueIso = null;
      else if (typeof input.dueAt === "string") {
        const parsed = parseUserDateTime(input.dueAt, ctx.user.timezone);
        if ("error" in parsed) return { error: parsed.error };
        dueIso = parsed.date.toISOString();
      }
      await updateTask(ctx.db, ctx.user.id, task.id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(dueIso !== undefined ? { due_at: dueIso } : {}),
        ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
      });
      return { updated: true, taskId: task.id, title: input.title ?? task.title };
    },
  }),

  defineTool({
    name: "delete_task",
    description: "Permanently delete a task (cannot be undone). Prefer update_task status=cancelled for soft removal.",
    inputSchema: z.object({ task: z.string().min(1).describe("task id or title fragment") }),
    topics: ["tasks"],
    permissionLevel: "destructive",
    irreversible: true,
    confirmLabel: (i) => `Permanently delete task "${i.task}"`,
    execute: async (input, ctx) => {
      const task = await resolveTaskRef(ctx, input.task);
      if (!task) return { error: `no task matching "${input.task}"` };
      const ok = await deleteTask(ctx.db, ctx.user.id, task.id);
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "task.delete",
        entity_kind: "task",
        entity_id: task.id,
        status: ok ? "ok" : "noop",
      });
      return ok ? { deleted: true, title: task.title } : { error: "task not found" };
    },
  }),
];
