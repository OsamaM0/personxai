/**
 * Reminders + job outbox (Phase 2). The claim/mark rpcs wrap SQL functions that
 * use SKIP LOCKED semantics — never reimplement them with plain table updates.
 */
import { dbError, type Db } from "../client";
import type { ClaimedJob, Enums, ReminderRow, TablesInsert, TablesUpdate } from "../types";

export async function insertReminder(
  db: Db,
  row: TablesInsert<"reminders">
): Promise<ReminderRow> {
  const { data, error } = await db.from("reminders").insert(row).select().single();
  if (error) throw dbError("reminders", "insert", error);
  return data;
}

export async function listReminders(
  db: Db,
  userId: string,
  statuses: Enums<"reminder_status">[] = ["scheduled", "active"]
): Promise<ReminderRow[]> {
  const { data, error } = await db
    .from("reminders")
    .select("*")
    .eq("user_id", userId)
    .in("status", statuses)
    .order("next_trigger_at", { ascending: true, nullsFirst: false });
  if (error) throw dbError("reminders", "select", error);
  return data;
}

export async function getReminder(db: Db, userId: string, reminderId: string): Promise<ReminderRow | null> {
  const { data, error } = await db
    .from("reminders")
    .select("*")
    .eq("user_id", userId)
    .eq("id", reminderId)
    .maybeSingle();
  if (error) throw dbError("reminders", "get", error);
  return data;
}

export async function updateReminder(
  db: Db,
  userId: string,
  reminderId: string,
  patch: TablesUpdate<"reminders">
): Promise<void> {
  const { error } = await db
    .from("reminders")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", reminderId);
  if (error) throw dbError("reminders", "update", error);
}

export async function cancelReminder(
  db: Db,
  userId: string,
  reminderId: string
): Promise<boolean> {
  // `.select("id")` returns the touched rows, telling us whether anything matched.
  const { data, error } = await db
    .from("reminders")
    .update({ status: "cancelled" })
    .eq("user_id", userId)
    .eq("id", reminderId)
    .select("id");
  if (error) throw dbError("reminders", "update", error);
  return data.length > 0;
}

export async function claimDueJobs(db: Db, batch: number): Promise<ClaimedJob[]> {
  const { data, error } = await db.rpc("claim_due_jobs", { p_batch: batch });
  if (error) throw dbError("claim_due_jobs", "rpc", error);
  return data;
}

export async function selectDueReminders(db: Db): Promise<number> {
  const { data, error } = await db.rpc("select_due_reminders");
  if (error) throw dbError("select_due_reminders", "rpc", error);
  return data;
}

export async function markJobDelivered(db: Db, jobId: string): Promise<void> {
  const { error } = await db.rpc("mark_job_delivered", { p_job_id: jobId });
  if (error) throw dbError("mark_job_delivered", "rpc", error);
}

export async function markJobFailed(
  db: Db,
  jobId: string,
  error: string
): Promise<Enums<"job_status"> | null> {
  const { data, error: rpcError } = await db.rpc("mark_job_failed", {
    p_job_id: jobId,
    p_error: error,
  });
  if (rpcError) throw dbError("mark_job_failed", "rpc", rpcError);
  // SQL returns NULL for an unknown job id; the generated type hides that.
  return data ?? null;
}
