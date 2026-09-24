/**
 * Deterministic slash-command handlers — never call the main LLM.
 */
import type { AgentContext } from "./context";
import { t, resolveLocale, type Locale } from "../i18n";
import {
  archiveConversation,
  listConversations,
  startNewConversation,
  switchConversation,
} from "../database/repos/conversations";
import { usageSince } from "../database/repos/runs";
import { updateUser } from "../database/repos/users";
import { insertReminder, listReminders, updateReminder } from "../database/repos/reminders";
import { insertAudit } from "../database/repos/audit";
import { listTasks } from "../database/repos/tasks";
import { findProject, listProjects, projectSummary } from "../database/repos/projects";
import { listNotes } from "../database/repos/notes";
import { countPendingInbox, listPendingInbox } from "../database/repos/inbox";
import { listRecentFiles, searchFiles } from "../database/repos/files";
import { createMemory, listMemories, listUserFacts, setMemoryEmbedding } from "../database/repos/memories";
import { listLinks } from "../database/repos/links";
import { setWalletCurrency } from "../database/repos/wallet";
import { listMcpServers, listSkills } from "../database/repos/skills";
import { embedText } from "../services/llm/embeddings";
import { nextOccurrence } from "../scheduler/rrule";
import { runDailyBrief, runHeartbeat } from "../workflows/daily-brief";
import { clearPendingCallbacks } from "./confirmations";
import { issueLoginLink, publicBaseUrl } from "../web/auth";
import {
  describeMcpAccess,
  issueMcpToken,
  revokeMcpToken,
  type McpScope,
} from "../mcp/server/tokens";
import {
  forceLocalOffset,
  guessTimezoneFromLocalTime,
  isValidTimezone,
  parseLocalPeriod,
  type LocalPeriod,
} from "../scheduler/tz";
import { formatDateTime } from "../i18n";
import { formatFileSize, normalizeTags, truncate } from "../utils/text";
import { formatInTimeZone } from "date-fns-tz";
import { parseListArgs, sendList, type ListState } from "./lists";
import "./details"; // registers the detail-card callback handler
import { connectVaultChannel, ensureDefaultVault, syncVaultChannel } from "../services/storage/vault";
import { findVault } from "../database/repos/vaults";

const NEWLINE = String.fromCharCode(10);

/** YYYY-MM-DD of a moment in the user's timezone. */
function formatDateInTz(date: Date, timezone: string): string {
  return formatInTimeZone(date, timezone, "yyyy-MM-dd");
}

type CommandHandler = (ctx: AgentContext, args: string) => Promise<void>;

const handlers: Record<string, CommandHandler> = {
  start: cmdStart,
  help: cmdHelp,
  status: cmdStatus,
  settings: cmdSettings,
  context: cmdContext,
  newchat: cmdNewChat,
  contexts: cmdContexts,
  archive: cmdArchive,
  cancel: cmdCancel,
  tz: cmdTz,
  reminders: cmdReminders,
  tasks: cmdTasks,
  today: cmdToday,
  projects: cmdProjects,
  project: cmdProject,
  notes: cmdNotes,
  inbox: cmdInbox,
  files: cmdFiles,
  find: cmdFind,
  search: cmdFind,
  memory: cmdMemory,
  remember: cmdRemember,
  links: cmdLinks,
  brief: cmdBrief,
  heartbeat: cmdHeartbeat,
  skills: cmdSkills,
  mcp: cmdMcp,
  connect: cmdConnect,
  dashboard: cmdDashboard,
  wallet: cmdWallet,
  tags: cmdTags,
  tag: cmdTag,
  vault: cmdVault,
};

/** Names of every registered slash command (used to keep the Telegram menu in sync). */
export function listCommandNames(): string[] {
  return Object.keys(handlers);
}

/** Feature phases register more commands (tasks, projects, files …). */
export function registerCommand(name: string, handler: CommandHandler): void {
  handlers[name] = handler;
}

export async function handleCommand(ctx: AgentContext, name: string, args: string): Promise<void> {
  const handler = handlers[name];
  if (!handler) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "unknown_command", { command: name }));
    return;
  }
  await handler(ctx, args.trim());
  await insertAudit(ctx.db, {
    user_id: ctx.user.id,
    actor: "user",
    action: `command:${name}`,
  });
}

