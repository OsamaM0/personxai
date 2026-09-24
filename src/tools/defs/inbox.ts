import { z } from "zod";
import { defineTool } from "../registry";
import {
  getInboxItem,
  listPendingInbox,
  resolveInboxItem,
  saveClassification,
} from "../../database/repos/inbox";
import { createTask } from "../../database/repos/tasks";
import { createNote } from "../../database/repos/notes";
import { findProject } from "../../database/repos/projects";
import { insertAudit } from "../../database/repos/audit";
import { classifyJson } from "../../services/llm/classify";
import { createCallbackToken, encodeCallbackData } from "../../agent/confirmations";
import { registerCallbackKind } from "../../agent/callback-registry";
import { t } from "../../i18n";
import { truncate } from "../../utils/text";
import type { AgentContext } from "../../agent/context";
import type { InboxItemRow } from "../../database/types";

const classificationSchema = z.object({
  kind: z.enum(["task", "note", "reminder", "link", "file", "memory", "dismiss"]),
  suggestedTitle: z.string().max(200),
  projectName: z.string().nullable(),
  tags: z.array(z.string()).max(5),
  confidence: z.number().min(0).max(1),
});
type Classification = z.infer<typeof classificationSchema>;

async function classifyItem(ctx: AgentContext, item: InboxItemRow): Promise<Classification | null> {
  const cached = item.classification as Classification | null;
  if (cached && typeof cached === "object" && "kind" in cached) return cached;
  const content = item.raw_content ?? (item.media ? "[file attachment]" : "");
  if (!content) return null;
  const result = await classifyJson({
    schema: classificationSchema,
    system:
      "Classify a captured inbox item for a personal productivity system. kind: task (actionable), note (information to keep), reminder (time-bound ping), link (URL bookmark), file (document to file), memory (fact about the user), dismiss (noise). Keep suggestedTitle short, in the item's own language.",
    prompt: `Item (source: ${item.source}):\n${truncate(content, 1500)}`,
    cfg: ctx.config.llm.classifier,
    env: ctx.env,
  });
  if (result) {
    let projectId: string | null = null;
    if (result.projectName) {
      const project = await findProject(ctx.db, ctx.user.id, result.projectName).catch(() => null);
      projectId = project?.id ?? null;
    }
    const kindMap: Record<Classification["kind"], "task" | "note" | "reminder" | "link" | "file" | "memory" | null> =
      { task: "task", note: "note", reminder: "reminder", link: "link", file: "file", memory: "memory", dismiss: null };
    await saveClassification(
      ctx.db,
      ctx.user.id,
      item.id,
      result,
      kindMap[result.kind],
      projectId
    ).catch(() => {});
  }
  return result;
}

interface InboxCallbackPayload {
  itemId: string;
  title: string;
  projectId: string | null;
}

export async function applyInboxAction(
  ctx: AgentContext,
  item: InboxItemRow,
  action: "task" | "note" | "dismiss",
  title: string,
  projectId: string | null
): Promise<string> {
  if (action === "dismiss") {
    await resolveInboxItem(ctx.db, ctx.user.id, item.id, { status: "dismissed" });
    return t(ctx.locale, "inbox_item_dismissed");
  }
  const content = item.raw_content ?? title;
  if (action === "task") {
    const task = await createTask(ctx.db, {
      user_id: ctx.user.id,
      title: title || truncate(content, 120),
      description: content !== title ? content : null,
      project_id: projectId,
      source: "inbox",
    });
    await resolveInboxItem(ctx.db, ctx.user.id, item.id, {
      status: "organized",
      resolvedKind: "task",
      resolvedEntityId: task.id,
    });
    return t(ctx.locale, "inbox_item_to_task", { title: task.title });
  }
  const note = await createNote(ctx.db, {
    user_id: ctx.user.id,
    title: title || null,
    content,
    project_id: projectId,
    source: "manual",
  });
  await resolveInboxItem(ctx.db, ctx.user.id, item.id, {
    status: "organized",
    resolvedKind: "note",
    resolvedEntityId: note.id,
  });
  return t(ctx.locale, "inbox_item_to_note", { title: note.title ?? truncate(content, 60) });
}

