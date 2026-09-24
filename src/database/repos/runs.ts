/** Agent run telemetry + usage aggregation. */
import { dbError, type Db } from "../client";
import type { AgentRunRow, TablesInsert } from "../types";

/** The subset of agent_runs the dashboard lists. */
export type RunSummary = Pick<
  AgentRunRow,
  | "id"
  | "created_at"
  | "trigger"
  | "status"
  | "model"
  | "prompt_tokens"
  | "completion_tokens"
  | "tool_call_count"
  | "latency_ms"
>;

export async function insertRun(db: Db, row: TablesInsert<"agent_runs">): Promise<string> {
  const { data, error } = await db.from("agent_runs").insert(row).select("id").single();
  if (error) throw dbError("agent_runs", "insert", error);
  return data.id;
}

export async function insertToolCalls(db: Db, rows: TablesInsert<"tool_calls">[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await db.from("tool_calls").insert(rows);
  if (error) throw dbError("tool_calls", "insert", error);
}

export async function usageSince(
  db: Db,
  userId: string,
  sinceIso: string
): Promise<{
  runs: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  costUsd: number;
}> {
  const { data, error } = await db
    .from("agent_runs")
    .select("prompt_tokens, completion_tokens, tool_call_count, cost_usd")
    .eq("user_id", userId)
    .gte("created_at", sinceIso);
  if (error) throw dbError("agent_runs", "select", error);

  let promptTokens = 0;
  let completionTokens = 0;
  let toolCalls = 0;
  let costUsd = 0;
  for (const r of data) {
    promptTokens += r.prompt_tokens ?? 0;
    completionTokens += r.completion_tokens ?? 0;
    toolCalls += r.tool_call_count;
    costUsd += r.cost_usd ?? 0;
  }
  return { runs: data.length, promptTokens, completionTokens, toolCalls, costUsd };
}

/** Newest-first run list without the heavy columns (dashboard activity view). */
export async function recentRuns(db: Db, userId: string, limit = 50): Promise<RunSummary[]> {
  const { data, error } = await db
    .from("agent_runs")
    .select("id, created_at, trigger, status, model, prompt_tokens, completion_tokens, tool_call_count, latency_ms")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw dbError("agent_runs", "recent", error);
  return data ?? [];
}