async function cmdStart(ctx: AgentContext): Promise<void> {
  let text = t(ctx.locale, "start_welcome");
  if (!ctx.user.tz_confirmed) {
    text += `\n\n${t(ctx.locale, "tz_prompt")}`;
  }
  await ctx.out.sendText(ctx.chatRef, text);
}

async function cmdHelp(ctx: AgentContext): Promise<void> {
  await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "help_text"));
}

/**
 * Send a one-time sign-in link for the web dashboard. Telegram has already
 * proved who the sender is, so the DM itself is the authentication factor.
 */
/**
 * /connect — mint (or revoke) the bearer token that lets Claude Code, Codex or
 * any other MCP client drive this assistant. See docs/MCP_SERVER.md.
 *
 * Telegram is the delivery channel for the same reason it is for the dashboard
 * link: possession of this chat is the credential. The reply is plain text with
 * previews off — the token must not be parsed as Markdown, nor fetched by a
 * preview crawler.
 */
async function cmdConnect(ctx: AgentContext, args: string): Promise<void> {
  const arg = args.trim().toLowerCase();
  const say = (text: string) =>
    ctx.out.sendText(ctx.chatRef, text, { markdown: false, disablePreview: true });

  if (arg === "off" || arg === "revoke" || arg === "stop") {
    const had = await revokeMcpToken(ctx.db, ctx.user.id);
    await say(
      had
        ? "MCP access revoked. Every token issued before now stops working immediately."
        : "There is no MCP token to revoke."
    );
    return;
  }

  if (arg === "status") {
    const access = await describeMcpAccess(ctx.db, ctx.user.id, ctx.now.getTime());
    await say(
      access.active
        ? "MCP access is ON (scope: " + access.scope + ", expires " + access.expiresAt + ")." + NEWLINE +
          "The token itself was shown once and is not stored — /connect issues a new one."
        : "MCP access is off. /connect issues a token."
    );
    return;
  }

  if (arg !== "" && arg !== "read" && arg !== "full") {
    await say("Usage: /connect [read|full] · /connect status · /connect off");
    return;
  }

  const baseUrl = await publicBaseUrl(ctx.env);
  if (!baseUrl) {
    await say(
      "I don't know my own public URL yet. Register the webhook (or set PUBLIC_BASE_URL) and try again."
    );
    return;
  }

  // A read-only role can only ever hold a read-only token.
  const scope: McpScope = ctx.user.role === "viewer" || arg === "read" ? "read" : "full";
  const issued = await issueMcpToken(ctx.env, ctx.db, ctx.user, { scope }, ctx.now.getTime());
  const endpoint = baseUrl + "/mcp";

  await say(
    [
      "MCP access token — scope " +
        scope +
        (scope === "read" ? " (read-only tools)" : " (every tool your role allows, plus ask_assistant)") +
        ", expires " +
        issued.expiresAt.slice(0, 10) +
        ".",
      "This replaces any token issued before it. Treat it like a password.",
      "",
      "Claude Code:",
      "claude mcp add --transport http personxai " +
        endpoint +
        ' --header "Authorization: Bearer ' +
        issued.token +
        '"',
      "",
      "Codex — put the token in PERSONXAI_TOKEN, then in ~/.codex/config.toml:",
      "[mcp_servers.personxai]",
      'url = "' + endpoint + '"',
      'bearer_token_env_var = "PERSONXAI_TOKEN"',
      "",
      "Token:",
      issued.token,
      "",
      "/connect read — read-only token · /connect off — revoke · /connect status",
    ].join(NEWLINE)
  );
}

