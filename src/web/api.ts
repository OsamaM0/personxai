/**
 * Dashboard REST API.
 *
 * Every handler goes through the same repos the agent's tools use, so the web
 * and the chat surface can never drift apart or bypass each other's rules. The
 * session's user id is the only tenancy key: it is passed to each repo call and
 * never taken from the request body.
 */
import { getAgentByName } from "agents";
import type { Env } from "../env";
import type { Db } from "../database/client";
import type { Enums, TablesUpdate } from "../database/types";
import { loadConfig } from "../config";
import type { IncomingMessage } from "../channels/types";

import { updateUser } from "../database/repos/users";
import { getAllSettings } from "../database/repos/settings";
import { createProject, listProjects, projectSummary, slugify, updateProject } from "../database/repos/projects";
import { countOverdueTasks, createTask, deleteTask, listTasks, updateTask } from "../database/repos/tasks";
import { createNote, deleteNote, listNotes, updateNote } from "../database/repos/notes";
import { countPendingInbox, listPendingInbox, resolveInboxItem } from "../database/repos/inbox";
import { cancelReminder, insertReminder, listReminders, updateReminder } from "../database/repos/reminders";
import { fileTagNames, getFileById, searchFiles, tagFile, updateFile } from "../database/repos/files";
import { tagCounts } from "../database/repos/tags";
import {
  countFilesPerVault,
  deleteVaultChannel,
  listVaultChannels,
  setDefaultVault,
  updateVaultChannel,
} from "../database/repos/vaults";
import { connectVaultChannel, ensureDefaultVault, moveVaultMessage, syncVaultChannel, vaultLink } from "../services/storage/vault";
import {
  createMemory,
  deleteUserFact,
  forgetMemory,
  listMemories,
  listUserFacts,
  updateMemory,
  upsertUserFact,
} from "../database/repos/memories";
import { deleteLink, listLinks, updateLink } from "../database/repos/links";
import {
  createWalletEntry,
  deleteWalletEntry,
  listWalletEntries,
  setWalletCurrency,
  updateWalletEntry,
  walletCategoryTotals,
  walletCurrency,
  walletSummary,
} from "../database/repos/wallet";
import {
  clearSystemPrompt,
  createSkill,
  deleteMcpServer,
  deleteSkill,
  getActiveSystemPrompt,
  listMcpServers,
  listSkills,
  listSystemPromptVersions,
  setSystemPrompt,
  updateMcpServer,
  updateSkill,
  upsertMcpServer,
} from "../database/repos/skills";
import {
  archiveConversation,
  getActiveConversation,
  listConversations,
  startNewConversation,
  switchConversation,
} from "../database/repos/conversations";
import { recentMessages } from "../database/repos/messages";
import { recentRuns, usageSince } from "../database/repos/runs";
import { insertAudit, listAudit } from "../database/repos/audit";
import { hybridSearch } from "../database/repos/search";
import {
  describeMcpAccess,
  issueMcpToken,
  revokeMcpToken,
  MCP_DEFAULT_TTL_DAYS,
  MCP_SCOPES,
} from "../mcp/server/tokens";
import { dispatchTick } from "../scheduler/dispatcher";
import { nextOccurrence } from "../scheduler/rrule";
import { isValidTimezone, localPeriodRange, type LocalPeriod } from "../scheduler/tz";
import { normalizeCurrency } from "../utils/money";
import { getAdapter } from "../channels/registry";
import { parseAllowedOrigins } from "../config";
import { log, formatError } from "../utils/logger";

import type { WebSession } from "./auth";
import { handleLoginRedeem, handleLoginRequest, handleLogout, requireSession } from "./auth";
import { handleMiniAppLogin } from "./miniapp";
import {
  HttpError,
  assertSameOrigin,
  assertUuid,
  badRequest,
  bool,
  definedOnly,
  isoDate,
  json,
  matchPath,
  notFound,
  num,
  nullableStr,
  oneOf,
  queryLimit,
  readJsonBody,
  requiredStr,
  str,
  strArray,
  uuid,
} from "./http";

const TASK_STATUSES = ["inbox", "todo", "in_progress", "waiting", "blocked", "done", "cancelled"] as const;
const PROJECT_STATUSES = ["idea", "planned", "active", "waiting", "blocked", "completed", "archived"] as const;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;
const MEMORY_TYPES = ["preference", "decision", "project_context", "fact", "workflow", "event"] as const;
const REMINDER_STATUSES = ["scheduled", "active", "paused", "completed", "cancelled", "failed"] as const;
const NOTE_SOURCES = ["manual", "research", "url", "file", "voice", "agent"] as const;
const INBOX_RESOLUTIONS = ["organized", "dismissed"] as const;
const WALLET_DIRECTIONS = ["in", "out"] as const;
const WALLET_PERIODS = ["today", "yesterday", "week", "month", "year", "all"] as const;
const ENTITY_KINDS = [
  "project", "task", "note", "file", "reminder", "link", "memory",
  "inbox_item", "skill", "conversation", "setting", "user",
] as const;

/**
 * Language tags are stored in the shape resolveLocale() produces ("ar-EG"), but
 * arrive from forms and older rows in mixed case. Canonicalise the same way
 * rather than rejecting a tag the bot already accepts.
 */
const LANGUAGES = ["en", "ar", "ar-EG"] as const;

function languageField(body: Record<string, unknown>): string | undefined {
  const v = body.language;
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw badRequest("language must be a string");
  const tag = v.trim().toLowerCase().replace(/_/g, "-");
  const match = LANGUAGES.find((l) => l.toLowerCase() === tag);
  if (!match) throw badRequest(`language must be one of: ${LANGUAGES.join(", ")}`);
  return match;
}

/** Split a comma-separated query param into a validated enum list. */
function statusesParam<T extends string>(url: URL, key: string, allowed: readonly T[]): T[] | undefined {
  const raw = url.searchParams.get(key);
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = parts.find((p) => !allowed.includes(p as T));
  if (bad) throw badRequest(`${key} contains an unknown value: ${bad}`);
  return parts as T[];
}

function optionalUuidParam(url: URL, key: string): string | undefined {
  const raw = url.searchParams.get(key);
  if (!raw) return undefined;
  return assertUuid(raw, key);
}

/**
 * Route table. Each entry is [method, pattern, handler]; the first shape match
 * wins, and a path that matches no pattern falls through to a 404.
 */
type Handler = (ctx: ApiContext) => Promise<Response>;

interface ApiContext {
  request: Request;
  env: Env;
  url: URL;
  db: Db;
  session: WebSession;
  params: Record<string, string>;
  now: Date;
  waitUntil: (p: Promise<unknown>) => void;
}

const routes: Array<[string, string, Handler]> = [];
const route = (method: string, pattern: string, handler: Handler) => {
  routes.push([method, pattern, handler]);
};

