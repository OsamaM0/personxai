/**
 * Entity detail cards for chat: one message per selected item with its facts
 * and a row of inline actions (Done / Snooze / Pin / Send / Move / Delete …),
 * plus ◀ Back to the list page it came from. Deterministic — no model calls.
 *
 * Destructive actions are two-step inside the card (Delete → Confirm delete),
 * which mirrors the autonomy gate without spending a confirmation token.
 */
import type { AgentContext } from "./context";
import { registerCallbackKind } from "./callback-registry";
import { createCallbackToken, encodeCallbackData } from "./confirmations";
import { editList, md, setDetailOpener, type DetailKind, type ListState } from "./lists";
import type { OutboundButton } from "../channels/types";
import { insertAudit } from "../database/repos/audit";
import { deleteTask, getTask, updateTask } from "../database/repos/tasks";
import { findProject, projectSummary, updateProject } from "../database/repos/projects";
import { deleteNote, getNote, updateNote } from "../database/repos/notes";
import { getFileById, updateFile } from "../database/repos/files";
import { deleteLink, getLink } from "../database/repos/links";
import { forgetMemory, getMemory } from "../database/repos/memories";
import { getReminder, updateReminder } from "../database/repos/reminders";
import { getInboxItem } from "../database/repos/inbox";
import { deleteWalletEntry, getWalletEntry } from "../database/repos/wallet";
import { deleteVaultChannel, listVaultChannels, setDefaultVault } from "../database/repos/vaults";
import { channelLink, moveVaultMessage, syncVaultChannel, vaultLink } from "../services/storage/vault";
import { applyInboxAction } from "../tools/defs/inbox";
import { formatDate, formatDateTime, t } from "../i18n";
import { formatFileSize, truncate } from "../utils/text";
import { formatMoney, formatQuantity } from "../utils/money";
import type { Enums, VaultChannelRow } from "../database/types";

interface DetailPayload {
  k: DetailKind;
  id: string;
  back: ListState | null;
  /** Vault channels offered on a file card (index → chat id). */
  ch?: { id: string; title: string }[];
  /** Two-step delete armed. */
  arm?: boolean;
}

const DETAIL_TTL_MS = 24 * 3600 * 1000;

const KIND_ICON: Record<string, string> = {
  document: "📄", photo: "🖼", video: "🎬", animation: "🎞", audio: "🎵", voice: "🎤", video_note: "📹", sticker: "🏷",
};
const PRIORITY_ICON: Record<string, string> = { critical: "🔴", high: "🟠", medium: "▫️", low: "▪️" };

interface Card {
  text: string;
  actions: OutboundButton[][];
  /** Entity disappeared — go back to the list instead of re-rendering. */
  gone?: boolean;
}

const line = (label: string, value: string | null | undefined) => (value ? `${label}: ${value}` : null);
const tagLine = (ctx: AgentContext, tags: string[]) =>
  line(t(ctx.locale, "lbl_tags"), tags.length > 0 ? tags.map((x) => "#" + md(x)).join(" ") : null);

async function projectLabel(ctx: AgentContext, projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const p = await findProject(ctx.db, ctx.user.id, projectId).catch(() => null);
  return p ? md(p.name) : null;
}

