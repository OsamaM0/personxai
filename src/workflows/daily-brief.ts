/**
 * Daily brief + heartbeat.
 *
 * Both start from a deterministic data pull. The heartbeat sends nothing (and
 * spends no tokens) when nothing needs attention — that rule is load-bearing for
 * the free-tier budget, so it is asserted by tests rather than left to prompting.
 */
import type { AgentContext } from "../agent/context";
import { listTasks } from "../database/repos/tasks";
import { listProjects } from "../database/repos/projects";
import { listReminders } from "../database/repos/reminders";
import { countPendingInbox } from "../database/repos/inbox";
import { generateText } from "ai";
import { chatModel } from "../services/llm/provider";
import { insertRun } from "../database/repos/runs";
import { formatDateTime, t } from "../i18n";
import { truncate } from "../utils/text";
import { formatError, log } from "../utils/logger";
import type { ProjectRow, ReminderRow, TaskRow } from "../database/types";

const NEWLINE = String.fromCharCode(10);

export interface AttentionSnapshot {
  overdue: TaskRow[];
  dueToday: TaskRow[];
  waiting: TaskRow[];
  upcomingReminders: ReminderRow[];
  staleProjects: ProjectRow[];
  inboxCount: number;
}

/** True when there is genuinely nothing worth pinging the user about. */
export function isQuiet(s: AttentionSnapshot): boolean {
  return (
    s.overdue.length === 0 &&
    s.dueToday.length === 0 &&
    s.waiting.length === 0 &&
    s.upcomingReminders.length === 0 &&
    s.staleProjects.length === 0 &&
    s.inboxCount === 0
  );
}

const STALE_PROJECT_DAYS = 14;

export async function collectAttention(ctx: AgentContext): Promise<AttentionSnapshot> {
  const now = ctx.now;
  const endOfDay = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  const [overdue, dueToday, waiting, reminders, projects, inboxCount] = await Promise.all([
    listTasks(ctx.db, ctx.user.id, { overdueOnly: true, limit: 10 }).catch(() => []),
    listTasks(ctx.db, ctx.user.id, {
      dueAfter: now.toISOString(),
      dueBefore: endOfDay,
      limit: 10,
    }).catch(() => []),
    listTasks(ctx.db, ctx.user.id, { statuses: ["waiting", "blocked"], limit: 10 }).catch(() => []),
    listReminders(ctx.db, ctx.user.id).catch(() => []),
    listProjects(ctx.db, ctx.user.id, { statuses: ["active"], limit: 20 }).catch(() => []),
    countPendingInbox(ctx.db, ctx.user.id).catch(() => 0),
  ]);

  const staleBefore = now.getTime() - STALE_PROJECT_DAYS * 24 * 3600 * 1000;
  const staleProjects = projects.filter((p) => new Date(p.updated_at).getTime() < staleBefore);
  const upcomingReminders = reminders.filter(
    (r) => r.next_trigger_at && new Date(r.next_trigger_at).getTime() <= new Date(endOfDay).getTime()
  );

  return { overdue, dueToday, waiting, upcomingReminders, staleProjects, inboxCount };
}

