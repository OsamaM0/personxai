import { z } from "zod";
import { defineTool } from "../registry";
import {
  createProject,
  findProject,
  listProjects,
  projectSummary,
  slugify,
  updateProject,
} from "../../database/repos/projects";
import { insertAudit } from "../../database/repos/audit";
import { normalizeTags } from "../../utils/text";
import { Constants } from "../../database/types";

const projectStatus = z.enum(Constants.public.Enums.project_status);
const priority = z.enum(Constants.public.Enums.priority_level);

export const projectTools = [
  defineTool({
    name: "create_project",
    description: "Create a new project. Use when the user wants to start/track a new project or area of work.",
    inputSchema: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      status: projectStatus.optional().describe("default: active"),
      priority: priority.optional().describe("default: medium"),
      category: z.string().max(100).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
      tags: z.array(z.string()).max(10).optional(),
    }),
    topics: ["projects"],
    permissionLevel: "write",
    isCreate: true,
    confirmLabel: (i) => `Create project "${i.name}"`,
    execute: async (input, ctx) => {
      const existing = await findProject(ctx.db, ctx.user.id, input.name);
      if (existing && existing.name.toLowerCase() === input.name.toLowerCase()) {
        return { error: `project "${existing.name}" already exists`, projectId: existing.id };
      }
      const row = await createProject(ctx.db, {
        user_id: ctx.user.id,
        name: input.name,
        slug: slugify(input.name),
        description: input.description ?? null,
        status: input.status ?? "active",
        priority: input.priority ?? "medium",
        category: input.category ?? null,
        due_date: input.dueDate ?? null,
        tags: normalizeTags(input.tags ?? []),
      });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "project.create",
        entity_kind: "project",
        entity_id: row.id,
      });
      return { created: true, projectId: row.id, name: row.name, status: row.status };
    },
  }),

  defineTool({
    name: "list_projects",
    description: "List the user's projects (optionally filtered by status). Use for 'what am I working on', 'show my projects'.",
    inputSchema: z.object({
      statuses: z.array(projectStatus).optional().describe("default: everything except archived"),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    topics: ["projects"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const rows = await listProjects(ctx.db, ctx.user.id, {
        statuses: input.statuses,
        limit: input.limit,
      });
      return {
        projects: rows.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          priority: p.priority,
          progress: p.progress,
          dueDate: p.due_date,
          tags: p.tags,
        })),
      };
    },
  }),

  defineTool({
    name: "get_project",
    description: "Get one project's details plus task/note counts. Accepts a name, slug, or id.",
    inputSchema: z.object({ project: z.string().min(1) }),
    topics: ["projects"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const project = await findProject(ctx.db, ctx.user.id, input.project);
      if (!project) return { error: `no project matching "${input.project}"` };
      const summary = await projectSummary(ctx.db, ctx.user.id, project);
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        priority: project.priority,
        category: project.category,
        startDate: project.start_date,
        dueDate: project.due_date,
        progress: project.progress,
        tags: project.tags,
        openTasks: summary.openTasks,
        doneTasks: summary.doneTasks,
        notes: summary.notes,
      };
    },
  }),

  defineTool({
    name: "update_project",
    description:
      "Update a project's fields (status, priority, description, progress, due date, tags, category). Use for 'mark X completed', 'set priority high'.",
    inputSchema: z.object({
      project: z.string().min(1).describe("name, slug, or id"),
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      status: projectStatus.optional(),
      priority: priority.optional(),
      category: z.string().max(100).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      progress: z.number().int().min(0).max(100).optional(),
      tags: z.array(z.string()).max(10).optional(),
    }),
    topics: ["projects"],
    permissionLevel: "write",
    confirmLabel: (i) => `Update project "${i.project}"`,
    execute: async (input, ctx) => {
      const project = await findProject(ctx.db, ctx.user.id, input.project);
      if (!project) return { error: `no project matching "${input.project}"` };
      await updateProject(ctx.db, ctx.user.id, project.id, {
        ...(input.name !== undefined ? { name: input.name, slug: slugify(input.name) } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.dueDate !== undefined ? { due_date: input.dueDate } : {}),
        ...(input.progress !== undefined ? { progress: input.progress } : {}),
        ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
      });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "project.update",
        entity_kind: "project",
        entity_id: project.id,
      });
      return { updated: true, projectId: project.id, name: input.name ?? project.name };
    },
  }),

  defineTool({
    name: "archive_project",
    description: "Archive a project (hides it from active lists; reversible via update_project status).",
    inputSchema: z.object({ project: z.string().min(1) }),
    topics: ["projects"],
    permissionLevel: "destructive",
    confirmLabel: (i) => `Archive project "${i.project}"`,
    execute: async (input, ctx) => {
      const project = await findProject(ctx.db, ctx.user.id, input.project);
      if (!project) return { error: `no project matching "${input.project}"` };
      await updateProject(ctx.db, ctx.user.id, project.id, { status: "archived" });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "project.archive",
        entity_kind: "project",
        entity_id: project.id,
      });
      return { archived: true, name: project.name };
    },
  }),
];