// ── Session & overview ───────────────────────────────────────────────────────

route("GET", "/api/bootstrap", async ({ env, db, session }) => {
  const [settings, conversation, projects] = await Promise.all([
    getAllSettings(db, session.user.id),
    getActiveConversation(db, session.user.id),
    listProjects(db, session.user.id, { limit: 100 }),
  ]);
  // Only non-secret settings reach the browser; the login bucket is internal.
  const { ["web.login"]: _login, ...publicSettings } = settings;
  return json({
    user: session.user,
    identity: {
      channel: session.identity.channel,
      username: session.identity.username,
      external_id: session.identity.external_id,
    },
    settings: publicSettings,
    conversation,
    // Every entity form needs the project list; ship it once at boot.
    projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    system: systemSummary(env),
  });
});

route("GET", "/api/overview", async ({ db, session, now }) => {
  const userId = session.user.id;
  const dayAhead = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  const month = localPeriodRange("month", session.user.timezone, now);
  const [today, overdue, inboxCount, reminders, usage, projects, wallet] = await Promise.all([
    listTasks(db, userId, { dueBefore: dayAhead, limit: 20 }),
    countOverdueTasks(db, userId),
    countPendingInbox(db, userId),
    listReminders(db, userId, ["scheduled", "active"]),
    usageSince(db, userId, new Date(now.getTime() - 24 * 3600 * 1000).toISOString()),
    listProjects(db, userId, { limit: 100 }),
    walletSummary(db, userId, month).catch(() => []),
  ]);
  return json({
    tasksDueSoon: today,
    overdueCount: overdue,
    inboxPending: inboxCount,
    reminders: reminders.slice(0, 10),
    reminderCount: reminders.length,
    usage24h: usage,
    activeProjects: projects.filter((p) => p.status === "active").length,
    projectCount: projects.length,
    // Money is a headline number, so the overview carries this month's totals
    // for the busiest currency rather than making the browser ask again.
    walletMonth: wallet[0] ?? null,
  });
});

route("PATCH", "/api/user", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const timezone = str(body, "timezone", 64);
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    throw badRequest(`unknown timezone: ${timezone}`);
  }
  const patch = definedOnly({
    display_name: nullableStr(body, "display_name", 120),
    timezone,
    language: languageField(body),
    autonomy_level: num(body, "autonomy_level", 0, 3),
    // Setting the timezone from the dashboard is an explicit confirmation.
    tz_confirmed: timezone !== undefined ? true : bool(body, "tz_confirmed"),
  }) as TablesUpdate<"users">;
  if (Object.keys(patch).length === 0) throw badRequest("no supported fields supplied");
  await updateUser(db, session.user.id, patch);
  await audit(db, session, "web.user_updated", "user", session.user.id, patch);
  return json({ ok: true, patch });
});

// ── Projects ─────────────────────────────────────────────────────────────────

route("GET", "/api/projects", async ({ db, session, url }) => {
  const projects = await listProjects(db, session.user.id, {
    statuses: statusesParam(url, "status", PROJECT_STATUSES),
    limit: queryLimit(url, 50, 200),
  });
  // The list view shows per-project counts, so summarise here rather than
  // making the browser issue N follow-up requests.
  const summaries = await Promise.all(projects.map((p) => projectSummary(db, session.user.id, p)));
  return json({ items: summaries });
});

route("POST", "/api/projects", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const name = requiredStr(body, "name", 200);
  const project = await createProject(db, {
    user_id: session.user.id,
    name,
    slug: slugify(name),
    description: nullableStr(body, "description", 5000) ?? null,
    status: oneOf(body, "status", PROJECT_STATUSES) ?? "active",
    priority: oneOf(body, "priority", PRIORITIES) ?? "medium",
    category: nullableStr(body, "category", 80) ?? null,
    tags: strArray(body, "tags") ?? [],
    due_date: isoDate(body, "due_date") ?? null,
  });
  await audit(db, session, "web.project_created", "project", project.id, { name });
  return json({ item: project }, 201);
});

route("PATCH", "/api/projects/:id", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "project id");
  const body = await readJsonBody(request);
  const name = str(body, "name", 200);
  const patch = definedOnly({
    name,
    // Keep the slug in step with the name; findProject() resolves by slug.
    slug: name !== undefined ? slugify(name) : undefined,
    description: nullableStr(body, "description", 5000),
    status: oneOf(body, "status", PROJECT_STATUSES),
    priority: oneOf(body, "priority", PRIORITIES),
    category: nullableStr(body, "category", 80),
    tags: strArray(body, "tags"),
    due_date: isoDate(body, "due_date"),
    progress: num(body, "progress", 0, 100),
  }) as TablesUpdate<"projects">;
  if (Object.keys(patch).length === 0) throw badRequest("no supported fields supplied");
  await updateProject(db, session.user.id, id, patch);
  await audit(db, session, "web.project_updated", "project", id, patch);
  return json({ ok: true });
});

/** Projects are archived, never destroyed — tasks and notes still reference them. */
route("DELETE", "/api/projects/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "project id");
  await updateProject(db, session.user.id, id, { status: "archived" });
  await audit(db, session, "web.project_archived", "project", id, {});
  return json({ ok: true, archived: true });
});

// ── Tasks ────────────────────────────────────────────────────────────────────

route("GET", "/api/tasks", async ({ db, session, url }) => {
  const items = await listTasks(db, session.user.id, {
    statuses: statusesParam(url, "status", TASK_STATUSES),
    projectId: optionalUuidParam(url, "project_id"),
    overdueOnly: url.searchParams.get("overdue") === "true",
    tag: url.searchParams.get("tag") ?? undefined,
    limit: queryLimit(url, 50, 200),
  });
  return json({ items });
});

route("POST", "/api/tasks", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const task = await createTask(db, {
    user_id: session.user.id,
    title: requiredStr(body, "title", 500),
    description: nullableStr(body, "description", 20_000) ?? null,
    status: oneOf(body, "status", TASK_STATUSES) ?? "todo",
    priority: oneOf(body, "priority", PRIORITIES) ?? "medium",
    project_id: uuid(body, "project_id") ?? null,
    parent_task_id: uuid(body, "parent_task_id") ?? null,
    due_at: isoDate(body, "due_at") ?? null,
    start_at: isoDate(body, "start_at") ?? null,
    recurrence_rule: nullableStr(body, "recurrence_rule", 500) ?? null,
    tags: strArray(body, "tags") ?? [],
    source: "web",
  });
  await audit(db, session, "web.task_created", "task", task.id, { title: task.title });
  return json({ item: task }, 201);
});

