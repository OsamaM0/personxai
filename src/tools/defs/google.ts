import { z } from "zod";
import { defineTool } from "../registry";
import { insertAudit } from "../../database/repos/audit";
import { getOAuthAccount } from "../../database/repos/oauth";
import {
  GOOGLE_PROVIDER,
  GoogleNotConnectedError,
  googleAccessToken,
  isGoogleConfigured,
} from "../../services/google/oauth";
import {
  markMailRead,
  readMail,
  searchMail,
  sendMail,
  unreadCount,
} from "../../services/google/gmail";
import {
  createEvent,
  deleteEvent,
  freeBusy,
  freeSlots,
  listEvents,
  updateEvent,
} from "../../services/google/calendar";
import {
  addGoogleTask,
  completeGoogleTask,
  listGoogleTasks,
  listTaskLists,
  searchContacts,
} from "../../services/google/tasks";
import type { AgentContext } from "../../agent/context";
import { truncate } from "../../utils/text";
import { formatError } from "../../utils/logger";

/**
 * Google tools: mail, calendar (with Meet), tasks and contacts.
 *
 * All of them touch an account outside this system, so every one is `external`
 * — at low autonomy the user confirms before anything leaves. The three that
 * are visible to other people (sending mail, inviting attendees, deleting an
 * event) are additionally marked irreversible, so they ask even at autonomy 3.
 *
 * Every tool starts by resolving an access token. A user who has not linked
 * Google gets a plain sentence telling them where to do it, never a stack
 * trace, because "connect it on the dashboard" is the actual next step.
 */

/** Resolve a token, turning "not connected" into an answerable result. */
async function withToken<T>(
  ctx: AgentContext,
  run: (token: string) => Promise<T>
): Promise<T | { error: string }> {
  if (!isGoogleConfigured(ctx.env)) {
    return {
      error:
        "Google is not set up on this deployment (no OAuth client) — tell the user their email and calendar are not connected",
    };
  }
  let token: string;
  try {
    token = await googleAccessToken(ctx.env, ctx.db, ctx.user.id);
  } catch (err) {
    if (err instanceof GoogleNotConnectedError) return { error: err.message };
    return { error: formatError(err) };
  }
  return run(token);
}

const audit = (ctx: AgentContext, action: string, details: Record<string, unknown>) =>
  ctx.waitUntil(
    insertAudit(ctx.db, {
      user_id: ctx.user.id,
      actor: "agent",
      action,
      // JSON round-trip drops undefined so the audit row never carries holes.
      details: JSON.parse(JSON.stringify(details)),
    }).catch(() => {})
  );

/** The user's own timezone is the only sensible default for a calendar write. */
const tzOf = (ctx: AgentContext) => ctx.user.timezone || ctx.config.defaults.timezone;

