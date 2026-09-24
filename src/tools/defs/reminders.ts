import { z } from "zod";
import { defineTool } from "../registry";
import {
  cancelReminder,
  insertReminder,
  listReminders,
} from "../../database/repos/reminders";
import { insertAudit } from "../../database/repos/audit";
import { nextOccurrence, describeRecurrence } from "../../scheduler/rrule";
import { parseUserDateTime } from "./util";
import { formatDateTime } from "../../i18n";

export const reminderTools = [
  defineTool({
    name: "create_reminder",
    description:
      "Create a reminder. One-time: pass 'when' (user-LOCAL time YYYY-MM-DDTHH:mm — call current_time first for relative phrases). Recurring: pass an RRULE like FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0 plus optional 'when' as the first occurrence.",
    inputSchema: z.object({
      content: z
        .string()
        .min(1)
        .max(500)
        .describe("what to remind about — a directive, e.g. 'Finish the OpenCV lesson', not 'I will remind you...'"),
      when: z.string().optional().describe("user-local YYYY-MM-DDTHH:mm; required for one-time reminders"),
      recurrence: z.string().optional().describe("RRULE string for recurring reminders"),
      rawText: z.string().max(500).optional().describe("the user's original phrasing"),
    }),
    topics: ["reminders"],
    permissionLevel: "write",
    isCreate: true,
    confirmLabel: (i) => `Create reminder "${i.content}"`,
    execute: async (input, ctx) => {
      const tz = ctx.user.timezone;
      const now = ctx.now;

      let firstAt: Date | null = null;
      if (input.when) {
        const parsed = parseUserDateTime(input.when, tz);
        if ("error" in parsed) return { error: parsed.error };
        firstAt = parsed.date;
      }

      if (input.recurrence) {
        const anchor = firstAt ?? now;
        const next = firstAt && firstAt > now
          ? firstAt
          : nextOccurrence(input.recurrence, { after: now, anchor, timezone: tz });
        if (!next) return { error: `invalid recurrence rule "${input.recurrence}"` };
        const row = await insertReminder(ctx.db, {
          user_id: ctx.user.id,
          kind: "recurring",
          status: "active",
          content: input.content,
          raw_text: input.rawText ?? null,
          recurrence_rule: input.recurrence,
          start_at: anchor.toISOString(),
          next_trigger_at: next.toISOString(),
          timezone: tz,
        });
        await insertAudit(ctx.db, {
          user_id: ctx.user.id,
          actor: "agent",
          action: "reminder.create",
          entity_kind: "reminder",
          entity_id: row.id,
        });
        return {
          created: true,
          reminderId: row.id,
          recurring: describeRecurrence(input.recurrence),
          nextAtLocal: formatDateTime(next, tz, ctx.locale),
        };
      }

      if (!firstAt) return { error: "one-time reminders need 'when'" };
      if (firstAt.getTime() < now.getTime() - 60_000) {
        return { error: `"${input.when}" is in the past for the user — call current_time and recompute` };
      }
      const row = await insertReminder(ctx.db, {
        user_id: ctx.user.id,
        kind: "static",
        status: "scheduled",
        content: input.content,
        raw_text: input.rawText ?? null,
        start_at: firstAt.toISOString(),
        next_trigger_at: firstAt.toISOString(),
        timezone: tz,
      });
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "reminder.create",
        entity_kind: "reminder",
        entity_id: row.id,
      });
      return {
        created: true,
        reminderId: row.id,
        atLocal: formatDateTime(firstAt, tz, ctx.locale),
        note: "Reminders fire on a one-minute tick — delivery can drift up to a minute.",
      };
    },
  }),

  defineTool({
    name: "list_reminders",
    description: "List upcoming reminders (scheduled + active).",
    inputSchema: z.object({}),
    topics: ["reminders"],
    permissionLevel: "read",
    execute: async (_input, ctx) => {
      const rows = await listReminders(ctx.db, ctx.user.id);
      return {
        reminders: rows.map((r) => ({
          id: r.id,
          content: r.content ?? r.raw_text,
          kind: r.kind,
          nextAtLocal: r.next_trigger_at
            ? formatDateTime(r.next_trigger_at, ctx.user.timezone, ctx.locale)
            : null,
          recurrence: r.recurrence_rule ? describeRecurrence(r.recurrence_rule) : null,
        })),
      };
    },
  }),

  defineTool({
    name: "cancel_reminder",
    description: "Cancel a reminder by id (find it with list_reminders first).",
    inputSchema: z.object({ reminderId: z.string().uuid() }),
    topics: ["reminders"],
    permissionLevel: "write",
    confirmLabel: () => "Cancel reminder",
    execute: async (input, ctx) => {
      const ok = await cancelReminder(ctx.db, ctx.user.id, input.reminderId);
      await insertAudit(ctx.db, {
        user_id: ctx.user.id,
        actor: "agent",
        action: "reminder.cancel",
        entity_kind: "reminder",
        entity_id: input.reminderId,
        status: ok ? "ok" : "noop",
      });
      return ok ? { cancelled: true } : { error: "reminder not found or already finished" };
    },
  }),
];