route("PATCH", "/api/tasks/:id", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "task id");
  const body = await readJsonBody(request);
  const patch = definedOnly({
    title: str(body, "title", 500),
    description: nullableStr(body, "description", 20_000),
    status: oneOf(body, "status", TASK_STATUSES),
    priority: oneOf(body, "priority", PRIORITIES),
    project_id: uuid(body, "project_id"),
    due_at: isoDate(body, "due_at"),
    start_at: isoDate(body, "start_at"),
    recurrence_rule: nullableStr(body, "recurrence_rule", 500),
    tags: strArray(body, "tags"),
  }) as TablesUpdate<"tasks">;
  if (Object.keys(patch).length === 0) throw badRequest("no supported fields supplied");
  // updateTask stamps completed_at itself when status flips to done.
  await updateTask(db, session.user.id, id, patch);
  await audit(db, session, "web.task_updated", "task", id, patch);
  return json({ ok: true });
});

route("DELETE", "/api/tasks/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "task id");
  const deleted = await deleteTask(db, session.user.id, id);
  if (!deleted) throw notFound("task not found");
  await audit(db, session, "web.task_deleted", "task", id, {});
  return json({ ok: true });
});

// ── Notes ────────────────────────────────────────────────────────────────────

route("GET", "/api/notes", async ({ db, session, url }) => {
  const items = await listNotes(db, session.user.id, {
    query: url.searchParams.get("q") ?? undefined,
    projectId: optionalUuidParam(url, "project_id"),
    tag: url.searchParams.get("tag") ?? undefined,
    limit: queryLimit(url, 50, 200),
  });
  return json({ items });
});

route("POST", "/api/notes", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const note = await createNote(db, {
    user_id: session.user.id,
    title: nullableStr(body, "title", 300) ?? null,
    content: requiredStr(body, "content", 100_000),
    project_id: uuid(body, "project_id") ?? null,
    tags: strArray(body, "tags") ?? [],
    pinned: bool(body, "pinned") ?? false,
    source: oneOf(body, "source", NOTE_SOURCES) ?? "manual",
  });
  // Notes written here have no embedding: /api/search still finds them by
  // keyword, and the next agent-side edit backfills the vector.
  await audit(db, session, "web.note_created", "note", note.id, {});
  return json({ item: note }, 201);
});

route("PATCH", "/api/notes/:id", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "note id");
  const body = await readJsonBody(request);
  const patch = definedOnly({
    title: nullableStr(body, "title", 300),
    content: str(body, "content", 100_000),
    project_id: uuid(body, "project_id"),
    tags: strArray(body, "tags"),
    pinned: bool(body, "pinned"),
  }) as TablesUpdate<"notes">;
  if (Object.keys(patch).length === 0) throw badRequest("no supported fields supplied");
  await updateNote(db, session.user.id, id, patch);
  await audit(db, session, "web.note_updated", "note", id, patch);
  return json({ ok: true });
});

route("DELETE", "/api/notes/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "note id");
  const deleted = await deleteNote(db, session.user.id, id);
  if (!deleted) throw notFound("note not found");
  await audit(db, session, "web.note_deleted", "note", id, {});
  return json({ ok: true });
});

// ── Inbox ────────────────────────────────────────────────────────────────────

route("GET", "/api/inbox", async ({ db, session, url }) => {
  const items = await listPendingInbox(db, session.user.id, queryLimit(url, 25, 100));
  return json({ items });
});

route("POST", "/api/inbox/:id/resolve", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "inbox item id");
  const body = await readJsonBody(request);
  const status = oneOf(body, "status", INBOX_RESOLUTIONS) ?? "dismissed";
  await resolveInboxItem(db, session.user.id, id, {
    status: status as Enums<"inbox_status">,
    resolvedKind: oneOf(body, "resolved_kind", ENTITY_KINDS) as Enums<"entity_kind"> | undefined,
    resolvedEntityId: uuid(body, "resolved_entity_id") ?? undefined,
  });
  await audit(db, session, "web.inbox_resolved", "inbox_item", id, { status });
  return json({ ok: true });
});

// ── Reminders ────────────────────────────────────────────────────────────────

route("GET", "/api/reminders", async ({ db, session, url }) => {
  const statuses = statusesParam(url, "status", REMINDER_STATUSES) ?? ["scheduled", "active"];
  const items = await listReminders(db, session.user.id, statuses as Enums<"reminder_status">[]);
  return json({ items });
});

route("POST", "/api/reminders", async ({ request, db, session, now }) => {
  const body = await readJsonBody(request);
  const content = requiredStr(body, "content", 2000);
  const rule = nullableStr(body, "recurrence_rule", 500) ?? null;
  const timezone = str(body, "timezone", 64) ?? session.user.timezone;
  if (!isValidTimezone(timezone)) throw badRequest(`unknown timezone: ${timezone}`);

  let triggerAt = isoDate(body, "next_trigger_at") ?? null;
  if (rule) {
    // Recurring: the rule owns the schedule, so derive the first fire time from
    // it rather than trusting a hand-typed timestamp.
    const anchor = triggerAt ? new Date(triggerAt) : now;
    const next = nextOccurrence(rule, { after: now, anchor, timezone });
    if (!next) throw badRequest("recurrence_rule is not a schedule that ever fires");
    triggerAt = next.toISOString();
  } else if (!triggerAt) {
    throw badRequest("next_trigger_at is required for a one-off reminder");
  }

  const reminder = await insertReminder(db, {
    user_id: session.user.id,
    kind: rule ? "recurring" : "static",
    status: "scheduled",
    content,
    raw_text: content,
    recurrence_rule: rule,
    timezone,
    start_at: now.toISOString(),
    next_trigger_at: triggerAt,
    deadline_at: isoDate(body, "deadline_at") ?? null,
    linked_task_id: uuid(body, "linked_task_id") ?? null,
  });
  await audit(db, session, "web.reminder_created", "reminder", reminder.id, { content });
  return json({ item: reminder }, 201);
});

route("PATCH", "/api/reminders/:id", async ({ request, db, session, params, now }) => {
  const id = assertUuid(params.id ?? "", "reminder id");
  const body = await readJsonBody(request);
  const timezone = str(body, "timezone", 64);
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    throw badRequest(`unknown timezone: ${timezone}`);
  }
  const rule = nullableStr(body, "recurrence_rule", 500);
  const patch = definedOnly({
    content: str(body, "content", 2000),
    status: oneOf(body, "status", REMINDER_STATUSES),
    recurrence_rule: rule,
    timezone,
    next_trigger_at: isoDate(body, "next_trigger_at"),
    deadline_at: isoDate(body, "deadline_at"),
  }) as TablesUpdate<"reminders">;
  if (Object.keys(patch).length === 0) throw badRequest("no supported fields supplied");

  // A changed rule invalidates the stored trigger; recompute it from the rule.
  if (rule) {
    const tz = timezone ?? session.user.timezone;
    const next = nextOccurrence(rule, { after: now, anchor: now, timezone: tz });
    if (!next) throw badRequest("recurrence_rule is not a schedule that ever fires");
    patch.next_trigger_at = next.toISOString();
    patch.kind = "recurring";
  }
  await updateReminder(db, session.user.id, id, patch);
  await audit(db, session, "web.reminder_updated", "reminder", id, patch);
  return json({ ok: true });
});