async function cmdDashboard(ctx: AgentContext): Promise<void> {
  const baseUrl = await publicBaseUrl(ctx.env);
  if (!baseUrl) {
    await ctx.out.sendText(
      ctx.chatRef,
      "I don't know my own public URL yet. Register the webhook (or set PUBLIC_BASE_URL) and try again."
    );
    return;
  }
  // issueLoginLink sends the link itself; only the refusal needs a reply here.
  const result = await issueLoginLink(
    ctx.env,
    ctx.db,
    ctx.user,
    ctx.channel,
    ctx.chatRef,
    baseUrl,
    ctx.now.getTime()
  );
  if (!result.sent) {
    await ctx.out.sendText(ctx.chatRef, result.reason ?? "Could not send a sign-in link right now.");
  }
}

async function cmdStatus(ctx: AgentContext): Promise<void> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const usage = await usageSince(ctx.db, ctx.user.id, since);
  const lines = [
    t(ctx.locale, "status_header"),
    t(ctx.locale, "status_line_runs", {
      runs: usage.runs,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      period: "24h",
    }),
    t(ctx.locale, "status_line_context", {
      title: ctx.conversation.title ?? t(ctx.locale, "conversation_default_title"),
    }),
    t(ctx.locale, "status_line_autonomy", { level: ctx.user.autonomy_level }),
    t(ctx.locale, "status_line_timezone", { timezone: ctx.user.timezone }),
    t(ctx.locale, "status_line_language", { language: ctx.user.language }),
    t(ctx.locale, "status_line_model", { model: ctx.config.llm.main.model }),
  ];
  await ctx.out.sendText(ctx.chatRef, lines.join("\n"));
}

const SETTABLE_KEYS = ["timezone", "language", "autonomy"] as const;

async function cmdSettings(ctx: AgentContext, args: string): Promise<void> {
  if (!args) {
    const lines = [
      t(ctx.locale, "settings_header"),
      t(ctx.locale, "settings_line", { key: "timezone", value: ctx.user.timezone }),
      t(ctx.locale, "settings_line", { key: "language", value: ctx.user.language }),
      t(ctx.locale, "settings_line", { key: "autonomy", value: ctx.user.autonomy_level }),
      "",
      t(ctx.locale, "settings_usage"),
    ];
    await ctx.out.sendText(ctx.chatRef, lines.join("\n"));
    return;
  }
  // accept both "/settings key value" and "/settings set key value"
  const match = args.match(/^(?:set\s+)?(\S+)\s+([\s\S]+)$/i);
  if (!match) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "settings_usage"));
    return;
  }
  const key = (match[1] ?? "").toLowerCase();
  const value = (match[2] ?? "").trim();
  if (!SETTABLE_KEYS.includes(key as (typeof SETTABLE_KEYS)[number])) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "setting_unknown", { key }));
    return;
  }
  if (key === "timezone") {
    await cmdTz(ctx, value);
    return;
  }
  if (key === "language") {
    const locale: Locale = resolveLocale(value);
    await updateUser(ctx.db, ctx.user.id, { language: locale });
    await ctx.out.sendText(ctx.chatRef, t(locale, "language_set", { language: locale }));
    return;
  }
  if (key === "autonomy") {
    const level = Number.parseInt(value, 10);
    if (!Number.isInteger(level) || level < 0 || level > 3) {
      await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "setting_unknown", { key: `autonomy ${value}` }));
      return;
    }
    await updateUser(ctx.db, ctx.user.id, { autonomy_level: level });
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "setting_updated", { key: `autonomy=${level}` }));
  }
}

async function cmdContext(ctx: AgentContext, args: string): Promise<void> {
  if (!args) {
    await cmdContexts(ctx);
    return;
  }
  const found = await switchConversation(ctx.db, ctx.user.id, args);
  if (!found) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "context_not_found", { query: args }));
    return;
  }
  await ctx.out.sendText(
    ctx.chatRef,
    t(ctx.locale, "context_switched", {
      title: found.title ?? t(ctx.locale, "conversation_default_title"),
    })
  );
}

async function cmdNewChat(ctx: AgentContext, args: string): Promise<void> {
  const title = args || null;
  const conv = await startNewConversation(ctx.db, ctx.user.id, title);
  await ctx.out.sendText(
    ctx.chatRef,
    t(ctx.locale, "newchat_created", {
      title: conv.title ?? t(ctx.locale, "conversation_default_title"),
    })
  );
}