/** Deterministic rendering — no model involved. */
export function renderBrief(ctx: AgentContext, s: AttentionSnapshot): string {
  const line = (task: TaskRow) => {
    const due = task.due_at ? ` — ${formatDateTime(task.due_at, ctx.user.timezone, ctx.locale)}` : "";
    return `· ${task.title}${due}`;
  };
  const parts: string[] = [t(ctx.locale, "daily_brief_header")];
  if (s.overdue.length > 0) {
    parts.push("", t(ctx.locale, "today_overdue_header"), ...s.overdue.map(line));
  }
  if (s.dueToday.length > 0) {
    parts.push("", t(ctx.locale, "today_due_header"), ...s.dueToday.map(line));
  }
  if (s.waiting.length > 0) {
    parts.push("", t(ctx.locale, "brief_waiting_header"), ...s.waiting.map(line));
  }
  if (s.upcomingReminders.length > 0) {
    parts.push(
      "",
      t(ctx.locale, "brief_reminders_header"),
      ...s.upcomingReminders.map((r) => {
        const when = r.next_trigger_at
          ? formatDateTime(r.next_trigger_at, ctx.user.timezone, ctx.locale)
          : "";
        return `· ${r.content ?? r.raw_text ?? ""} — ${when}`;
      })
    );
  }
  if (s.staleProjects.length > 0) {
    parts.push(
      "",
      t(ctx.locale, "brief_stale_header"),
      ...s.staleProjects.map((p) => `· ${p.name}`)
    );
  }
  if (s.inboxCount > 0) {
    parts.push("", t(ctx.locale, "brief_inbox", { count: s.inboxCount }));
  }
  return parts.join(NEWLINE);
}

/** One cheap model call that adds a focus recommendation on top of real data. */
async function focusSuggestion(ctx: AgentContext, s: AttentionSnapshot): Promise<string | null> {
  const facts = [
    ...s.overdue.map((task) => `OVERDUE: ${task.title} (${task.priority})`),
    ...s.dueToday.map((task) => `DUE TODAY: ${task.title} (${task.priority})`),
    ...s.waiting.map((task) => `WAITING: ${task.title}`),
  ].slice(0, 15);
  if (facts.length === 0) return null;
  try {
    const result = await generateText({
      model: chatModel(ctx.config.llm.classifier, ctx.env),
      system:
        "You order a person's day. Given their real overdue/due/waiting items, recommend at most 3 things to focus on, as a short numbered list. Use ONLY the given items — never invent work. Reply in the language of the items. No preamble.",
      prompt: facts.join(NEWLINE),
      abortSignal: AbortSignal.timeout(25_000),
    });
    const text = result.text.trim();
    return text.length > 0 ? truncate(text, 800) : null;
  } catch (err) {
    log("warn", "brief_focus_failed", { error: formatError(err) });
    return null;
  }
}

export async function runDailyBrief(ctx: AgentContext): Promise<boolean> {
  const started = Date.now();
  const snapshot = await collectAttention(ctx);
  if (isQuiet(snapshot)) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "brief_all_clear"));
    return false;
  }
  const body = renderBrief(ctx, snapshot);
  const focus = await focusSuggestion(ctx, snapshot);
  const text = focus ? `${body}${NEWLINE}${NEWLINE}${t(ctx.locale, "brief_focus_header")}${NEWLINE}${focus}` : body;
  await ctx.out.sendText(ctx.chatRef, text);
  ctx.waitUntil(
    insertRun(ctx.db, {
      user_id: ctx.user.id,
      conversation_id: ctx.conversation.id,
      trigger: "daily_brief",
      model: focus ? ctx.config.llm.classifier.model : null,
      iterations: focus ? 1 : 0,
      status: "ok",
      latency_ms: Date.now() - started,
    }).catch(() => {})
  );
  return true;
}

/**
 * Heartbeat: only speaks up for things that are actually pressing, and never
 * calls a model when the snapshot is quiet.
 */
export async function runHeartbeat(ctx: AgentContext): Promise<boolean> {
  const snapshot = await collectAttention(ctx);
  const pressing = snapshot.overdue.length > 0 || snapshot.inboxCount >= 5;
  if (!pressing) return false;

  const parts: string[] = [t(ctx.locale, "heartbeat_header")];
  if (snapshot.overdue.length > 0) {
    parts.push(
      "",
      t(ctx.locale, "today_overdue_header"),
      ...snapshot.overdue.slice(0, 5).map((task) => `· ${task.title}`)
    );
  }
  if (snapshot.inboxCount >= 5) {
    parts.push("", t(ctx.locale, "brief_inbox", { count: snapshot.inboxCount }));
  }
  await ctx.out.sendText(ctx.chatRef, parts.join(NEWLINE));
  return true;
}