route("DELETE", "/api/reminders/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "reminder id");
  const cancelled = await cancelReminder(db, session.user.id, id);
  if (!cancelled) throw notFound("reminder not found");
  await audit(db, session, "web.reminder_cancelled", "reminder", id, {});
  return json({ ok: true });
});

// ── Files ────────────────────────────────────────────────────────────────────
// Bytes live in the Telegram vault channel and never transit the worker, so the
// dashboard shows metadata and hands delivery back to Telegram via copyMessage.

route("GET", "/api/files", async ({ db, session, url }) => {
  const tag = url.searchParams.get("tag");
  const items = await searchFiles(db, session.user.id, {
    query: url.searchParams.get("q") ?? undefined,
    projectId: optionalUuidParam(url, "project_id"),
    mediaKind: url.searchParams.get("kind") ?? undefined,
    tags: tag ? tag.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
    vaultChatId: url.searchParams.get("vault") ?? undefined,
    limit: queryLimit(url, 30, 200),
  });
  // The deep link lets the dashboard open the post in Telegram without moving bytes.
  return json({ items: items.map((f) => ({ ...f, vault_link: vaultLink(f.vault_chat_id, f.vault_message_id) })) });
});

route("GET", "/api/files/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "file id");
  const file = await getFileById(db, session.user.id, id);
  if (!file) throw notFound("file not found");
  return json({ item: file, tags: await fileTagNames(db, file.id) });
});

route("PATCH", "/api/files/:id", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "file id");
  const body = await readJsonBody(request);
  const patch = definedOnly({
    file_name: str(body, "file_name", 300),
    caption: nullableStr(body, "caption", 2000),
    summary: nullableStr(body, "summary", 5000),
    project_id: uuid(body, "project_id"),
  }) as TablesUpdate<"files">;
  const tags = strArray(body, "tags", 20);
  if (Object.keys(patch).length === 0 && tags === undefined) throw badRequest("no supported fields supplied");
  if (Object.keys(patch).length > 0) await updateFile(db, session.user.id, id, patch);
  if (tags !== undefined) await tagFile(db, session.user.id, id, tags.map((x) => x.toLowerCase().trim().replace(/\s+/g, "-")), "replace");
  await audit(db, session, "web.file_updated", "file", id, { ...patch, ...(tags !== undefined ? { tags } : {}) });
  return json({ ok: true });
});

/** Re-file a stored item into another vault channel (copy + delete on Telegram). */
route("POST", "/api/files/:id/move", async ({ request, env, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "file id");
  const body = await readJsonBody(request);
  const vaultId = requiredStr(body, "vault_id", 80);
  const file = await getFileById(db, session.user.id, id);
  if (!file) throw notFound("file not found");
  const target = (await listVaultChannels(db, session.user.id, true)).find((v) => v.id === vaultId);
  if (!target) throw notFound("vault channel not found");
  if (target.chat_id === file.vault_chat_id) return json({ ok: true, unchanged: true });
  const moved = await moveVaultMessage(env, file, target.chat_id);
  if (!moved) throw new HttpError(502, "Telegram refused the copy — is the bot an admin of that channel?");
  await updateFile(db, session.user.id, id, { vault_chat_id: moved.vaultChatId, vault_message_id: moved.vaultMessageId });
  await audit(db, session, "web.file_moved", "file", id, { to: target.title ?? target.chat_id });
  return json({ ok: true, vault_link: vaultLink(moved.vaultChatId, moved.vaultMessageId) });
});

// ── Tags & vault channels ────────────────────────────────────────────────────

route("GET", "/api/tags", async ({ db, session }) => {
  return json({ items: await tagCounts(db, session.user.id) });
});

route("GET", "/api/vault", async ({ env, db, session }) => {
  const [rows, counts] = await Promise.all([
    ensureDefaultVault(env, db, session.user.id),
    countFilesPerVault(db, session.user.id),
  ]);
  return json({
    items: rows.map((v) => ({ ...v, file_count: counts[v.chat_id] ?? 0, link: vaultLink(v.chat_id, "") ? `https://t.me/c/${v.chat_id.replace(/^-100/, "")}` : null })),
  });
});

route("POST", "/api/vault", async ({ request, env, db, session }) => {
  const body = await readJsonBody(request);
  const chatId = requiredStr(body, "chat_id", 40).trim();
  if (!/^-100\d+$/.test(chatId)) throw badRequest("chat_id must look like -1001234567890");
  const result = await connectVaultChannel(env, db, session.user.id, chatId, {
    category: nullableStr(body, "category", 60) ?? null,
    tags: strArray(body, "tags", 20) ?? [],
    title: nullableStr(body, "title", 120) ?? null,
  });
  if ("error" in result) throw new HttpError(409, result.error);
  await audit(db, session, "web.vault_connected", null, null, { chat_id: chatId });
  return json({ item: result.row }, 201);
});

route("PATCH", "/api/vault/:id", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "vault id");
  const body = await readJsonBody(request);
  const patch = definedOnly({
    title: nullableStr(body, "title", 120),
    category: nullableStr(body, "category", 60),
    tags: strArray(body, "tags", 20),
    enabled: bool(body, "enabled"),
  }) as TablesUpdate<"vault_channels">;
  const makeDefault = bool(body, "is_default");
  if (Object.keys(patch).length > 0) await updateVaultChannel(db, session.user.id, id, patch);
  if (makeDefault) await setDefaultVault(db, session.user.id, id);
  await audit(db, session, "web.vault_updated", null, null, { id, ...patch, is_default: makeDefault });
  return json({ ok: true });
});

route("POST", "/api/vault/:id/sync", async ({ env, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "vault id");
  const row = (await listVaultChannels(db, session.user.id)).find((v) => v.id === id);
  if (!row) throw notFound("vault channel not found");
  const synced = await syncVaultChannel(env, db, row);
  return json({ item: synced });
});

route("DELETE", "/api/vault/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "vault id");
  const ok = await deleteVaultChannel(db, session.user.id, id);
  if (!ok) throw new HttpError(409, "the default channel cannot be removed — make another one default first");
  await audit(db, session, "web.vault_removed", null, null, { id });
  return json({ ok: true });
});

/**
 * Deliver a stored file to the user's chat on the channel they signed in
 * through. Every reference the vault has is passed; the adapter picks the one
 * it can use (Telegram copies the vault post, WhatsApp relays the file id).
 */