async function cmdContexts(ctx: AgentContext): Promise<void> {
  const rows = await listConversations(ctx.db, ctx.user.id, 10);
  if (rows.length === 0) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "contexts_empty"));
    return;
  }
  const lines = [t(ctx.locale, "contexts_header")];
  for (const c of rows) {
    const marker = c.is_active ? "▸ " : "· ";
    lines.push(`${marker}${c.title ?? t(ctx.locale, "conversation_default_title")}`);
  }
  await ctx.out.sendText(ctx.chatRef, lines.join("\n"));
}

async function cmdArchive(ctx: AgentContext): Promise<void> {
  await archiveConversation(ctx.db, ctx.user.id, ctx.conversation.id);
  await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "cancelled"));
}

async function cmdCancel(ctx: AgentContext): Promise<void> {
  const n = clearPendingCallbacks(ctx.do, ctx.now.getTime());
  await ctx.out.sendText(
    ctx.chatRef,
    n > 0 ? t(ctx.locale, "cancelled") : t(ctx.locale, "nothing_to_cancel")
  );
}

async function cmdTz(ctx: AgentContext, args: string): Promise<void> {
  if (!args) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "tz_prompt"));
    return;
  }
  let tz: string | null = null;
  if (isValidTimezone(args)) {
    tz = args;
  } else if (/^\d{1,2}:\d{2}$/.test(args)) {
    tz = guessTimezoneFromLocalTime(args);
  }
  if (!tz) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "tz_invalid"));
    return;
  }
  await updateUser(ctx.db, ctx.user.id, { timezone: tz, tz_confirmed: true });
  await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "tz_saved", { timezone: tz }));
}

const PRIORITY_ICON: Record<string, string> = { critical: "🔴", high: "🟠", medium: "▫️", low: "▪️" };

function taskLine(ctx: AgentContext, task: import("../database/types").TaskRow): string {
  const icon = PRIORITY_ICON[task.priority] ?? "▫️";
  const due = task.due_at ? ` — ${formatDateTime(task.due_at, ctx.user.timezone, ctx.locale)}` : "";
  return `${icon} ${task.title}${due}`;
}

async function cmdTasks(ctx: AgentContext, args: string): Promise<void> {
  await sendList(ctx, { k: "tasks", p: 0, ...parseListArgs(args) });
}

async function cmdToday(ctx: AgentContext): Promise<void> {
  await sendList(ctx, { k: "today", p: 0 });
}

const STATUS_ICON: Record<string, string> = {
  idea: "💡",
  planned: "🗓",
  active: "🟢",
  waiting: "⏸",
  blocked: "⛔",
  completed: "✅",
  archived: "📦",
};

async function cmdProjects(ctx: AgentContext, args: string): Promise<void> {
  await sendList(ctx, { k: "projects", p: 0, ...parseListArgs(args) });
}

async function cmdProject(ctx: AgentContext, args: string): Promise<void> {
  if (!args) {
    await cmdProjects(ctx, "");
    return;
  }
  const project = await findProject(ctx.db, ctx.user.id, args);
  if (!project) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "project_not_found", { query: args }));
    return;
  }
  const summary = await projectSummary(ctx.db, ctx.user.id, project);
  const lines = [
    `${STATUS_ICON[project.status] ?? "·"} *${project.name}*`,
    ...(project.description ? [project.description] : []),
    `${project.status} · ${project.priority} · ${project.progress}%`,
    ...(project.due_date ? [`⏳ ${project.due_date}`] : []),
    `☑️ ${summary.openTasks} open / ${summary.doneTasks} done · 📝 ${summary.notes}`,
    ...(project.tags.length > 0 ? [project.tags.map((tag) => `#${tag}`).join(" ")] : []),
  ];
  await ctx.out.sendText(ctx.chatRef, lines.join("\n"));
}

async function cmdNotes(ctx: AgentContext, args: string): Promise<void> {
  await sendList(ctx, { k: "notes", p: 0, ...parseListArgs(args) });
}

async function cmdInbox(ctx: AgentContext): Promise<void> {
  await sendList(ctx, { k: "inbox", p: 0 });
}