// Inline-button handler: verbs t (task), n (note), d (dismiss)
registerCallbackKind("inbox", async (ctx, payload, verb, messageId) => {
  const { itemId, title, projectId } = payload as InboxCallbackPayload;
  const item = await getInboxItem(ctx.db, ctx.user.id, itemId);
  if (!item || item.status !== "pending") {
    if (messageId) {
      await ctx.out
        .editText(ctx.chatRef, messageId, t(ctx.locale, "confirm_expired"), { removeButtons: true })
        .catch(() => {});
    }
    return;
  }
  const action = verb === "t" ? "task" : verb === "n" ? "note" : "dismiss";
  const outcome = await applyInboxAction(ctx, item, action, title, projectId);
  await insertAudit(ctx.db, {
    user_id: ctx.user.id,
    actor: "user",
    action: `inbox.${action}`,
    entity_kind: "inbox_item",
    entity_id: itemId,
  });
  if (messageId) {
    await ctx.out.editText(ctx.chatRef, messageId, outcome, { removeButtons: true }).catch(() => {});
  } else {
    await ctx.out.sendText(ctx.chatRef, outcome);
  }
});

export const inboxTools = [
  defineTool({
    name: "list_inbox",
    description: "List unprocessed inbox items (things the user sent that aren't organized yet).",
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).optional() }),
    topics: ["inbox"],
    permissionLevel: "read",
    execute: async (input, ctx) => {
      const rows = await listPendingInbox(ctx.db, ctx.user.id, input.limit ?? 10);
      return {
        items: rows.map((i) => ({
          id: i.id,
          source: i.source,
          preview: truncate(i.raw_content ?? "[attachment]", 150),
          suggestedKind: i.suggested_kind,
          createdAt: i.created_at,
        })),
      };
    },
  }),

  defineTool({
    name: "organize_inbox",
    description:
      "Classify pending inbox items and send the user one message per item with action buttons (Task / Note / Dismiss). Use when the user says 'organize my inbox'.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(5).optional() }),
    topics: ["inbox"],
    permissionLevel: "write",
    execute: async (input, ctx) => {
      const items = await listPendingInbox(ctx.db, ctx.user.id, input.limit ?? 5);
      if (items.length === 0) return { message: "inbox is empty" };
      let sent = 0;
      for (const item of items) {
        const cls = await classifyItem(ctx, item);
        const title = cls?.suggestedTitle ?? truncate(item.raw_content ?? "item", 60);
        const projectId = item.suggested_project_id;
        const token = createCallbackToken<InboxCallbackPayload>(
          ctx.do,
          "inbox",
          { itemId: item.id, title, projectId },
          ctx.now.getTime()
        );
        const suggestion = cls
          ? t(ctx.locale, "inbox_suggestion", { kind: cls.kind, title })
          : truncate(item.raw_content ?? "[attachment]", 100);
        await ctx.out.sendButtons(ctx.chatRef, `📥 ${truncate(item.raw_content ?? "[attachment]", 150)}\n→ ${suggestion}`, [
          [
            { label: t(ctx.locale, "btn_make_task"), data: encodeCallbackData("inbox", token, "t") },
            { label: t(ctx.locale, "btn_make_note"), data: encodeCallbackData("inbox", token, "n") },
            { label: t(ctx.locale, "btn_dismiss"), data: encodeCallbackData("inbox", token, "d") },
          ],
        ]);
        sent++;
      }
      return {
        sent,
        note: "Suggestion messages with buttons were sent. Tell the user to pick actions with the buttons; do not repeat the items.",
      };
    },
  }),

  defineTool({
    name: "resolve_inbox_item",
    description: "Directly organize one inbox item into a task or note (or dismiss it) without buttons.",
    inputSchema: z.object({
      itemId: z.string().uuid(),
      action: z.enum(["task", "note", "dismiss"]),
      title: z.string().max(200).optional(),
      project: z.string().optional(),
    }),
    topics: ["inbox"],
    permissionLevel: "write",
    confirmLabel: (i) => `Inbox item → ${i.action}`,
    execute: async (input, ctx) => {
      const item = await getInboxItem(ctx.db, ctx.user.id, input.itemId);
      if (!item) return { error: "inbox item not found" };
      if (item.status !== "pending") return { error: "item already organized" };
      let projectId: string | null = null;
      if (input.project) {
        const project = await findProject(ctx.db, ctx.user.id, input.project);
        if (!project) return { error: `no project matching "${input.project}"` };
        projectId = project.id;
      }
      const outcome = await applyInboxAction(
        ctx,
        item,
        input.action,
        input.title ?? truncate(item.raw_content ?? "item", 120),
        projectId
      );
      return { done: true, outcome };
    },
  }),
];