route("POST", "/api/files/:id/send", async ({ env, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "file id");
  const file = await getFileById(db, session.user.id, id);
  if (!file) throw notFound("file not found");

  const ref: Record<string, string | number | boolean> = { file_name: file.file_name };
  if (file.vault_chat_id && file.vault_message_id !== null) {
    ref.vault_chat_id = file.vault_chat_id;
    ref.vault_message_id = file.vault_message_id;
  }
  if (file.tg_file_id) ref.file_id = file.tg_file_id;
  if (!ref.vault_chat_id && !ref.file_id) {
    throw new HttpError(409, "this file has no vault reference to send from");
  }

  const adapter = getAdapter(session.identity.channel);
  const out = adapter?.outbound(env);
  if (!out?.sendMediaByRef) throw new HttpError(409, `files cannot be sent over ${session.identity.channel}`);
  await out.sendMediaByRef(session.chatRef, ref, { caption: file.file_name });
  await audit(db, session, "web.file_sent", "file", id, { file_name: file.file_name });
  return json({ ok: true, sentTo: session.identity.channel });
});

route("DELETE", "/api/files/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "file id");
  const file = await getFileById(db, session.user.id, id);
  if (!file) throw notFound("file not found");
  // Soft delete only: the bytes stay in the vault channel, which we do not own.
  await updateFile(db, session.user.id, id, { deleted_at: new Date().toISOString() });
  await audit(db, session, "web.file_deleted", "file", id, { file_name: file.file_name });
  return json({ ok: true, softDeleted: true });
});

// ── Memory ───────────────────────────────────────────────────────────────────

route("GET", "/api/memories", async ({ db, session, url }) => {
  const items = await listMemories(db, session.user.id, {
    query: url.searchParams.get("q") ?? undefined,
    types: statusesParam(url, "type", MEMORY_TYPES) as Enums<"memory_type">[] | undefined,
    projectId: optionalUuidParam(url, "project_id"),
    tag: url.searchParams.get("tag") ?? undefined,
    limit: queryLimit(url, 50, 200),
  });
  return json({ items });
});

route("POST", "/api/memories", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const memory = await createMemory(db, {
    user_id: session.user.id,
    content: requiredStr(body, "content", 20_000),
    memory_type: oneOf(body, "memory_type", MEMORY_TYPES) ?? "fact",
    importance: num(body, "importance", 1, 5) ?? 3,
    project_id: uuid(body, "project_id") ?? null,
    tags: strArray(body, "tags") ?? [],
  });
  await audit(db, session, "web.memory_created", "memory", memory.id, {});
  return json({ item: memory }, 201);
});

route("PATCH", "/api/memories/:id", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "memory id");
  const body = await readJsonBody(request);
  const patch = definedOnly({
    content: str(body, "content", 20_000),
    memory_type: oneOf(body, "memory_type", MEMORY_TYPES),
    importance: num(body, "importance", 1, 5),
    project_id: uuid(body, "project_id"),
    tags: strArray(body, "tags"),
  }) as TablesUpdate<"memories">;
  if (Object.keys(patch).length === 0) throw badRequest("no supported fields supplied");
  await updateMemory(db, session.user.id, id, patch);
  await audit(db, session, "web.memory_updated", "memory", id, patch);
  return json({ ok: true });
});

route("DELETE", "/api/memories/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "memory id");
  const forgotten = await forgetMemory(db, session.user.id, id);
  if (!forgotten) throw notFound("memory not found");
  await audit(db, session, "web.memory_forgotten", "memory", id, {});
  return json({ ok: true });
});

route("GET", "/api/facts", async ({ db, session }) => {
  return json({ items: await listUserFacts(db, session.user.id) });
});

route("PUT", "/api/facts", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const key = requiredStr(body, "key", 80);
  const fact = await upsertUserFact(
    db,
    session.user.id,
    key,
    requiredStr(body, "value", 2000),
    str(body, "category", 40) ?? "general"
  );
  await audit(db, session, "web.fact_set", "user", session.user.id, { key });
  return json({ item: fact });
});

route("DELETE", "/api/facts/:key", async ({ db, session, params }) => {
  const key = params.key ?? "";
  if (!key) throw badRequest("fact key is required");
  const deleted = await deleteUserFact(db, session.user.id, key);
  if (!deleted) throw notFound("fact not found");
  await audit(db, session, "web.fact_deleted", "user", session.user.id, { key });
  return json({ ok: true });
});

// ── Links ────────────────────────────────────────────────────────────────────

route("GET", "/api/links", async ({ db, session, url }) => {
  const items = await listLinks(db, session.user.id, {
    query: url.searchParams.get("q") ?? undefined,
    projectId: optionalUuidParam(url, "project_id"),
    tag: url.searchParams.get("tag") ?? undefined,
    limit: queryLimit(url, 30, 100),
  });
  return json({ items });
});

route("PATCH", "/api/links/:id", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "link id");
  const body = await readJsonBody(request);
  const patch = definedOnly({
    title: nullableStr(body, "title", 300),
    summary: nullableStr(body, "summary", 5000),
    project_id: uuid(body, "project_id"),
    tags: strArray(body, "tags"),
  }) as TablesUpdate<"links">;
  if (Object.keys(patch).length === 0) throw badRequest("no supported fields supplied");
  await updateLink(db, session.user.id, id, patch);
  await audit(db, session, "web.link_updated", "link", id, patch);
  return json({ ok: true });
});

route("DELETE", "/api/links/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "link id");
  const deleted = await deleteLink(db, session.user.id, id);
  if (!deleted) throw notFound("link not found");
  await audit(db, session, "web.link_deleted", "link", id, {});
  return json({ ok: true });
});

// ── Wallet ─────────────────────────────────────────────────────────────────────────

/** A single enum query param (direction=out), validated like statusesParam. */
function oneOfParam<T extends string>(url: URL, key: string, allowed: readonly T[]): T | undefined {
  const raw = url.searchParams.get(key);
  if (!raw) return undefined;
  if (!allowed.includes(raw as T)) throw badRequest(`${key} must be one of: ${allowed.join(', ')}`);
  return raw as T;
}

/** Required positive amount — money never arrives as "not supplied". */
function requiredNum(body: Record<string, unknown>, key: string): number {
  const value = num(body, key, 0.01, 1_000_000_000);
  if (value === undefined) throw badRequest(`${key} is required`);
  return value;
}

/** An ISO timestamp query param, or null when absent. */
function isoParam(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw badRequest(`${key} is not a valid timestamp`);
  return new Date(ms).toISOString();
}

/**
 * The window a wallet request covers: a named period on the user's own
 * calendar, which explicit from/to params may override one side at a time.
 */