const KIND_ICON: Record<string, string> = {
  document: "📄",
  photo: "🖼",
  video: "🎬",
  animation: "🎞",
  audio: "🎵",
  voice: "🎤",
  video_note: "📹",
  sticker: "🏷",
};

function fileLine(ctx: AgentContext, f: import("../database/types").FileRow): string {
  const icon = KIND_ICON[f.media_kind ?? "document"] ?? "📄";
  const size = f.file_size ? ` · ${formatFileSize(f.file_size)}` : "";
  return `${icon} ${f.file_name}${size}`;
}

async function cmdFiles(ctx: AgentContext, args: string): Promise<void> {
  const parsed = parseListArgs(args);
  if (parsed.ch) {
    // `/files in:research` — resolve a channel by title/category to its chat id.
    const vault = await findVault(ctx.db, ctx.user.id, parsed.ch);
    parsed.ch = vault?.chat_id ?? parsed.ch;
  }
  await sendList(ctx, { k: "files", p: 0, ...parsed });
}

/** /find <text> — one shot across files, tasks, notes, and projects. */
/** /find <text> — one shot across everything; `/find #tag` lists everything carrying the tag. */
async function cmdFind(ctx: AgentContext, args: string): Promise<void> {
  const parsed = parseListArgs(args);
  if (parsed.tg?.length && !parsed.q) {
    await sendList(ctx, { k: "tagged", p: 0, tg: parsed.tg, by: parsed.by ?? "kind", kd: parsed.kd });
    return;
  }
  if (!parsed.q) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "find_usage"));
    return;
  }
  await sendList(ctx, { k: "find", p: 0, q: parsed.q, by: parsed.by ?? "kind" });
}

async function cmdMemory(ctx: AgentContext, args: string): Promise<void> {
  const parsed = parseListArgs(args);
  if (!args.trim()) {
    // Facts are short and few: show them above the paginated memory list.
    const facts = await listUserFacts(ctx.db, ctx.user.id).catch(() => []);
    if (facts.length > 0) {
      const lines = [t(ctx.locale, "memory_facts_header"), ...facts.map((f) => "· " + f.key + ": " + f.value)];
      await ctx.out.sendText(ctx.chatRef, lines.join(NEWLINE));
    }
  }
  await sendList(ctx, { k: "memory", p: 0, ...parsed });
}

/** /remember <text> — deterministic capture, no LLM round trip. */
async function cmdRemember(ctx: AgentContext, args: string): Promise<void> {
  if (!args) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "remember_usage"));
    return;
  }
  const row = await createMemory(ctx.db, {
    user_id: ctx.user.id,
    content: args,
    memory_type: "fact",
    importance: 3,
  });
  ctx.waitUntil(
    embedText(args, ctx.config.embeddings, ctx.env)
      .then((vec) => (vec ? setMemoryEmbedding(ctx.db, ctx.user.id, row.id, vec) : undefined))
      .catch(() => {})
  );
  await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "memory_saved", { content: truncate(args, 80) }));
}

async function cmdLinks(ctx: AgentContext, args: string): Promise<void> {
  await sendList(ctx, { k: "links", p: 0, ...parseListArgs(args) });
}

/**
 * /wallet — the ledger as a page: period totals in the header, one line per
 * entry, tap a line for its card. Bare words are understood so the command
 * reads like speech: `/wallet week out #food`, `/wallet all cat:rent`.
 * `/wallet currency EGP` sets what new entries default to.
 */
async function cmdWallet(ctx: AgentContext, args: string): Promise<void> {
  const tokens = args.split(/\s+/).filter(Boolean);
  const head = tokens[0]?.toLowerCase();
  if (head === "currency" || head === "cur") {
    const requested = tokens[1];
    if (!requested) {
      await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "wallet_usage"));
      return;
    }
    const currency = await setWalletCurrency(ctx.db, ctx.user.id, requested);
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "wallet_currency_set", { currency }));
    return;
  }

  let period: LocalPeriod | undefined;
  let direction: string | undefined;
  const rest: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const named = parseLocalPeriod(lower);
    if (named && !period) {
      period = named;
      continue;
    }
    if ((lower === "in" || lower === "out") && !direction) {
      direction = lower;
      continue;
    }
    rest.push(token);
  }
  const parsed = parseListArgs(rest.join(" "));
  await sendList(ctx, {
    k: "wallet",
    p: 0,
    ...parsed,
    ...(period ? { pd: period } : {}),
    ...(direction ? { st: direction } : {}),
  });
}