/** Build the card for an entity. `notice` is an outcome line shown at the top. */
async function buildCard(
  ctx: AgentContext,
  payload: DetailPayload,
  cb: (verb: string) => string,
  notice?: string
): Promise<Card> {
  const L = (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => t(ctx.locale, key, params);
  const tz = ctx.user.timezone;
  const top = notice ? [notice, ""] : [];
  const back: OutboundButton[] = payload.back ? [{ label: L("btn_back"), data: cb("back") }] : [];
  const del = (verb: string) =>
    payload.arm
      ? { label: L("btn_confirm_delete"), data: cb(verb + "c") }
      : { label: L("btn_delete"), data: cb(verb) };

  switch (payload.k) {
    case "task": {
      const task = await getTask(ctx.db, ctx.user.id, payload.id);
      if (!task) return { text: L("detail_not_found"), actions: [back], gone: true };
      const text = [
        ...top,
        `${PRIORITY_ICON[task.priority] ?? "▫️"} *${md(task.title)}*`,
        task.description ? md(truncate(task.description, 600)) : null,
        line(L("lbl_status"), task.status),
        line(L("lbl_priority"), task.priority),
        line(L("lbl_project"), await projectLabel(ctx, task.project_id)),
        line(L("lbl_due"), task.due_at ? formatDateTime(task.due_at, tz, ctx.locale) : null),
        line(L("lbl_repeats"), task.recurrence_rule),
        tagLine(ctx, task.tags),
        line(L("lbl_created"), formatDate(task.created_at, tz, ctx.locale)),
      ].filter((x): x is string => !!x).join("\n");
      const row1: OutboundButton[] =
        task.status === "done"
          ? [{ label: L("btn_reopen"), data: cb("reopen") }]
          : [
              { label: L("btn_done"), data: cb("done") },
              { label: L("btn_snooze"), data: cb("snooze") },
            ];
      return { text, actions: [row1, [del("del"), ...back]] };
    }
    case "project": {
      const project = await findProject(ctx.db, ctx.user.id, payload.id);
      if (!project) return { text: L("detail_not_found"), actions: [back], gone: true };
      const summary = await projectSummary(ctx.db, ctx.user.id, project);
      const text = [
        ...top,
        `📁 *${md(project.name)}*`,
        project.description ? md(truncate(project.description, 600)) : null,
        line(L("lbl_status"), `${project.status} · ${project.priority} · ${project.progress}%`),
        line(L("lbl_due"), project.due_date),
        line(L("lbl_open_done"), `${summary.openTasks} / ${summary.doneTasks} · 📝 ${summary.notes}`),
        tagLine(ctx, project.tags),
      ].filter((x): x is string => !!x).join("\n");
      return {
        text,
        actions: [
          [
            { label: L("btn_project_tasks"), data: cb("tasks") },
            { label: L("btn_project_notes"), data: cb("notes") },
            { label: L("btn_project_files"), data: cb("files") },
          ],
          [project.status === "archived" ? { label: L("btn_reopen"), data: cb("unarchive") } : { label: L("btn_archive"), data: cb("archive") }, ...back],
        ],
      };
    }
    case "note": {
      const note = await getNote(ctx.db, ctx.user.id, payload.id);
      if (!note) return { text: L("detail_not_found"), actions: [back], gone: true };
      const text = [
        ...top,
        `${note.pinned ? "📌" : "📝"} *${md(note.title ?? truncate(note.content, 60))}*`,
        md(truncate(note.content, 1500)),
        line(L("lbl_project"), await projectLabel(ctx, note.project_id)),
        tagLine(ctx, note.tags),
        line(L("lbl_updated"), formatDateTime(note.updated_at, tz, ctx.locale)),
      ].filter((x): x is string => !!x).join("\n");
      return {
        text,
        actions: [[{ label: note.pinned ? L("btn_unpin") : L("btn_pin"), data: cb("pin") }, del("del"), ...back]],
      };
    }
    case "file": {
      const file = await getFileById(ctx.db, ctx.user.id, payload.id);
      if (!file) return { text: L("detail_not_found"), actions: [back], gone: true };
      const vaults = await listVaultChannels(ctx.db, ctx.user.id, true).catch(() => [] as VaultChannelRow[]);
      const here = vaults.find((v) => v.chat_id === file.vault_chat_id);
      const others = vaults.filter((v) => v.chat_id !== file.vault_chat_id).slice(0, 3);
      payload.ch = others.map((v) => ({ id: v.chat_id, title: v.title ?? v.category ?? v.chat_id }));
      const link = vaultLink(file.vault_chat_id, file.vault_message_id);
      const text = [
        ...top,
        `${KIND_ICON[file.media_kind ?? "document"] ?? "📄"} *${md(file.file_name)}*`,
        file.caption ? md(truncate(file.caption, 300)) : null,
        line(L("lbl_kind"), `${file.media_kind ?? "file"}${file.file_size ? ` · ${formatFileSize(file.file_size)}` : ""}`),
        line(L("lbl_project"), await projectLabel(ctx, file.project_id)),
        line(L("lbl_channel"), here ? md(here.title ?? here.chat_id) : null),
        tagLine(ctx, file.tags),
        line(L("lbl_text"), file.extraction_status === "done" ? "✅" : file.extraction_status),
        file.summary ? line(L("lbl_summary"), md(truncate(file.summary, 400))) : null,
        line(L("lbl_created"), formatDateTime(file.created_at, tz, ctx.locale)),
        link ? `[${L("btn_open_vault")}](${link})` : null,
      ].filter((x): x is string => !!x).join("\n");
      const row1: OutboundButton[] = [{ label: L("btn_send_file"), data: cb("send") }];
      if (link) row1.push({ label: L("btn_open_vault"), url: link });
      const moves: OutboundButton[] = others.map((v, i) => ({ label: L("btn_move_to", { channel: truncate(v.title ?? v.category ?? "?", 16) }), data: cb(`mv${i}`) }));
      const actions: OutboundButton[][] = [row1];
      if (moves.length > 0) actions.push(moves);
      actions.push([del("del"), ...back]);
      return { text, actions };
    }
    case "link": {
      const item = await getLink(ctx.db, ctx.user.id, payload.id);
      if (!item) return { text: L("detail_not_found"), actions: [back], gone: true };
      const text = [
        ...top,
        `🔗 *${md(item.title ?? item.url)}*`,
        item.summary ? md(truncate(item.summary, 800)) : null,
        item.url,
        line(L("lbl_project"), await projectLabel(ctx, item.project_id)),
        tagLine(ctx, item.tags),
        line(L("lbl_created"), formatDate(item.created_at, tz, ctx.locale)),
      ].filter((x): x is string => !!x).join("\n");
      return { text, actions: [[{ label: L("btn_open_link"), url: item.url }, del("del"), ...back]] };
    }
    case "memory": {
      const m = await getMemory(ctx.db, ctx.user.id, payload.id);
      if (!m) return { text: L("detail_not_found"), actions: [back], gone: true };
      const text = [
        ...top,
        `🧠 *${m.memory_type}* · ${"★".repeat(m.importance ?? 0)}`,
        md(m.content),
        tagLine(ctx, m.tags),
        line(L("lbl_created"), formatDate(m.created_at, tz, ctx.locale)),
      ].filter((x): x is string => !!x).join("\n");
      return { text, actions: [[payload.arm ? { label: L("btn_confirm_delete"), data: cb("forgetc") } : { label: L("btn_forget"), data: cb("forget") }, ...back]] };
    }
    case "reminder": {
      const r = await getReminder(ctx.db, ctx.user.id, payload.id);
      if (!r) return { text: L("detail_not_found"), actions: [back], gone: true };
      const text = [
        ...top,
        `⏰ *${md(r.content ?? r.raw_text ?? r.template_id ?? "?")}*`,
        line(L("lbl_status"), r.status),
        line(L("lbl_next"), r.next_trigger_at ? formatDateTime(r.next_trigger_at, tz, ctx.locale) : null),
        line(L("lbl_repeats"), r.recurrence_rule),
      ].filter((x): x is string => !!x).join("\n");
      const live = r.status === "scheduled" || r.status === "active" || r.status === "paused";
      const row: OutboundButton[] = [];
      if (live) {
        row.push(r.status === "paused" ? { label: L("btn_resume"), data: cb("resume") } : { label: L("btn_pause"), data: cb("pause") });
        row.push(payload.arm ? { label: L("btn_confirm_delete"), data: cb("cancelc") } : { label: L("btn_cancel_reminder"), data: cb("cancel") });
      }
      return { text, actions: [[...row, ...back]] };
    }
    case "inbox": {
      const item = await getInboxItem(ctx.db, ctx.user.id, payload.id);
      if (!item || item.status !== "pending") return { text: L("detail_not_found"), actions: [back], gone: true };
      const text = [
        ...top,
        `📥 *${L("inbox_title")}*`,
        md(truncate(item.raw_content ?? `[${item.source}]`, 1200)),
        item.suggested_kind ? line(L("lbl_suggested"), item.suggested_kind) : null,
        line(L("lbl_created"), formatDateTime(item.created_at, tz, ctx.locale)),
      ].filter((x): x is string => !!x).join("\n");
      return {
        text,
        actions: [
          [
            { label: L("btn_make_task"), data: cb("task") },
            { label: L("btn_make_note"), data: cb("note") },
            { label: L("btn_dismiss"), data: cb("dismiss") },
          ],
          back,
        ].filter((r) => r.length > 0),
      };
    }
    case "vault": {
      const rows = await listVaultChannels(ctx.db, ctx.user.id);
      const v = rows.find((x) => x.id === payload.id);
      if (!v) return { text: L("detail_not_found"), actions: [back], gone: true };
      const link = channelLink(v.chat_id);
      const text = [
        ...top,
        `${v.is_default ? "⭐" : "📁"} *${md(v.title ?? v.chat_id)}*`,
        line(L("lbl_category"), v.category ? md(v.category) : null),
        tagLine(ctx, v.tags),
        v.description ? md(truncate(v.description, 400)) : null,
        line(L("lbl_channel"), `\`${v.chat_id}\``),
        line(L("lbl_status"), v.enabled ? (v.is_default ? L("vault_is_default") : "enabled") : "disabled"),
        "",
        L("vault_description_hint"),
      ].filter((x): x is string => !!x).join("\n");
      const row1: OutboundButton[] = [];
      if (link) row1.push({ label: L("btn_open_channel"), url: link });
      row1.push({ label: L("btn_sync"), data: cb("sync") });
      if (!v.is_default) row1.push({ label: L("btn_set_default"), data: cb("default") });
      const row2: OutboundButton[] = [];
      if (!v.is_default) row2.push(payload.arm ? { label: L("btn_confirm_delete"), data: cb("removec") } : { label: L("btn_remove"), data: cb("remove") });
      row2.push(...back);
      return { text, actions: [row1, row2].filter((r) => r.length > 0) };
    }
    case "wallet": {
      const e = await getWalletEntry(ctx.db, ctx.user.id, payload.id);
      if (!e) return { text: L("detail_not_found"), actions: [back], gone: true };
      const icon = e.direction === "out" ? "🔻" : "🔺";
      const text = [
        ...top,
        `${icon} *${md(formatMoney(e.amount, e.currency))}* — ${md(e.description)}`,
        line(L("lbl_direction"), L(e.direction === "out" ? "wallet_direction_out" : "wallet_direction_in")),
        line(L("lbl_category"), e.category ? md(e.category) : null),
        line(L("lbl_quantity"), formatQuantity(e.quantity, e.unit) || null),
        line(L("lbl_method"), e.method ? md(e.method) : null),
        line(L("lbl_when"), formatDateTime(e.occurred_at, tz, ctx.locale)),
        line(L("lbl_project"), await projectLabel(ctx, e.project_id)),
        tagLine(ctx, e.tags),
        line(L("lbl_note"), e.note ? md(truncate(e.note, 400)) : null),
      ].filter((x): x is string => !!x).join("\n");
      return { text, actions: [[del("del"), ...back]] };
    }
    default:
      return { text: L("detail_not_found"), actions: [back], gone: true };
  }
}

async function render(ctx: AgentContext, payload: DetailPayload, messageId: string | undefined, notice?: string): Promise<void> {
  const token = createCallbackToken<DetailPayload>(ctx.do, "ent", payload, ctx.now.getTime(), DETAIL_TTL_MS);
  const cb = (verb: string) => encodeCallbackData("ent", token, verb);
  const card = await buildCard(ctx, payload, cb, notice);
  // A card that references a deleted entity still gets rendered once (with the notice) so
  // the user sees the outcome; the only remaining button is Back.
  if (messageId) {
    try {
      await ctx.out.editText(ctx.chatRef, messageId, card.text, { buttons: card.actions, disablePreview: true });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.out.sendButtons(ctx.chatRef, card.text, card.actions, { disablePreview: true });
}

/** Open (or re-render) a detail card. Public entry for lists and commands. */
export async function showDetail(
  ctx: AgentContext,
  kind: DetailKind,
  id: string,
  back: ListState | null,
  messageId?: string
): Promise<void> {
  await render(ctx, { k: kind, id, back }, messageId);
}

setDetailOpener((ctx, kind, id, back, messageId) => showDetail(ctx, kind, id, back, messageId));

async function audit(ctx: AgentContext, action: string, kind: Enums<"entity_kind">, id: string): Promise<void> {
  await insertAudit(ctx.db, { user_id: ctx.user.id, actor: "user", action, entity_kind: kind, entity_id: id }).catch(() => {});
}

registerCallbackKind("ent", async (ctx, raw, verb, messageId) => {
  const payload = raw as DetailPayload;
  const L = (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => t(ctx.locale, key, params);
  const next: DetailPayload = { ...payload, arm: false };
  const backToList = async () => {
    if (payload.back) await editList(ctx, messageId, payload.back);
    else await render(ctx, next, messageId);
  };

  if (verb === "back") {
    await backToList();
    return;
  }
  // Two-step destructive actions: first press arms, second press executes.
  if (["del", "forget", "cancel", "remove"].includes(verb)) {
    await render(ctx, { ...payload, arm: true }, messageId, L("detail_confirm_hint"));
    return;
  }

  let notice: string | undefined;
  let gone = false;
  switch (payload.k) {
    case "task": {
      if (verb === "done") {
        await updateTask(ctx.db, ctx.user.id, payload.id, { status: "done" });
        await audit(ctx, "task.complete", "task", payload.id);
        notice = L("detail_done");
      } else if (verb === "reopen") {
        await updateTask(ctx.db, ctx.user.id, payload.id, { status: "todo", completed_at: null });
        notice = L("detail_reopened");
      } else if (verb === "snooze") {
        const task = await getTask(ctx.db, ctx.user.id, payload.id);
        const base = task?.due_at ? new Date(task.due_at) : ctx.now;
        const when = new Date(Math.max(base.getTime(), ctx.now.getTime()) + 24 * 3600 * 1000);
        await updateTask(ctx.db, ctx.user.id, payload.id, { due_at: when.toISOString() });
        await audit(ctx, "task.snooze", "task", payload.id);
        notice = L("detail_snoozed", { when: formatDateTime(when, ctx.user.timezone, ctx.locale) });
      } else if (verb === "delc") {
        await deleteTask(ctx.db, ctx.user.id, payload.id);
        await audit(ctx, "task.delete", "task", payload.id);
        notice = L("detail_deleted");
        gone = true;
      }
      break;
    }
    case "project": {
      if (verb === "tasks" || verb === "notes" || verb === "files") {
        await editList(ctx, messageId, { k: verb, p: 0, pr: payload.id });
        return;
      }
      if (verb === "archive") {
        await updateProject(ctx.db, ctx.user.id, payload.id, { status: "archived" });
        await audit(ctx, "project.archive", "project", payload.id);
        notice = L("detail_archived");
      } else if (verb === "unarchive") {
        await updateProject(ctx.db, ctx.user.id, payload.id, { status: "active" });
        notice = L("detail_reopened");
      }
      break;
    }
    case "note": {
      if (verb === "pin") {
        const note = await getNote(ctx.db, ctx.user.id, payload.id);
        if (note) {
          await updateNote(ctx.db, ctx.user.id, payload.id, { pinned: !note.pinned });
          notice = note.pinned ? L("detail_unpinned") : L("detail_pinned");
        }
      } else if (verb === "delc") {
        await deleteNote(ctx.db, ctx.user.id, payload.id);
        await audit(ctx, "note.delete", "note", payload.id);
        notice = L("detail_deleted");
        gone = true;
      }
      break;
    }
    case "file": {
      const file = await getFileById(ctx.db, ctx.user.id, payload.id);
      if (!file) break;
      if (verb === "send") {
        if (ctx.out.sendMediaByRef) {
          const ref: Record<string, string | number> = {};
          if (file.vault_chat_id && file.vault_message_id !== null) {
            ref["vault_chat_id"] = file.vault_chat_id;
            ref["vault_message_id"] = file.vault_message_id;
          }
          if (file.tg_file_id) ref["file_id"] = file.tg_file_id;
          await ctx.out.sendMediaByRef(ctx.chatRef, ref, { caption: file.file_name }).catch(() => {});
        }
        notice = L("detail_sent");
      } else if (verb.startsWith("mv")) {
        const target = payload.ch?.[Number.parseInt(verb.slice(2), 10)];
        if (target) {
          const moved = await moveVaultMessage(ctx.env, file, target.id);
          if (moved) {
            await updateFile(ctx.db, ctx.user.id, file.id, { vault_chat_id: moved.vaultChatId, vault_message_id: moved.vaultMessageId });
            await audit(ctx, "file.move_channel", "file", file.id);
            notice = L("detail_moved", { channel: target.title });
          } else {
            notice = L("error_generic");
          }
        }
      } else if (verb === "delc") {
        await updateFile(ctx.db, ctx.user.id, file.id, { deleted_at: new Date().toISOString() });
        await audit(ctx, "file.delete", "file", file.id);
        notice = L("file_ignored");
        gone = true;
      }
      break;
    }
    case "link": {
      if (verb === "delc") {
        await deleteLink(ctx.db, ctx.user.id, payload.id);
        await audit(ctx, "link.delete", "link", payload.id);
        notice = L("detail_deleted");
        gone = true;
      }
      break;
    }
    case "memory": {
      if (verb === "forgetc") {
        await forgetMemory(ctx.db, ctx.user.id, payload.id);
        await audit(ctx, "memory.forget", "memory", payload.id);
        notice = L("detail_forgotten");
        gone = true;
      }
      break;
    }
    case "reminder": {
      if (verb === "pause") {
        await updateReminder(ctx.db, ctx.user.id, payload.id, { status: "paused" });
        notice = L("detail_paused");
      } else if (verb === "resume") {
        await updateReminder(ctx.db, ctx.user.id, payload.id, { status: "scheduled" });
        notice = L("detail_resumed");
      } else if (verb === "cancelc") {
        await updateReminder(ctx.db, ctx.user.id, payload.id, { status: "cancelled", next_trigger_at: null });
        await audit(ctx, "reminder.cancel", "reminder", payload.id);
        notice = L("detail_cancelled");
        gone = true;
      }
      break;
    }
    case "inbox": {
      const item = await getInboxItem(ctx.db, ctx.user.id, payload.id);
      if (item && item.status === "pending" && (verb === "task" || verb === "note" || verb === "dismiss")) {
        const title = truncate(item.raw_content ?? "", 120);
        notice = await applyInboxAction(ctx, item, verb, title, item.suggested_project_id ?? null);
        await audit(ctx, `inbox.${verb}`, "inbox_item", payload.id);
        gone = true;
      }
      break;
    }
    case "wallet": {
      if (verb === "delc") {
        const ok = await deleteWalletEntry(ctx.db, ctx.user.id, payload.id);
        await insertAudit(ctx.db, {
          user_id: ctx.user.id,
          actor: "user",
          action: "wallet.delete",
          entity_id: payload.id,
          status: ok ? "ok" : "noop",
        }).catch(() => {});
        notice = ok ? L("detail_deleted") : L("detail_not_found");
        gone = ok;
      }
      break;
    }
    case "vault": {
      const rows = await listVaultChannels(ctx.db, ctx.user.id);
      const v = rows.find((x) => x.id === payload.id);
      if (!v) break;
      if (verb === "sync") {
        const synced = await syncVaultChannel(ctx.env, ctx.db, v);
        notice = L("vault_synced", { title: synced.title ?? synced.chat_id, category: synced.category ?? "—", tags: synced.tags.map((x) => "#" + x).join(" ") || "—" });
      } else if (verb === "default") {
        await setDefaultVault(ctx.db, ctx.user.id, v.id);
        notice = L("vault_default_set", { title: v.title ?? v.chat_id });
      } else if (verb === "removec") {
        const ok = await deleteVaultChannel(ctx.db, ctx.user.id, v.id);
        notice = ok ? L("vault_removed", { title: v.title ?? v.chat_id }) : L("error_generic");
        gone = ok;
      }
      break;
    }
  }

  if (gone) {
    if (payload.back) {
      // Show the outcome on the refreshed list rather than a dead card.
      await editList(ctx, messageId, payload.back);
      if (notice) await ctx.out.sendText(ctx.chatRef, notice);
      return;
    }
    await ctx.out.editText(ctx.chatRef, messageId ?? "", notice ?? L("confirm_executed"), { removeButtons: true }).catch(async () => {
      await ctx.out.sendText(ctx.chatRef, notice ?? L("confirm_executed"));
    });
    return;
  }
  await render(ctx, next, messageId, notice);
});