function walletWindow(
  url: URL,
  timezone: string,
  now: Date
): { period: LocalPeriod; from: string | null; to: string | null } {
  const named = url.searchParams.get("period") ?? "month";
  if (!WALLET_PERIODS.includes(named as LocalPeriod)) {
    throw badRequest(`period must be one of: ${WALLET_PERIODS.join(', ')}`);
  }
  const range = localPeriodRange(named as LocalPeriod, timezone, now);
  return {
    period: range.period,
    from: isoParam(url, "from") ?? range.from,
    to: isoParam(url, "to") ?? range.to,
  };
}

route("GET", "/api/wallet/summary", async ({ db, session, url, now }) => {
  const window = walletWindow(url, session.user.timezone, now);
  const [totals, categories, currency] = await Promise.all([
    walletSummary(db, session.user.id, window),
    walletCategoryTotals(db, session.user.id, {
      direction: "out",
      from: window.from,
      to: window.to,
      limit: 12,
    }),
    walletCurrency(db, session.user.id),
  ]);
  return json({ ...window, currency, totals, categories });
});

route("PUT", "/api/wallet/currency", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const currency = await setWalletCurrency(db, session.user.id, requiredStr(body, "currency", 20));
  await audit(db, session, "web.wallet_currency_set", null, null, { currency });
  return json({ ok: true, currency });
});

route("GET", "/api/wallet", async ({ db, session, url, now }) => {
  const window = walletWindow(url, session.user.timezone, now);
  const tag = url.searchParams.get("tag");
  const items = await listWalletEntries(db, session.user.id, {
    direction: oneOfParam(url, "direction", WALLET_DIRECTIONS),
    category: url.searchParams.get("category") ?? undefined,
    query: url.searchParams.get("q") ?? undefined,
    tags: tag ? [tag] : undefined,
    projectId: optionalUuidParam(url, "project_id"),
    from: window.from,
    to: window.to,
    limit: queryLimit(url, 100, 500),
  });
  return json({ period: window.period, items });
});

route("POST", "/api/wallet", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const currency = str(body, "currency", 20);
  const entry = await createWalletEntry(db, {
    user_id: session.user.id,
    direction: oneOf(body, "direction", WALLET_DIRECTIONS) ?? "out",
    amount: requiredNum(body, "amount"),
    currency: currency
      ? normalizeCurrency(currency)
      : await walletCurrency(db, session.user.id),
    description: requiredStr(body, "description", 300),
    category: nullableStr(body, "category", 40) ?? null,
    quantity: num(body, "quantity", 0.001, 1_000_000) ?? null,
    unit: nullableStr(body, "unit", 20) ?? null,
    method: nullableStr(body, "method", 30) ?? null,
    occurred_at: isoDate(body, "occurred_at") ?? new Date().toISOString(),
    project_id: uuid(body, "project_id") ?? null,
    tags: strArray(body, "tags") ?? [],
    note: nullableStr(body, "note", 500) ?? null,
    source: "web",
  });
  await audit(db, session, "web.wallet_created", null, entry.id, {
    direction: entry.direction,
    amount: entry.amount,
    currency: entry.currency,
  });
  return json({ item: entry }, 201);
});

route("PATCH", "/api/wallet/:id", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "wallet entry id");
  const body = await readJsonBody(request);
  const currency = str(body, "currency", 20);
  const patch = definedOnly({
    direction: oneOf(body, "direction", WALLET_DIRECTIONS),
    amount: num(body, "amount", 0.01, 1_000_000_000),
    currency: currency === undefined ? undefined : normalizeCurrency(currency),
    description: str(body, "description", 300),
    category: nullableStr(body, "category", 40),
    quantity: num(body, "quantity", 0.001, 1_000_000),
    unit: nullableStr(body, "unit", 20),
    method: nullableStr(body, "method", 30),
    occurred_at: isoDate(body, "occurred_at"),
    project_id: uuid(body, "project_id"),
    tags: strArray(body, "tags"),
    note: nullableStr(body, "note", 500),
  }) as TablesUpdate<"wallet_entries">;
  if (Object.keys(patch).length === 0) throw badRequest("no supported fields supplied");
  const updated = await updateWalletEntry(db, session.user.id, id, patch);
  if (!updated) throw notFound("wallet entry not found");
  await audit(db, session, "web.wallet_updated", null, id, patch);
  return json({ ok: true });
});

route("DELETE", "/api/wallet/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "wallet entry id");
  const deleted = await deleteWalletEntry(db, session.user.id, id);
  if (!deleted) throw notFound("wallet entry not found");
  await audit(db, session, "web.wallet_deleted", null, id, {});
  return json({ ok: true });
});

// ── Skills, MCP servers, personalization ─────────────────────────────────────

route("GET", "/api/skills", async ({ db, session }) => {
  return json({ items: await listSkills(db, session.user.id, false) });
});

route("POST", "/api/skills", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const skill = await createSkill(db, {
    user_id: session.user.id,
    name: requiredStr(body, "name", 80),
    description: nullableStr(body, "description", 2000) ?? null,
    instructions: requiredStr(body, "instructions", 20_000),
    tools: strArray(body, "tools", 60) ?? [],
    enabled: bool(body, "enabled") ?? true,
    permission_level: oneOf(body, "permission_level", ["read", "write", "destructive", "external"] as const) ?? "write",
  });
  await audit(db, session, "web.skill_created", "skill", skill.id, { name: skill.name });
  return json({ item: skill }, 201);
});

route("PATCH", "/api/skills/:id", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "skill id");
  const body = await readJsonBody(request);
  const patch = definedOnly({
    name: str(body, "name", 80),
    description: nullableStr(body, "description", 2000),
    instructions: str(body, "instructions", 20_000),
    tools: strArray(body, "tools", 60),
    enabled: bool(body, "enabled"),
    permission_level: oneOf(body, "permission_level", ["read", "write", "destructive", "external"] as const),
  }) as TablesUpdate<"skills">;
  if (Object.keys(patch).length === 0) throw badRequest("no supported fields supplied");
  await updateSkill(db, session.user.id, id, patch);
  await audit(db, session, "web.skill_updated", "skill", id, patch);
  return json({ ok: true });
});

route("DELETE", "/api/skills/:id", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "skill id");
  const deleted = await deleteSkill(db, session.user.id, id);
  if (!deleted) throw notFound("skill not found (global skills cannot be deleted)");
  await audit(db, session, "web.skill_deleted", "skill", id, {});
  return json({ ok: true });
});

route("GET", "/api/mcp", async ({ db, session }) => {
  return json({ items: await listMcpServers(db, session.user.id, false) });
});