/** Find (or clear) the user's dynamic routine reminder for a template. */
async function findRoutine(ctx: AgentContext, templateId: string) {
  const rows = await listReminders(ctx.db, ctx.user.id, ["scheduled", "active", "paused"]);
  return rows.find((r) => r.kind === "dynamic" && r.template_id === templateId) ?? null;
}

async function scheduleRoutine(
  ctx: AgentContext,
  templateId: string,
  rule: string
): Promise<void> {
  const next = nextOccurrence(rule, { after: ctx.now, anchor: ctx.now, timezone: ctx.user.timezone });
  const existing = await findRoutine(ctx, templateId);
  if (existing) {
    await updateReminder(ctx.db, ctx.user.id, existing.id, {
      status: "active",
      recurrence_rule: rule,
      timezone: ctx.user.timezone,
      next_trigger_at: next ? next.toISOString() : null,
    });
    return;
  }
  await insertReminder(ctx.db, {
    user_id: ctx.user.id,
    kind: "dynamic",
    status: "active",
    template_id: templateId,
    recurrence_rule: rule,
    timezone: ctx.user.timezone,
    start_at: ctx.now.toISOString(),
    next_trigger_at: next ? next.toISOString() : null,
  });
}

async function cancelRoutine(ctx: AgentContext, templateId: string): Promise<boolean> {
  const existing = await findRoutine(ctx, templateId);
  if (!existing) return false;
  await updateReminder(ctx.db, ctx.user.id, existing.id, {
    status: "cancelled",
    next_trigger_at: null,
  });
  return true;
}

/** /brief on HH:MM | off | now */
async function cmdBrief(ctx: AgentContext, args: string): Promise<void> {
  const arg = args.trim().toLowerCase();
  if (arg === "now" || arg === "") {
    const sent = await runDailyBrief(ctx);
    if (!sent && arg === "") await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "brief_usage"));
    return;
  }
  if (arg === "off") {
    const had = await cancelRoutine(ctx, "daily_brief");
    await ctx.out.sendText(
      ctx.chatRef,
      had ? t(ctx.locale, "brief_disabled") : t(ctx.locale, "brief_usage")
    );
    return;
  }
  const match = arg.match(/^on(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!match) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "brief_usage"));
    return;
  }
  const hour = Number.parseInt(match[1] ?? "8", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (hour > 23 || minute > 59) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "brief_usage"));
    return;
  }
  const time = String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
  await scheduleRoutine(ctx, "daily_brief", "FREQ=DAILY;BYHOUR=" + hour + ";BYMINUTE=" + minute);
  await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "brief_enabled", { time }));
}

/** /heartbeat on <hours> | off | now */
async function cmdHeartbeat(ctx: AgentContext, args: string): Promise<void> {
  const arg = args.trim().toLowerCase();
  if (arg === "now") {
    const sent = await runHeartbeat(ctx);
    if (!sent) await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "brief_all_clear"));
    return;
  }
  if (arg === "off") {
    const had = await cancelRoutine(ctx, "heartbeat");
    await ctx.out.sendText(
      ctx.chatRef,
      had ? t(ctx.locale, "heartbeat_disabled") : t(ctx.locale, "heartbeat_usage")
    );
    return;
  }
  const match = arg.match(/^on(?:\s+(\d{1,2}))?$/);
  if (!match) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "heartbeat_usage"));
    return;
  }
  const hours = Math.min(Math.max(Number.parseInt(match[1] ?? "4", 10), 1), 12);
  // Waking hours only: no pings between 23:00 and 08:00 local.
  await scheduleRoutine(ctx, "heartbeat", "FREQ=HOURLY;INTERVAL=" + hours + ";BYHOUR=8,10,12,14,16,18,20,22");
  await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "heartbeat_enabled", { hours }));
}

