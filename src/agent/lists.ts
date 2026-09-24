/**
 * Paginated, selectable, groupable lists for chat.
 *
 * Every `/tasks`, `/files`, `/notes` … reply is a page: numbered lines, one
 * number button per line, ◀ ▶ navigation, and a "group by" toggle. Selecting a
 * number opens the entity's detail card (details.ts). Nothing here calls the
 * model; a page is one indexed query.
 *
 * Callback flow: the page state (filters + the ids on this page) lives behind
 * a one-shot token in the DO. Every press consumes it and re-renders the same
 * message with a fresh token, so stale buttons can never act on stale data.
 */
import type { AgentContext } from "./context";
import { registerCallbackKind } from "./callback-registry";
import { createCallbackToken, encodeCallbackData } from "./confirmations";
import type { OutboundButton } from "../channels/types";
import type {
  FileRow,
  InboxItemRow,
  LinkRow,
  MemoryRow,
  NoteRow,
  ProjectRow,
  ReminderRow,
  TaskRow,
  VaultChannelRow,
  WalletEntryRow,
} from "../database/types";
import { listTasks } from "../database/repos/tasks";
import { listProjects } from "../database/repos/projects";
import { listNotes } from "../database/repos/notes";
import { searchFiles } from "../database/repos/files";
import { listLinks } from "../database/repos/links";
import { listMemories } from "../database/repos/memories";
import { listReminders } from "../database/repos/reminders";
import { listPendingInbox } from "../database/repos/inbox";
import { listWalletEntries, walletSummary } from "../database/repos/wallet";
import { hybridSearch } from "../database/repos/search";
import { searchByTags, tagCounts, type TaggableKind } from "../database/repos/tags";
import { countFilesPerVault } from "../database/repos/vaults";
import { ensureDefaultVault, vaultLink } from "../services/storage/vault";
import { formatDate, formatDateTime, t } from "../i18n";
import { forceLocalOffset, localPeriodRange, type LocalPeriod } from "../scheduler/tz";
import { formatFileSize, normalizeTags, truncate } from "../utils/text";
import { formatMoney, formatQuantity } from "../utils/money";
import { formatInTimeZone } from "date-fns-tz";

export type ListKind =
  | "tasks"
  | "today"
  | "projects"
  | "notes"
  | "files"
  | "links"
  | "memory"
  | "reminders"
  | "inbox"
  | "tags"
  | "tagged"
  | "find"
  | "vaults"
  | "wallet";

export type GroupBy =
  | "none"
  | "project"
  | "tag"
  | "status"
  | "priority"
  | "kind"
  | "type"
  | "channel"
  | "category"
  | "date";

/** Compact on purpose: it is serialised into the DO callbacks table per page. */
export interface ListState {
  k: ListKind;
  /** 0-based page */
  p: number;
  q?: string;
  /** tag filter — every tag must match */
  tg?: string[];
  by?: GroupBy;
  /** project id */
  pr?: string;
  st?: string;
  /** media kind (files) / memory type (memory) */
  kd?: string;
  /** vault chat id (files) */
  ch?: string;
  /** period window (wallet) — defaults to the current month */
  pd?: LocalPeriod;
}

export type DetailKind =
  | "task"
  | "project"
  | "note"
  | "file"
  | "link"
  | "memory"
  | "reminder"
  | "inbox"
  | "tag"
  | "vault"
  | "wallet";

export interface ListItem {
  kind: DetailKind;
  id: string;
  /** Markdown line (no number prefix). */
  line: string;
  /** Group label; "" when the list is ungrouped. */
  group: string;
}

interface ListPayload {
  s: ListState;
  /** Entities shown on this page, in order — what the number buttons resolve to. */
  items: { k: DetailKind; id: string }[];
}

const LIST_TTL_MS = 24 * 3600 * 1000;
const MAX_ROWS = 200;
const PAGE_SIZE: Partial<Record<ListKind, number>> = { tags: 12, vaults: 8 };
const DEFAULT_PAGE_SIZE = 6;

const GROUP_OPTIONS: Record<ListKind, GroupBy[]> = {
  tasks: ["none", "project", "priority", "status", "tag", "date"],
  today: ["none"],
  projects: ["none", "status", "priority", "tag"],
  notes: ["none", "project", "tag"],
  files: ["project", "kind", "channel", "tag", "date", "none"],
  links: ["none", "tag", "project"],
  memory: ["type", "tag", "none"],
  reminders: ["none", "kind"],
  inbox: ["none"],
  tags: ["none"],
  tagged: ["kind", "none"],
  find: ["kind", "none"],
  vaults: ["none"],
  wallet: ["none", "category", "date", "tag"],
};