route("POST", "/api/mcp", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const url = requiredStr(body, "url", 2000);
  if (!/^https:\/\//i.test(url)) throw badRequest("MCP server url must be https");
  const server = await upsertMcpServer(db, {
    user_id: session.user.id,
    name: requiredStr(body, "name", 80),
    url,
    auth_header: nullableStr(body, "auth_header", 2000) ?? null,
    enabled: bool(body, "enabled") ?? true,
  });
  // auth_header is a credential: acknowledge the write without echoing it back.
  await audit(db, session, "web.mcp_upserted", "setting", server.id, { name: server.name });
  return json({ item: { ...server, auth_header: server.auth_header ? "***" : null } }, 201);
});

route("PATCH", "/api/mcp/:id", async ({ request, db, session, params }) => {
  const id = assertUuid(params.id ?? "", "mcp server id");
  const body = await readJsonBody(request);
  const url = str(body, "url", 2000);
  if (url !== undefined && !/^https:\/\//i.test(url)) throw badRequest("MCP server url must be https");
  const patch = definedOnly({
    url,
    enabled: bool(body, "enabled"),
    auth_header: nullableStr(body, "auth_header", 2000),
  }) as TablesUpdate<"mcp_servers">;
  if (Object.keys(patch).length === 0) throw badRequest("no supported fields supplied");
  await updateMcpServer(db, session.user.id, id, patch);
  await audit(db, session, "web.mcp_updated", "setting", id, { enabled: patch.enabled });
  return json({ ok: true });
});

route("DELETE", "/api/mcp/:name", async ({ db, session, params }) => {
  const name = params.name ?? "";
  if (!name) throw badRequest("mcp server name is required");
  const deleted = await deleteMcpServer(db, session.user.id, name);
  if (!deleted) throw notFound("mcp server not found");
  await audit(db, session, "web.mcp_deleted", "setting", null, { name });
  return json({ ok: true });
});

// ── MCP server access (docs/MCP_SERVER.md) ───────────────────────────────────
// The token that lets Claude Code / Codex drive this assistant. It is returned
// exactly once, at issue time; nothing stores it, so a lost token is replaced
// rather than recovered.

route("GET", "/api/mcp-access", async ({ url, db, session, now }) => {
  const access = await describeMcpAccess(db, session.user.id, now.getTime());
  return json({ ...access, endpoint: `${url.origin}/mcp` });
});

route("POST", "/api/mcp-access", async ({ request, env, url, db, session, now }) => {
  const body = await readJsonBody(request);
  const scope = oneOf(body, "scope", MCP_SCOPES) ?? "full";
  const ttlDays = num(body, "ttlDays", 1, 365) ?? MCP_DEFAULT_TTL_DAYS;
  const label = nullableStr(body, "label", 120) ?? null;

  const issued = await issueMcpToken(env, db, session.user, { scope, ttlDays, label }, now.getTime());
  await audit(db, session, "web.mcp_token_issued", "user", session.user.id, { scope, ttlDays });
  // The token is deliberately absent from the audit details above.
  return json({ ...issued, endpoint: `${url.origin}/mcp` }, 201);
});

route("DELETE", "/api/mcp-access", async ({ db, session }) => {
  const revoked = await revokeMcpToken(db, session.user.id);
  await audit(db, session, "web.mcp_token_revoked", "user", session.user.id, {});
  return json({ ok: true, revoked });
});

route("GET", "/api/prompt", async ({ db, session }) => {
  const [active, versions] = await Promise.all([
    getActiveSystemPrompt(db, session.user.id),
    listSystemPromptVersions(db, session.user.id, 20),
  ]);
  return json({ active, versions });
});

route("PUT", "/api/prompt", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const row = await setSystemPrompt(
    db,
    session.user.id,
    requiredStr(body, "content", 20_000),
    "user",
    str(body, "description", 300)
  );
  await audit(db, session, "web.prompt_set", "setting", row.id, { version: row.version });
  return json({ item: row });
});

route("DELETE", "/api/prompt", async ({ db, session }) => {
  const cleared = await clearSystemPrompt(db, session.user.id);
  await audit(db, session, "web.prompt_cleared", "setting", null, {});
  return json({ ok: true, cleared });
});

// ── Conversations & history ──────────────────────────────────────────────────

route("GET", "/api/conversations", async ({ db, session, url }) => {
  return json({ items: await listConversations(db, session.user.id, queryLimit(url, 20, 100)) });
});

route("GET", "/api/conversations/:id/messages", async ({ db, session, params, url }) => {
  const id = assertUuid(params.id ?? "", "conversation id");
  // recentMessages does not filter by user, so confirm ownership first.
  const owned = (await listConversations(db, session.user.id, 100)).some((c) => c.id === id);
  if (!owned) throw notFound("conversation not found");
  return json({ items: await recentMessages(db, id, queryLimit(url, 50, 200)) });
});

route("POST", "/api/conversations", async ({ request, db, session }) => {
  const body = await readJsonBody(request);
  const conversation = await startNewConversation(
    db,
    session.user.id,
    nullableStr(body, "title", 200) ?? null,
    uuid(body, "project_id") ?? null
  );
  await audit(db, session, "web.conversation_started", "conversation", conversation.id, {});
  return json({ item: conversation }, 201);
});

route("POST", "/api/conversations/:id/activate", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "conversation id");
  const conversation = await switchConversation(db, session.user.id, id);
  if (!conversation) throw notFound("conversation not found");
  return json({ item: conversation });
});

route("POST", "/api/conversations/:id/archive", async ({ db, session, params }) => {
  const id = assertUuid(params.id ?? "", "conversation id");
  await archiveConversation(db, session.user.id, id);
  await audit(db, session, "web.conversation_archived", "conversation", id, {});
  return json({ ok: true });
});

// ── Search, audit, usage ─────────────────────────────────────────────────────

route("GET", "/api/search", async ({ db, session, url }) => {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) throw badRequest("q is required");
  // Keyword-only: computing a query embedding here would spend a model call on
  // every keystroke. hybrid_search degrades to keyword when given a null vector.
  const hits = await hybridSearch(db, session.user.id, q, {
    embedding: null,
    kinds: statusesParam(url, "kinds", ENTITY_KINDS) as Enums<"entity_kind">[] | undefined,
    limit: queryLimit(url, 25, 50),
  });
  return json({ items: hits });
});

route("GET", "/api/audit", async ({ db, session, url }) => {
  return json({ items: await listAudit(db, session.user.id, queryLimit(url, 50, 200)) });
});

route("GET", "/api/usage", async ({ db, session, url, now }) => {
  const days = Math.min(90, Math.max(1, Number.parseInt(url.searchParams.get("days") ?? "7", 10) || 7));
  const since = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
  const [total, recent] = await Promise.all([
    usageSince(db, session.user.id, since),
    recentRuns(db, session.user.id, 50),
  ]);
  return json({ days, total, recent });
});

// ── System control ───────────────────────────────────────────────────────────