async function cmdSkills(ctx: AgentContext): Promise<void> {
  const rows = await listSkills(ctx.db, ctx.user.id);
  if (rows.length === 0) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "skills_empty"));
    return;
  }
  const lines = [t(ctx.locale, "skills_header")];
  for (const s of rows) {
    const mark = s.enabled ? "🟢" : "⚪";
    lines.push(mark + " " + s.name + (s.description ? " — " + truncate(s.description, 60) : ""));
  }
  await ctx.out.sendText(ctx.chatRef, lines.join(NEWLINE));
}

async function cmdMcp(ctx: AgentContext): Promise<void> {
  const rows = await listMcpServers(ctx.db, ctx.user.id, false);
  if (rows.length === 0) {
    await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "mcp_empty"));
    return;
  }
  const lines = [t(ctx.locale, "mcp_header")];
  for (const s of rows) {
    const mark = !s.enabled ? "⚪" : s.last_error ? "🔴" : "🟢";
    lines.push(mark + " " + s.name + (s.last_error ? " — " + truncate(s.last_error, 60) : ""));
  }
  await ctx.out.sendText(ctx.chatRef, lines.join(NEWLINE));
}

async function cmdReminders(ctx: AgentContext, args: string): Promise<void> {
  await sendList(ctx, { k: "reminders", p: 0, ...parseListArgs(args) });
}

/** /tags — every tag with per-kind counts; tap one to see what carries it. */
async function cmdTags(ctx: AgentContext): Promise<void> {
  await sendList(ctx, { k: "tags", p: 0 });
}

/** /tag <name> [kind:file] — everything carrying a tag (same as /find #name). */
async function cmdTag(ctx: AgentContext, args: string): Promise<void> {
  const parsed = parseListArgs(args.replace(/(^|\s)(?!#)([^\s#:]+)/g, "$1#$2"));
  if (!parsed.tg?.length) {
    await cmdTags(ctx);
    return;
  }
  await sendList(ctx, { k: "tagged", p: 0, tg: parsed.tg, by: parsed.by ?? "kind", kd: parsed.kd });
}

/**
 * /vault                    list connected channels (tap for details / default / sync / remove)
 * /vault add <-100id> [category] [#tags]
 * /vault sync               re-read every channel description
 */
async function cmdVault(ctx: AgentContext, args: string): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (!sub) {
    await sendList(ctx, { k: "vaults", p: 0 });
    return;
  }
  if (sub.toLowerCase() === "add") {
    const chatId = rest[0] ?? "";
    if (!/^-100\d+$/.test(chatId)) {
      await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "vault_usage"));
      return;
    }
    const tags = normalizeTags(rest.filter((x) => x.startsWith("#")).map((x) => x.slice(1)));
    const category = rest.slice(1).filter((x) => !x.startsWith("#")).join(" ") || null;
    const result = await connectVaultChannel(ctx.env, ctx.db, ctx.user.id, chatId, { category, tags });
    if ("error" in result) {
      await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "vault_connect_failed", { reason: result.error }));
      return;
    }
    await ctx.out.sendText(
      ctx.chatRef,
      t(ctx.locale, "vault_connected", {
        title: result.row.title ?? chatId,
        category: result.row.category ?? "—",
        tags: result.row.tags.map((x) => "#" + x).join(" ") || "—",
      }) + NEWLINE + t(ctx.locale, "vault_description_hint")
    );
    return;
  }
  if (sub.toLowerCase() === "sync") {
    const rows = await ensureDefaultVault(ctx.env, ctx.db, ctx.user.id);
    const lines: string[] = [];
    for (const row of rows) {
      const synced = await syncVaultChannel(ctx.env, ctx.db, row);
      lines.push(t(ctx.locale, "vault_synced", { title: synced.title ?? synced.chat_id, category: synced.category ?? "—", tags: synced.tags.map((x) => "#" + x).join(" ") || "—" }));
    }
    await ctx.out.sendText(ctx.chatRef, lines.join(NEWLINE) || t(ctx.locale, "vault_empty"));
    return;
  }
  await ctx.out.sendText(ctx.chatRef, t(ctx.locale, "vault_usage"));
}
