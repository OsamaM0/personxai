/**
 * Reminder dispatcher — runs on every cron tick (and POST /dispatch).
 * Outbox pattern ported from openmemo: materialize due reminders → claim with
 * lease → deliver → advance. Idempotent across overlapping/missed ticks.
 */
import { getAgentByName } from "agents";
import type { Env } from "../env";
import { loadConfig } from "../config";
import { createDb, type Db } from "../database/client";
import {
  claimDueJobs,
  markJobDelivered,
  markJobFailed,
  selectDueReminders,
  updateReminder,
} from "../database/repos/reminders";
import { getUserById } from "../database/repos/users";
import { getAdapter } from "../channels/registry";
import { resolveLocale, t } from "../i18n";
import { nextOccurrence } from "./rrule";
import { log, formatError } from "../utils/logger";
import type { ClaimedJob } from "../database/types";

export interface DispatchStats {
  materialized: number;
  claimed: number;
  delivered: number;
  failed: number;
}

export async function dispatchTick(env: Env): Promise<DispatchStats> {
  const config = loadConfig(env);
  const db = createDb(config.supabase.url, config.supabase.serviceRoleKey);

  const materialized = await selectDueReminders(db);
  const jobs = await claimDueJobs(db, 20);
  let delivered = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      await deliverJob(env, db, job);
      await markJobDelivered(db, job.job_id);
      await advanceReminder(db, job);
      delivered++;
    } catch (err) {
      failed++;
      const message = formatError(err);
      log("error", "job_delivery_failed", { job: job.job_id, error: message });
      const status = await markJobFailed(db, job.job_id, message).catch(() => null);
      if (status === "dead_letter") {
        await notifyDeadLetter(env, db, job).catch(() => {});
      }
    }
  }

  if (jobs.length > 0 || materialized > 0) {
    log("info", "dispatch_tick", { materialized, claimed: jobs.length, delivered, failed });
  }
  return { materialized, claimed: jobs.length, delivered, failed };
}

async function resolveDelivery(
  db: Db,
  userId: string
): Promise<{
  chatRef: string;
  channel: string;
  externalId: string;
  locale: ReturnType<typeof resolveLocale>;
  timezone: string;
} | null> {
  const user = await getUserById(db, userId);
  if (!user) return null;
  const { data, error } = await db
    .from("user_identities")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const identity = data[0];
  if (!identity?.chat_ref) return null;
  return {
    chatRef: identity.chat_ref,
    channel: identity.channel,
    externalId: identity.external_id,
    locale: resolveLocale(user.language),
    timezone: user.timezone,
  };
}

async function deliverJob(env: Env, db: Db, job: ClaimedJob): Promise<void> {
  if (job.kind === "dynamic") {
    // daily_brief / heartbeat re-enter the agent (natural-db routine pattern):
    // the DO owns the user's context and rate limits, so routines run there.
    const target = await resolveDelivery(db, job.user_id);
    if (!target) throw new Error("no deliverable identity for user " + job.user_id);
    const agentName = "u:" + target.channel + ":" + target.externalId;
    const stub = await getAgentByName(env.UserAgent, agentName);
    await stub.runScheduledRoutine(job.user_id, job.template_id ?? "");
    return;
  }
  const target = await resolveDelivery(db, job.user_id);
  if (!target) throw new Error(`no deliverable identity for user ${job.user_id}`);
  const adapter = getAdapter(target.channel);
  if (!adapter) throw new Error(`no adapter for channel ${target.channel}`);
  const out = adapter.outbound(env);
  const content = job.content ?? job.raw_text ?? "⏰";
  await out.sendText(target.chatRef, `${t(target.locale, "reminder_delivery_prefix")} ${content}`);
}

async function advanceReminder(db: Db, job: ClaimedJob): Promise<void> {
  if ((job.kind === "recurring" || job.kind === "dynamic") && job.recurrence_rule) {
    const occurrence = new Date(job.occurrence_at);
    const next = nextOccurrence(job.recurrence_rule, {
      after: occurrence,
      anchor: occurrence,
      timezone: job.timezone || "UTC",
    });
    if (next) {
      await updateReminder(db, job.user_id, job.reminder_id, {
        status: "active",
        next_trigger_at: next.toISOString(),
      });
      return;
    }
  }
  if (job.kind !== "dynamic") {
    await updateReminder(db, job.user_id, job.reminder_id, {
      status: "completed",
      next_trigger_at: null,
    });
  }
}

async function notifyDeadLetter(env: Env, db: Db, job: ClaimedJob): Promise<void> {
  const target = await resolveDelivery(db, job.user_id);
  if (!target) return;
  const adapter = getAdapter(target.channel);
  if (!adapter) return;
  await adapter
    .outbound(env)
    .sendText(
      target.chatRef,
      `⚠️ A reminder repeatedly failed to deliver and was parked: "${job.content ?? job.raw_text ?? job.reminder_id}"`
    );
}