route("GET", "/api/system", async ({ env, db, session }) => {
  const [mcp, prompt] = await Promise.all([
    listMcpServers(db, session.user.id, false),
    getActiveSystemPrompt(db, session.user.id),
  ]);
  return json({
    ...systemSummary(env),
    mcpServers: mcp.map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      last_connected_at: s.last_connected_at,
      last_error: s.last_error,
    })),
    promptVersion: prompt?.version ?? null,
  });
});

/** Run the reminder dispatcher immediately instead of waiting for the cron minute. */
route("POST", "/api/system/dispatch", async ({ env, db, session }) => {
  const stats = await dispatchTick(env);
  await audit(db, session, "web.dispatch_triggered", null, null, { ...stats });
  return json({ ok: true, ...stats });
});

/** Re-enter the agent for a routine; its output lands in the user's Telegram chat. */
route("POST", "/api/system/routine", async ({ request, env, db, session }) => {
  const body = await readJsonBody(request);
  const template = oneOf(body, "template", ["daily_brief", "heartbeat"] as const) ?? "daily_brief";
  const stub = await getAgentByName(env.UserAgent, agentNameFor(session));
  const sent = await stub.runScheduledRoutine(session.user.id, template);
  await audit(db, session, "web.routine_triggered", null, null, { template, sent });
  return json({ ok: true, template, sent });
});

/**
 * POST /api/chat — hand a message to the agent exactly as if it arrived from
 * the chat channel the session belongs to. The reply is delivered there (that
 * is where the conversation lives); the dashboard only confirms that the turn
 * was accepted.
 */
route("POST", "/api/chat", async ({ request, env, db, session, waitUntil, now }) => {
  const body = await readJsonBody(request);
  const text = requiredStr(body, "text", 4000);
  const commandMatch = text.match(/^\/([a-z0-9_]+)(?:\s+([\s\S]*))?$/i);

  const msg: IncomingMessage = {
    channel: session.identity.channel,
    // Prefixed so it can never collide with a real channel update id in the
    // DO's dedup table.
    updateId: `web-${now.getTime()}-${Math.random().toString(36).slice(2, 10)}`,
    externalUserId: session.identity.external_id,
    externalChatId: session.chatRef,
    username: session.identity.username ?? undefined,
    displayName: session.user.display_name ?? undefined,
    kind: commandMatch ? "command" : "text",
    text,
    command: commandMatch
      ? { name: (commandMatch[1] ?? "").toLowerCase(), args: (commandMatch[2] ?? "").trim() }
      : undefined,
    media: [],
    urls: [],
    isForward: false,
    timestamp: Math.floor(now.getTime() / 1000),
  };

  const stub = await getAgentByName(env.UserAgent, agentNameFor(session));
  // The turn can outlive this response; the answer arrives in Telegram either way.
  waitUntil(
    stub.ingest(msg).catch((err: unknown) => {
      log("error", "web.chat_dispatch_failed", { error: formatError(err) });
    })
  );
  await audit(db, session, "web.chat_sent", "conversation", null, { kind: msg.kind });
  return json({ ok: true, deliveredTo: session.identity.channel, kind: msg.kind }, 202);
});

// ── Shared helpers ───────────────────────────────────────────────────────────

function agentNameFor(session: WebSession): string {
  return `u:${session.identity.channel}:${session.identity.external_id}`;
}

/** Model/provider snapshot. Endpoints are shown; keys never leave the worker. */
function systemSummary(env: Env): Record<string, unknown> {
  try {
    const config = loadConfig(env);
    const role = (r: { kind: string; model: string; baseURL?: string }) => ({
      kind: r.kind,
      model: r.model,
      baseURL: "baseURL" in r ? r.baseURL : undefined,
    });
    return {
      ok: true,
      preset: env.LLM_PRESET ?? null,
      main: role(config.llm.main),
      classifier: role(config.llm.classifier),
      embeddings: { ...role(config.embeddings), dims: config.embeddings.dims },
      stt: role(config.stt),
      vision: config.llm.vision ? role(config.llm.vision) : null,
      defaults: config.defaults,
      limits: config.limits,
      r2Enabled: config.r2Enabled,
      searchConfigured: Boolean(config.searchApiKey),
    };
  } catch (err) {
    // A misconfigured worker must still render a dashboard that says why.
    return { ok: false, error: formatError(err) };
  }
}

function audit(
  db: Db,
  session: WebSession,
  action: string,
  entityKind: Enums<"entity_kind"> | null,
  entityId: string | null,
  details: Record<string, unknown>
): Promise<void> {
  return insertAudit(db, {
    user_id: session.user.id,
    actor: "user",
    action,
    entity_kind: entityKind,
    entity_id: entityId,
    // Values are already validated scalars; JSON.parse/stringify strips undefined.
    details: JSON.parse(JSON.stringify(details ?? {})),
  });
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Dispatch one /api request. Auth is enforced here, once, for every route
 * except the two that necessarily precede a session.
 */
export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  db: Db,
  session: WebSession | null,
  waitUntil: (p: Promise<unknown>) => void
): Promise<Response> {
  const now = new Date();
  const method = request.method.toUpperCase();

  if (!SAFE_METHODS.has(method)) assertSameOrigin(request, url, parseAllowedOrigins(env.ALLOWED_ORIGINS));

  // Pre-session routes.
  if (url.pathname === "/api/auth/request" && method === "POST") {
    return handleLoginRequest(env, db, url, now.getTime());
  }
  // Redeeming is POST-only so no prefetcher can spend a login nonce.
  if (url.pathname === "/api/auth/redeem" && method === "POST") {
    return handleLoginRedeem(request, env, db, url, now.getTime());
  }
  if (url.pathname === "/api/auth/logout" && method === "POST") {
    return handleLogout(url);
  }
  // Opened as the bot's Mini App: Telegram already vouched for the account, so
  // the signed initData stands in for a login link.
  if (url.pathname === "/api/auth/miniapp" && method === "POST") {
    return handleMiniAppLogin(request, env, db, url, now.getTime());
  }
  if (url.pathname === "/api/session") {
    return json(
      session
        ? { signedIn: true, user: { id: session.user.id, display_name: session.user.display_name, role: session.user.role } }
        : { signedIn: false }
    );
  }

  const active = requireSession(session);
  // Viewers may read, but never write (mirrors roleAllowsPermission).
  if (!SAFE_METHODS.has(method) && active.user.role === "viewer") {
    throw new HttpError(403, "your role is read-only");
  }

  let methodMismatch = false;
  for (const [routeMethod, pattern, handler] of routes) {
    const params = matchPath(pattern, url.pathname);
    if (!params) continue;
    if (routeMethod !== method) {
      methodMismatch = true;
      continue;
    }
    return handler({ request, env, url, db, session: active, params, now, waitUntil });
  }
  if (methodMismatch) throw new HttpError(405, `${method} is not supported on ${url.pathname}`);
  throw notFound(`no API route for ${url.pathname}`);
}
