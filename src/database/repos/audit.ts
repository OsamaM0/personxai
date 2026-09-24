/** Audit trail. Best-effort by design: a failed audit write must never break a turn. */
import { dbError, type Db } from "../client";
import type { AuditLogRow, TablesInsert } from "../types";
import { formatError, log } from "../../utils/logger";

export async function insertAudit(db: Db, row: TablesInsert<"audit_logs">): Promise<void> {
  try {
    const { error } = await db.from("audit_logs").insert(row);
    if (error) {
      log("warn", "db.audit_logs.insert_failed", {
        action: row.action,
        code: error.code,
        message: error.message,
      });
    }
  } catch (err) {
    log("warn", "db.audit_logs.insert_failed", { action: row.action, error: formatError(err) });
  }
}

/** Newest-first audit trail for one user (dashboard activity view). */
export async function listAudit(db: Db, userId: string, limit = 50): Promise<AuditLogRow[]> {
  const { data, error } = await db
    .from("audit_logs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw dbError("audit_logs", "list", error);
  return data ?? [];
}