export const googleTools = [
  // ── Gmail ──────────────────────────────────────────────────────────────────
  defineTool({
    name: "search_email",
    description: [
      "Search the user's Gmail and get back sender, subject, date and a snippet.",
      "Use Gmail's own query syntax: 'is:unread', 'from:sara', 'newer_than:7d', 'has:attachment', or plain words.",
      "This returns headers only — call read_email with an id to see what a message actually says.",
    ].join(" "),
    inputSchema: z.object({
      query: z
        .string()
        .max(300)
        .optional()
        .describe("Gmail search query; omit for the most recent inbox mail"),
      limit: z.number().int().min(1).max(25).optional().describe("how many messages (default 10)"),
      unreadOnly: z.boolean().optional().describe("restrict to unread mail"),
    }),
    topics: ["email"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    confirmLabel: (i) => `Search your Gmail for "${truncate(i.query ?? "recent mail", 60)}"`,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const query = [input.query ?? "", input.unreadOnly ? "is:unread" : ""]
          .filter(Boolean)
          .join(" ")
          .trim();
        const messages = await searchMail(token, {
          ...(query ? { query } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        audit(ctx, "google.mail.search", { query: truncate(query, 200), found: messages.length });
        return {
          query: query || "(recent inbox)",
          count: messages.length,
          messages,
          note:
            messages.length === 0
              ? "nothing matched — say so rather than guessing what the mail said"
              : "ids are for read_email; do not quote a message from its snippet alone",
        };
      }),
  }),

  defineTool({
    name: "read_email",
    description:
      "Read one Gmail message in full (body flattened to text). Use the id from search_email. Long bodies are truncated.",
    inputSchema: z.object({
      messageId: z.string().min(1).describe("Gmail message id from search_email"),
      markRead: z.boolean().optional().describe("also mark it as read"),
    }),
    topics: ["email"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    confirmLabel: () => "Open one of your emails",
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const message = await readMail(token, input.messageId);
        if (input.markRead) await markMailRead(token, input.messageId).catch(() => {});
        audit(ctx, "google.mail.read", { messageId: input.messageId, markRead: !!input.markRead });
        return message;
      }),
  }),

  defineTool({
    name: "send_email",
    description: [
      "Send an email from the user's Gmail account.",
      "Pass threadId (and inReplyTo when you have it) to reply inside an existing conversation instead of starting a new one.",
      "Write the body in the user's own language and keep it to what they asked for.",
    ].join(" "),
    inputSchema: z.object({
      to: z.string().min(3).max(500).describe("recipient address, or comma-separated addresses"),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(10_000),
      cc: z.string().max(500).optional(),
      threadId: z.string().optional().describe("thread id from search_email, to reply in place"),
      inReplyTo: z.string().optional().describe("Message-Id of the mail being answered"),
    }),
    topics: ["email"],
    permissionLevel: "external",
    // Mail cannot be unsent: always confirm, whatever the autonomy level.
    irreversible: true,
    timeoutMs: 25_000,
    confirmLabel: (i) => `Email ${truncate(i.to, 40)}: "${truncate(i.subject, 50)}"`,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const sent = await sendMail(token, input);
        audit(ctx, "google.mail.send", {
          to: truncate(input.to, 200),
          subject: truncate(input.subject, 200),
          threadId: sent.threadId,
        });
        return { sent: true, ...sent, note: "the mail has left — confirm briefly, do not repeat the body" };
      }),
  }),

  defineTool({
    name: "email_summary",
    description:
      "How much unread mail is waiting, plus the newest few unread messages. Good for a morning brief or 'anything important?'.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(10).optional().describe("how many to preview (default 5)"),
    }),
    topics: ["email"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const [unread, messages] = await Promise.all([
          unreadCount(token).catch(() => 0),
          searchMail(token, { query: "is:unread in:inbox", limit: input.limit ?? 5 }),
        ]);
        return { unread, newest: messages };
      }),
  }),

  // ── Calendar ───────────────────────────────────────────────────────────────
  defineTool({
    name: "list_calendar_events",
    description: [
      "What is on the user's Google Calendar in a time window.",
      "Give timeMin/timeMax as ISO timestamps; default is from now for the next 7 days.",
      "Events that have a Meet link come back with it.",
    ].join(" "),
    inputSchema: z.object({
      timeMin: z.string().optional().describe("ISO start of the window; default now"),
      timeMax: z.string().optional().describe("ISO end of the window; default 7 days out"),
      query: z.string().max(200).optional().describe("only events matching this text"),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    topics: ["calendar"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const timeMin = input.timeMin ?? ctx.now.toISOString();
        const timeMax =
          input.timeMax ?? new Date(ctx.now.getTime() + 7 * 86_400_000).toISOString();
        const events = await listEvents(token, {
          timeMin,
          timeMax,
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        return {
          window: { from: timeMin, to: timeMax },
          timezone: tzOf(ctx),
          count: events.length,
          events,
        };
      }),
  }),

  defineTool({
    name: "create_calendar_event",
    description: [
      "Put an event on the user's Google Calendar.",
      "Set withMeet to true for 'a meeting', 'a call', 'a Meet' — it attaches a Google Meet link, which is how meetings get created here.",
      "Times are ISO timestamps interpreted in the user's timezone; a bare YYYY-MM-DD makes it all-day.",
      "Only pass attendees when the user named people, and set sendInvites to actually email them.",
    ].join(" "),
    inputSchema: z.object({
      summary: z.string().min(1).max(300).describe("the event title"),
      start: z.string().min(4).describe("ISO start, or YYYY-MM-DD for an all-day event"),
      end: z.string().min(4).describe("ISO end, or YYYY-MM-DD for an all-day event"),
      description: z.string().max(4000).optional(),
      location: z.string().max(300).optional(),
      attendees: z
        .array(z.string().email())
        .max(25)
        .optional()
        .describe("email addresses; use search_contacts to turn a name into one"),
      withMeet: z.boolean().optional().describe("attach a Google Meet link"),
      sendInvites: z.boolean().optional().describe("email the invitation to the attendees"),
    }),
    topics: ["calendar"],
    permissionLevel: "external",
    isCreate: true,
    timeoutMs: 25_000,
    confirmLabel: (i) =>
      `Create "${truncate(i.summary, 50)}" on ${truncate(i.start, 25)}${i.withMeet ? " with a Meet link" : ""}`,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const event = await createEvent(token, {
          summary: input.summary,
          start: input.start,
          end: input.end,
          timeZone: tzOf(ctx),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.attendees !== undefined ? { attendees: input.attendees } : {}),
          ...(input.withMeet !== undefined ? { withMeet: input.withMeet } : {}),
          ...(input.sendInvites !== undefined ? { sendUpdates: input.sendInvites } : {}),
        });
        audit(ctx, "google.calendar.create", {
          eventId: event.id,
          summary: truncate(input.summary, 200),
          withMeet: !!input.withMeet,
          attendees: input.attendees?.length ?? 0,
        });
        return {
          created: true,
          event,
          note: input.withMeet
            ? "give the user the meetLink — that is the joining link"
            : "confirm the time back to the user in their timezone",
        };
      }),
  }),

  defineTool({
    name: "update_calendar_event",
    description:
      "Change an existing calendar event: move it, rename it, change who is invited, or add a Google Meet link it does not have yet. Use the id from list_calendar_events.",
    inputSchema: z.object({
      eventId: z.string().min(1),
      withMeet: z.boolean().optional().describe("add a Google Meet link to an event that has none"),
      summary: z.string().max(300).optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      description: z.string().max(4000).optional(),
      location: z.string().max(300).optional(),
      attendees: z.array(z.string().email()).max(25).optional().describe("replaces the whole list"),
      sendInvites: z.boolean().optional(),
    }),
    topics: ["calendar"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    confirmLabel: (i) => `Update calendar event ${truncate(i.eventId, 20)}`,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const event = await updateEvent(token, {
          eventId: input.eventId,
          timeZone: tzOf(ctx),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.start !== undefined ? { start: input.start } : {}),
          ...(input.end !== undefined ? { end: input.end } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.attendees !== undefined ? { attendees: input.attendees } : {}),
          ...(input.withMeet !== undefined ? { withMeet: input.withMeet } : {}),
          ...(input.sendInvites !== undefined ? { sendUpdates: input.sendInvites } : {}),
        });
        audit(ctx, "google.calendar.update", { eventId: input.eventId, withMeet: !!input.withMeet });
        return { updated: true, event };
      }),
  }),

  defineTool({
    name: "delete_calendar_event",
    description:
      "Cancel an event on the user's Google Calendar. Attendees are notified by Google. This cannot be undone.",
    inputSchema: z.object({ eventId: z.string().min(1) }),
    topics: ["calendar"],
    permissionLevel: "external",
    irreversible: true,
    timeoutMs: 25_000,
    confirmLabel: (i) => `Cancel calendar event ${truncate(i.eventId, 20)}`,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        await deleteEvent(token, input.eventId);
        audit(ctx, "google.calendar.delete", { eventId: input.eventId });
        return { deleted: true };
      }),
  }),

  defineTool({
    name: "find_free_time",
    description: [
      "Find gaps in the user's calendar inside a window — use this before proposing a meeting time.",
      "Returns openings of at least minMinutes; it does not book anything.",
    ].join(" "),
    inputSchema: z.object({
      timeMin: z.string().describe("ISO start of the window to search"),
      timeMax: z.string().describe("ISO end of the window to search"),
      minMinutes: z
        .number()
        .int()
        .min(5)
        .max(480)
        .optional()
        .describe("shortest useful gap, default 30"),
    }),
    topics: ["calendar"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const busy = await freeBusy(token, input.timeMin, input.timeMax);
        const free = freeSlots(busy, input.timeMin, input.timeMax, input.minMinutes ?? 30);
        return {
          timezone: tzOf(ctx),
          busy,
          free,
          note:
            free.length === 0
              ? "no gap that long — offer the closest busy blocks instead of inventing a slot"
              : "these are wall-clock instants; state them in the user's timezone",
        };
      }),
  }),

  // ── Google Tasks ───────────────────────────────────────────────────────────
  defineTool({
    name: "list_google_tasks",
    description: [
      "The user's Google Tasks — the list in their phone's Tasks app, not this assistant's own tasks.",
      "Only use it when the user means Google Tasks specifically; otherwise use list_tasks.",
    ].join(" "),
    inputSchema: z.object({
      listId: z.string().optional().describe("task list id; default is the primary list"),
      includeCompleted: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    topics: ["google_tasks"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const [lists, tasks] = await Promise.all([
          listTaskLists(token).catch(() => []),
          listGoogleTasks(token, {
            ...(input.listId !== undefined ? { listId: input.listId } : {}),
            ...(input.includeCompleted !== undefined
              ? { includeCompleted: input.includeCompleted }
              : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          }),
        ]);
        return { lists, count: tasks.length, tasks };
      }),
  }),

  defineTool({
    name: "add_google_task",
    description:
      "Add a task to the user's Google Tasks list. Google Tasks due dates are day-level: the time part is ignored.",
    inputSchema: z.object({
      title: z.string().min(1).max(300),
      notes: z.string().max(4000).optional(),
      due: z.string().optional().describe("ISO date or timestamp"),
      listId: z.string().optional(),
    }),
    topics: ["google_tasks"],
    permissionLevel: "external",
    isCreate: true,
    timeoutMs: 25_000,
    confirmLabel: (i) => `Add "${truncate(i.title, 50)}" to Google Tasks`,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const task = await addGoogleTask(token, input);
        audit(ctx, "google.tasks.add", { taskId: task.id, title: truncate(input.title, 200) });
        return { created: true, task };
      }),
  }),

  defineTool({
    name: "complete_google_task",
    description: "Mark a Google Task done. Use the id from list_google_tasks.",
    inputSchema: z.object({
      taskId: z.string().min(1),
      listId: z.string().optional(),
    }),
    topics: ["google_tasks"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    confirmLabel: (i) => `Complete Google Task ${truncate(i.taskId, 20)}`,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const task = await completeGoogleTask(token, input.taskId, input.listId);
        audit(ctx, "google.tasks.complete", { taskId: input.taskId });
        return { completed: true, task };
      }),
  }),

  // ── Contacts ───────────────────────────────────────────────────────────────
  defineTool({
    name: "search_contacts",
    description: [
      "Look up someone in the user's Google Contacts by name, email or phone.",
      "Use it to turn 'invite Sara' into an actual address before creating an event or sending mail.",
      "If several people match, ask which one instead of picking.",
    ].join(" "),
    inputSchema: z.object({
      query: z.string().min(1).max(120).describe("name, part of an email, or a phone number"),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    topics: ["contacts"],
    permissionLevel: "external",
    timeoutMs: 25_000,
    execute: (input, ctx) =>
      withToken(ctx, async (token) => {
        const contacts = await searchContacts(token, input.query, input.limit ?? 10);
        return {
          query: input.query,
          count: contacts.length,
          contacts,
          note:
            contacts.length === 0
              ? "no match — ask the user for the address rather than guessing one"
              : undefined,
        };
      }),
  }),

  // ── Connection status ──────────────────────────────────────────────────────
  defineTool({
    name: "google_status",
    description:
      "Whether the user's Google account is connected, which one, and what the assistant may do with it. Use it when a Google tool says it is not connected.",
    inputSchema: z.object({}),
    topics: ["email", "calendar", "google_tasks", "contacts", "settings"],
    permissionLevel: "read",
    execute: async (_input, ctx) => {
      if (!isGoogleConfigured(ctx.env)) {
        return {
          available: false,
          reason: "this deployment has no Google OAuth client configured (see docs/GOOGLE.md)",
        };
      }
      const account = await getOAuthAccount(ctx.db, ctx.user.id, GOOGLE_PROVIDER);
      if (!account) {
        return {
          available: true,
          connected: false,
          note: "tell the user to open the dashboard, go to Settings, and press Connect Google",
        };
      }
      return {
        available: true,
        connected: true,
        account: account.account_email,
        scopes: account.scopes,
        lastError: account.last_error,
        connectedAt: account.created_at,
      };
    },
  }),
];