const PRIORITY_ICON: Record<string, string> = { critical: "🔴", high: "🟠", medium: "▫️", low: "▪️" };
const STATUS_ICON: Record<string, string> = {
  idea: "💡", planned: "🗓", active: "🟢", waiting: "⏸", blocked: "⛔", completed: "✅", archived: "📦",
  inbox: "📥", todo: "☐", in_progress: "🔄", done: "✅", cancelled: "✖",
};
const KIND_ICON: Record<string, string> = {
  document: "📄", photo: "🖼", video: "🎬", animation: "🎞", audio: "🎵", voice: "🎤", video_note: "📹", sticker: "🏷",
  task: "☑️", project: "📁", note: "📝", file: "📄", link: "🔗", memory: "🧠", reminder: "⏰", inbox_item: "📥",
};
const MEMORY_ICON: Record<string, string> = {
  preference: "💛", decision: "⚖️", project_context: "📁", fact: "📌", workflow: "🔁", event: "📅",
};

/** Escape the few Markdown-sensitive chars in user content (Telegram legacy Markdown). */
export function md(s: string): string {
  return s.replace(/([*_`[])/g, "\\$1");
}

const tagsSuffix = (tags: string[]) => (tags.length > 0 ? " " + tags.slice(0, 3).map((x) => "#" + md(x)).join(" ") : "");

// ── Argument parsing ─────────────────────────────────────────────────────────

/**
 * `/files thesis #pdf by:tag kind:photo` → { q:"thesis", tg:["pdf"], by:"tag", kd:"photo" }.
 * Accepted keys: by:, kind:, type:, cat: (wallet category), status:, dir: (wallet
 * direction), in: (vault channel). Everything else is the query.
 */
export function parseListArgs(args: string): Pick<ListState, "q" | "tg" | "by" | "kd" | "st" | "ch"> {
  const out: Pick<ListState, "q" | "tg" | "by" | "kd" | "st" | "ch"> = {};
  const tags: string[] = [];
  const rest: string[] = [];
  for (const token of args.split(/\s+/).filter(Boolean)) {
    if (token.startsWith("#") && token.length > 1) {
      tags.push(token.slice(1));
      continue;
    }
    const kv = token.match(/^(by|group|kind|type|cat|category|status|dir|direction|in|channel)[:=](.+)$/i);
    if (kv?.[1] && kv[2]) {
      const key = kv[1].toLowerCase();
      const value = kv[2].toLowerCase();
      if (key === "by" || key === "group") {
        const by = value as GroupBy;
        if (["none", "project", "tag", "status", "priority", "kind", "type", "channel", "category", "date"].includes(by)) out.by = by;
      } else if (key === "kind" || key === "type" || key === "cat" || key === "category") out.kd = value;
      else if (key === "status" || key === "dir" || key === "direction") out.st = value;
      else out.ch = kv[2];
      continue;
    }
    rest.push(token);
  }
  if (tags.length > 0) out.tg = normalizeTags(tags);
  if (rest.length > 0) out.q = rest.join(" ");
  return out;
}

// ── Loaders ──────────────────────────────────────────────────────────────────

const taskLine = (ctx: AgentContext, task: TaskRow): string => {
  const icon = PRIORITY_ICON[task.priority] ?? "▫️";
  const due = task.due_at ? ` — ${formatDateTime(task.due_at, ctx.user.timezone, ctx.locale)}` : "";
  const overdue = task.due_at && new Date(task.due_at) < ctx.now && task.status !== "done" ? " ⚠️" : "";
  return `${icon} ${md(task.title)}${due}${overdue}${tagsSuffix(task.tags)}`;
};

const fileLine = (f: FileRow): string => {
  const icon = KIND_ICON[f.media_kind ?? "document"] ?? "📄";
  const size = f.file_size ? ` · ${formatFileSize(f.file_size)}` : "";
  const link = vaultLink(f.vault_chat_id, f.vault_message_id);
  const name = link ? `[${md(f.file_name)}](${link})` : md(f.file_name);
  return `${icon} ${name}${size}${tagsSuffix(f.tags)}`;
};

/** "🔻 25 EGP — 2 kg sugar · groceries · 29 Aug" */
const walletLine = (ctx: AgentContext, e: WalletEntryRow): string => {
  const icon = e.direction === "out" ? "🔻" : "🔺";
  const quantity = formatQuantity(e.quantity, e.unit);
  const category = e.category ? ` · ${md(e.category)}` : "";
  const when = formatDate(e.occurred_at, ctx.user.timezone, ctx.locale);
  return `${icon} *${md(formatMoney(e.amount, e.currency))}* — ${md(truncate(e.description, 60))}${
    quantity ? ` (${md(quantity)})` : ""
  }${category} · ${when}${tagsSuffix(e.tags)}`;
};

function dayGroup(ctx: AgentContext, iso: string | null): string {
  if (!iso) return t(ctx.locale, "group_no_date");
  return formatDate(iso, ctx.user.timezone, ctx.locale);
}

type Loaded = { items: ListItem[]; title: string; projectNames: Map<string, string> };

async function projectNameMap(ctx: AgentContext): Promise<Map<string, string>> {
  const rows = await listProjects(ctx.db, ctx.user.id, { limit: 200 }).catch(() => [] as ProjectRow[]);
  return new Map(rows.map((p) => [p.id, p.name]));
}

function groupOf(
  ctx: AgentContext,
  by: GroupBy,
  fields: { project?: string | null; tags?: string[]; status?: string; priority?: string; kind?: string | null; type?: string; channel?: string | null; category?: string | null; date?: string | null },
  names: Map<string, string>,
  channels?: Map<string, string>
): string {
  switch (by) {
    case "project":
      return fields.project ? (names.get(fields.project) ?? "?") : t(ctx.locale, "group_unfiled");
    case "tag":
      return fields.tags && fields.tags[0] ? `#${fields.tags[0]}` : t(ctx.locale, "group_untagged");
    case "status":
      return `${STATUS_ICON[fields.status ?? ""] ?? "·"} ${fields.status ?? "?"}`;
    case "priority":
      return `${PRIORITY_ICON[fields.priority ?? ""] ?? "▫️"} ${fields.priority ?? "?"}`;
    case "kind":
      return `${KIND_ICON[fields.kind ?? ""] ?? "·"} ${fields.kind ?? "?"}`;
    case "type":
      return `${MEMORY_ICON[fields.type ?? ""] ?? "·"} ${fields.type ?? "?"}`;
    case "channel":
      return fields.channel ? (channels?.get(fields.channel) ?? fields.channel) : t(ctx.locale, "group_no_channel");
    case "category":
      return fields.category ? md(fields.category) : t(ctx.locale, "group_uncategorized");
    case "date":
      return dayGroup(ctx, fields.date ?? null);
    default:
      return "";
  }
}

async function load(ctx: AgentContext, s: ListState): Promise<Loaded> {
  const by = s.by ?? GROUP_OPTIONS[s.k][0] ?? "none";
  const names = await projectNameMap(ctx);
  const items: ListItem[] = [];
  let title = "";

  switch (s.k) {
    case "tasks": {
      title = t(ctx.locale, "tasks_header");
      const statuses = s.st ? [s.st as TaskRow["status"]] : undefined;
      let rows = await listTasks(ctx.db, ctx.user.id, { limit: MAX_ROWS, projectId: s.pr, statuses });
      if (s.tg?.length) rows = rows.filter((r) => s.tg!.every((tag) => r.tags.includes(tag)));
      if (s.q) rows = rows.filter((r) => r.title.toLowerCase().includes(s.q!.toLowerCase()));
      for (const r of rows) {
        items.push({ kind: "task", id: r.id, line: taskLine(ctx, r), group: groupOf(ctx, by, { project: r.project_id, tags: r.tags, status: r.status, priority: r.priority, date: r.due_at }, names) });
      }
      break;
    }
    case "today": {
      title = t(ctx.locale, "today_header");
      const endOfDayLocal = `${formatInTimeZone(ctx.now, ctx.user.timezone, "yyyy-MM-dd")}T23:59`;
      const endIso = new Date(forceLocalOffset(endOfDayLocal, ctx.user.timezone)).toISOString();
      const [overdue, dueToday] = await Promise.all([
        listTasks(ctx.db, ctx.user.id, { overdueOnly: true, limit: 50 }),
        listTasks(ctx.db, ctx.user.id, { dueAfter: ctx.now.toISOString(), dueBefore: endIso, limit: 50 }),
      ]);
      for (const r of overdue) items.push({ kind: "task", id: r.id, line: taskLine(ctx, r), group: t(ctx.locale, "today_overdue_header") });
      for (const r of dueToday) items.push({ kind: "task", id: r.id, line: taskLine(ctx, r), group: t(ctx.locale, "today_due_header") });
      break;
    }
    case "projects": {
      title = t(ctx.locale, "projects_header");
      let rows = await listProjects(ctx.db, ctx.user.id, { limit: MAX_ROWS, statuses: s.st ? [s.st as ProjectRow["status"]] : undefined });
      if (s.tg?.length) rows = rows.filter((r) => s.tg!.every((tag) => r.tags.includes(tag)));
      if (s.q) rows = rows.filter((r) => r.name.toLowerCase().includes(s.q!.toLowerCase()));
      for (const p of rows) {
        items.push({
          kind: "project",
          id: p.id,
          line: `${STATUS_ICON[p.status] ?? "·"} ${md(p.name)} (${p.status}, ${p.progress}%)${tagsSuffix(p.tags)}`,
          group: groupOf(ctx, by, { tags: p.tags, status: p.status, priority: p.priority }, names),
        });
      }
      break;
    }
    case "notes": {
      title = t(ctx.locale, "notes_header");
      let rows = await listNotes(ctx.db, ctx.user.id, { query: s.q, projectId: s.pr, limit: MAX_ROWS });
      if (s.tg?.length) rows = rows.filter((r) => s.tg!.every((tag) => r.tags.includes(tag)));
      for (const n of rows) {
        items.push({
          kind: "note",
          id: n.id,
          line: `${n.pinned ? "📌" : "📝"} ${md(n.title ?? truncate(n.content, 60))}${tagsSuffix(n.tags)}`,
          group: groupOf(ctx, by, { project: n.project_id, tags: n.tags }, names),
        });
      }
      break;
    }
    case "files": {
      title = t(ctx.locale, "files_header");
      const vaults = await ensureDefaultVault(ctx.env, ctx.db, ctx.user.id).catch(() => [] as VaultChannelRow[]);
      const channelNames = new Map(vaults.map((v) => [v.chat_id, v.title ?? v.category ?? v.chat_id]));
      const rows = await searchFiles(ctx.db, ctx.user.id, { query: s.q, projectId: s.pr, mediaKind: s.kd, tags: s.tg, vaultChatId: s.ch, limit: MAX_ROWS });
      for (const f of rows) {
        items.push({
          kind: "file",
          id: f.id,
          line: fileLine(f),
          group: groupOf(ctx, by, { project: f.project_id, tags: f.tags, kind: f.media_kind, channel: f.vault_chat_id, date: f.created_at }, names, channelNames),
        });
      }
      break;
    }
    case "links": {
      title = t(ctx.locale, "links_header");
      let rows = await listLinks(ctx.db, ctx.user.id, { query: s.q, projectId: s.pr, limit: MAX_ROWS });
      if (s.tg?.length) rows = rows.filter((r) => s.tg!.every((tag) => r.tags.includes(tag)));
      for (const l of rows) {
        items.push({
          kind: "link",
          id: l.id,
          line: `🔗 [${md(l.title ?? l.url)}](${l.url})${tagsSuffix(l.tags)}`,
          group: groupOf(ctx, by, { project: l.project_id, tags: l.tags }, names),
        });
      }
      break;
    }
    case "memory": {
      title = t(ctx.locale, "memory_header");
      let rows = await listMemories(ctx.db, ctx.user.id, { query: s.q, types: s.kd ? [s.kd as MemoryRow["memory_type"]] : undefined, limit: MAX_ROWS });
      if (s.tg?.length) rows = rows.filter((r) => s.tg!.every((tag) => r.tags.includes(tag)));
      for (const m of rows) {
        items.push({
          kind: "memory",
          id: m.id,
          line: `${MEMORY_ICON[m.memory_type] ?? "🧠"} ${md(truncate(m.content, 80))}${tagsSuffix(m.tags)}`,
          group: groupOf(ctx, by, { type: m.memory_type, tags: m.tags }, names),
        });
      }
      break;
    }
    case "reminders": {
      title = t(ctx.locale, "reminders_header");
      const rows = await listReminders(ctx.db, ctx.user.id, s.st ? [s.st as ReminderRow["status"]] : ["scheduled", "active", "paused"]);
      for (const r of rows) {
        const when = r.next_trigger_at ? formatDateTime(r.next_trigger_at, ctx.user.timezone, ctx.locale) : "—";
        const label = r.content ?? r.raw_text ?? (r.template_id ? `[${r.template_id}]` : "?");
        const icon = r.status === "paused" ? "⏸" : r.recurrence_rule ? "🔁" : "⏰";
        items.push({ kind: "reminder", id: r.id, line: `${icon} ${md(truncate(label, 70))} — ${when}`, group: groupOf(ctx, by, { kind: r.kind }, names) });
      }
      break;
    }
    case "inbox": {
      title = t(ctx.locale, "inbox_title");
      const rows = await listPendingInbox(ctx.db, ctx.user.id, 100);
      for (const i of rows) {
        items.push({ kind: "inbox", id: i.id, line: `📥 ${md(truncate(i.raw_content ?? `[${i.source}]`, 80))}`, group: "" });
      }
      break;
    }
    case "tags": {
      title = t(ctx.locale, "tags_header");
      const facets = await tagCounts(ctx.db, ctx.user.id);
      for (const f of facets) {
        const parts = Object.entries(f.counts).map(([k, n]) => `${KIND_ICON[k] ?? ""}${n}`).join(" ");
        items.push({ kind: "tag", id: f.name, line: `#${md(f.name)} · ${f.total} (${parts})`, group: "" });
      }
      break;
    }
    case "tagged": {
      const tags = s.tg ?? [];
      title = t(ctx.locale, "tag_results_header", { tag: tags.join(" #") });
      const hits = await searchByTags(ctx.db, ctx.user.id, tags, { kinds: s.kd ? [s.kd as TaggableKind] : undefined });
      for (const h of hits) {
        items.push({ kind: h.kind, id: h.id, line: `${KIND_ICON[h.kind] ?? "·"} ${md(truncate(h.title, 70))}`, group: by === "kind" ? `${KIND_ICON[h.kind] ?? ""} ${h.kind}` : "" });
      }
      break;
    }
    case "find": {
      title = t(ctx.locale, "find_header", { query: md(s.q ?? "") });
      const hits = await hybridSearch(ctx.db, ctx.user.id, s.q ?? "", { embedding: null, limit: 60 });
      for (const h of hits) {
        const kind = (h.kind === "inbox_item" ? "inbox" : h.kind) as DetailKind;
        if (!["task", "project", "note", "file", "link", "memory", "reminder", "inbox"].includes(kind)) continue;
        items.push({ kind, id: h.id, line: `${KIND_ICON[h.kind] ?? "·"} ${md(truncate(h.title, 70))}`, group: by === "kind" ? `${KIND_ICON[h.kind] ?? ""} ${h.kind}` : "" });
      }
      break;
    }
    case "wallet": {
      // The totals ride in the header: a ledger page that doesn't say where you
      // stand is just a list of numbers.
      const period: LocalPeriod = s.pd ?? "month";
      const range = localPeriodRange(period, ctx.user.timezone, ctx.now);
      const direction = s.st === "in" || s.st === "out" ? s.st : undefined;
      const [rows, totals] = await Promise.all([
        listWalletEntries(ctx.db, ctx.user.id, {
          direction,
          category: s.kd,
          query: s.q,
          tags: s.tg,
          projectId: s.pr,
          from: range.from,
          to: range.to,
          limit: MAX_ROWS,
        }),
        walletSummary(ctx.db, ctx.user.id, range).catch(() => []),
      ]);
      const totalsLine =
        totals.length > 0
          ? totals
              .map((x) =>
                t(ctx.locale, "wallet_totals", {
                  in: formatMoney(x.moneyIn, x.currency),
                  out: formatMoney(x.moneyOut, x.currency),
                  net: formatMoney(x.net, x.currency),
                })
              )
              .join(" | ")
          : t(ctx.locale, "wallet_no_totals");
      const periodLabel = t(ctx.locale, `wallet_period_${period}` as never);
      title = [`${t(ctx.locale, "wallet_header")} · ${periodLabel}`, totalsLine].join("\n");
      for (const e of rows) {
        items.push({
          kind: "wallet",
          id: e.id,
          line: walletLine(ctx, e),
          group: groupOf(ctx, by, { project: e.project_id, tags: e.tags, category: e.category, date: e.occurred_at }, names),
        });
      }
      break;
    }
    case "vaults": {
      title = t(ctx.locale, "vault_header");
      const [rows, counts] = await Promise.all([
        ensureDefaultVault(ctx.env, ctx.db, ctx.user.id),
        countFilesPerVault(ctx.db, ctx.user.id).catch(() => ({}) as Record<string, number>),
      ]);
      for (const v of rows) {
        const mark = v.is_default ? "⭐" : v.enabled ? "📁" : "⚪";
        const cat = v.category ? ` · ${md(v.category)}` : "";
        items.push({ kind: "vault", id: v.id, line: `${mark} ${md(v.title ?? v.chat_id)}${cat} · ${counts[v.chat_id] ?? 0} files${tagsSuffix(v.tags)}`, group: "" });
      }
      break;
    }
  }

  if (by !== "none" && s.k !== "today") {
    // Stable group sort; "unfiled/untagged" buckets sink to the end.
    const sink = new Set([t(ctx.locale, "group_unfiled"), t(ctx.locale, "group_untagged"), t(ctx.locale, "group_no_date"), t(ctx.locale, "group_no_channel"), t(ctx.locale, "group_uncategorized")]);
    const indexed = items.map((it, i) => ({ it, i }));
    indexed.sort((a, b) => {
      const sa = sink.has(a.it.group) ? 1 : 0;
      const sb = sink.has(b.it.group) ? 1 : 0;
      if (sa !== sb) return sa - sb;
      const c = a.it.group.localeCompare(b.it.group);
      return c !== 0 ? c : a.i - b.i;
    });
    items.splice(0, items.length, ...indexed.map((x) => x.it));
  }
  return { items, title, projectNames: names };
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface RenderedPage {
  text: string;
  buttons: OutboundButton[][];
  pageItems: { k: DetailKind; id: string }[];
  pages: number;
}

function filterSummary(ctx: AgentContext, s: ListState, by: GroupBy): string {
  const parts: string[] = [];
  if (s.q && s.k !== "find") parts.push(`"${md(s.q)}"`);
  if (s.tg?.length && s.k !== "tagged") parts.push(s.tg.map((x) => "#" + md(x)).join(" "));
  if (s.kd) parts.push(md(s.kd));
  if (s.st) parts.push(md(s.st));
  if (by !== "none" && GROUP_OPTIONS[s.k].length > 1) parts.push(t(ctx.locale, "list_grouped_by", { by: t(ctx.locale, `group_${by}` as never) }));
  return parts.length > 0 ? " · " + parts.join(" · ") : "";
}

export function paginate<T>(items: T[], page: number, size: number): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { slice: items.slice(p * size, p * size + size), page: p, pages };
}

export async function renderList(ctx: AgentContext, s: ListState): Promise<RenderedPage> {
  const by = s.by ?? GROUP_OPTIONS[s.k][0] ?? "none";
  const { items, title } = await load(ctx, s);
  const size = PAGE_SIZE[s.k] ?? DEFAULT_PAGE_SIZE;
  const { slice, page, pages } = paginate(items, s.p, size);
  s.p = page;

  const lines: string[] = [];
  const head = pages > 1 ? `${title} · ${t(ctx.locale, "list_page", { page: page + 1, pages })}` : title;
  lines.push(head + filterSummary(ctx, s, by));
  if (items.length === 0) {
    lines.push("", t(ctx.locale, emptyKey(s.k)));
  } else {
    let lastGroup: string | null = null;
    slice.forEach((it, i) => {
      if (it.group && it.group !== lastGroup) {
        lines.push("", `▸ *${md(it.group)}*`);
        lastGroup = it.group;
      }
      lines.push(`${i + 1}. ${it.line}`);
    });
    if (s.k === "tags") lines.push("", t(ctx.locale, "tags_hint"));
  }

  const payload: ListPayload = { s, items: slice.map((it) => ({ k: it.kind, id: it.id })) };
  const token = createCallbackToken<ListPayload>(ctx.do, "lst", payload, ctx.now.getTime(), LIST_TTL_MS);
  const cb = (verb: string) => encodeCallbackData("lst", token, verb);

  const buttons: OutboundButton[][] = [];
  if (slice.length > 0 && s.k !== "tags") {
    const numberRow: OutboundButton[] = slice.map((_, i) => ({ label: String(i + 1), data: cb(`i${i}`) }));
    for (let i = 0; i < numberRow.length; i += 6) buttons.push(numberRow.slice(i, i + 6));
  } else if (s.k === "tags" && slice.length > 0) {
    // Tags are short: the tag itself is the button.
    const row: OutboundButton[] = [];
    slice.forEach((it, i) => {
      row.push({ label: `#${truncate(it.id, 14)}`, data: cb(`i${i}`) });
      if (row.length === 3) {
        buttons.push([...row]);
        row.length = 0;
      }
    });
    if (row.length > 0) buttons.push(row);
  }
  const nav: OutboundButton[] = [];
  if (pages > 1) nav.push({ label: page > 0 ? "◀" : "·", data: cb(page > 0 ? "b" : "r") });
  nav.push({ label: pages > 1 ? `${page + 1}/${pages}` : "🔄", data: cb("r") });
  if (pages > 1) nav.push({ label: page < pages - 1 ? "▶" : "·", data: cb(page < pages - 1 ? "n" : "r") });
  if (GROUP_OPTIONS[s.k].length > 1) {
    nav.push({ label: t(ctx.locale, "btn_group", { by: t(ctx.locale, `group_${nextGroup(s.k, by)}` as never) }), data: cb("g") });
  }
  buttons.push(nav);

  return { text: lines.join("\n"), buttons, pageItems: payload.items, pages };
}

function emptyKey(k: ListKind): Parameters<typeof t>[1] {
  switch (k) {
    case "tasks": return "tasks_empty";
    case "today": return "today_all_clear";
    case "projects": return "projects_empty";
    case "notes": return "notes_empty";
    case "files": return "files_empty";
    case "links": return "links_empty";
    case "memory": return "memory_empty";
    case "reminders": return "reminders_empty";
    case "inbox": return "inbox_empty";
    case "tags": return "tags_empty";
    case "vaults": return "vault_empty";
    case "wallet": return "wallet_empty";
    default: return "list_empty";
  }
}

function nextGroup(k: ListKind, current: GroupBy): GroupBy {
  const options = GROUP_OPTIONS[k];
  const i = options.indexOf(current);
  return options[(i + 1) % options.length] ?? "none";
}

/** Send a fresh list message. */
export async function sendList(ctx: AgentContext, state: ListState): Promise<void> {
  const page = await renderList(ctx, state);
  await ctx.out.sendButtons(ctx.chatRef, page.text, page.buttons, { disablePreview: true });
}

/** Re-render an existing list message in place (falls back to a new message). */
export async function editList(ctx: AgentContext, messageId: string | undefined, state: ListState): Promise<void> {
  const page = await renderList(ctx, state);
  if (messageId) {
    try {
      await ctx.out.editText(ctx.chatRef, messageId, page.text, { buttons: page.buttons, disablePreview: true });
      return;
    } catch {
      /* fall through to a fresh message */
    }
  }
  await ctx.out.sendButtons(ctx.chatRef, page.text, page.buttons, { disablePreview: true });
}

// ── Callback handler ─────────────────────────────────────────────────────────

/** Set by details.ts to avoid an import cycle (details → lists for "back"). */
let openDetail: ((ctx: AgentContext, kind: DetailKind, id: string, back: ListState, messageId?: string) => Promise<void>) | null = null;
export function setDetailOpener(fn: typeof openDetail): void {
  openDetail = fn;
}

registerCallbackKind("lst", async (ctx, payload, verb, messageId) => {
  const { s, items } = payload as ListPayload;
  if (verb === "n") s.p += 1;
  else if (verb === "b") s.p = Math.max(0, s.p - 1);
  else if (verb === "g") s.by = nextGroup(s.k, s.by ?? GROUP_OPTIONS[s.k][0] ?? "none");
  else if (verb.startsWith("i")) {
    const idx = Number.parseInt(verb.slice(1), 10);
    const target = items[idx];
    if (!target) {
      await editList(ctx, messageId, s);
      return;
    }
    if (target.k === "tag") {
      await editList(ctx, messageId, { k: "tagged", p: 0, tg: [target.id], by: "kind" });
      return;
    }
    if (openDetail) {
      await openDetail(ctx, target.k, target.id, s, messageId);
      return;
    }
  }
  await editList(ctx, messageId, s);
});
