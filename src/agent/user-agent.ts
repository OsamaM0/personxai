/**
 * Per-user Durable Object (Cloudflare Agents SDK). One instance per channel
 * identity (`u:<channel>:<externalUserId>`); serializes all processing for that
 * user. Holds ONLY ephemeral state — Supabase is the source of truth.
 */
import { Agent } from "agents";
import type { Env } from "../env";
import { loadConfig, type AppConfig } from "../config";
import { createDb, type Db } from "../database/client";
import type { IncomingMessage } from "../channels/types";
import { initDoSchema, seenUpdate, type SqlExecutor } from "./do-schema";
import { processIncoming, runRoutine, type OrchestratorDeps } from "./orchestrator";
import { log, formatError } from "../utils/logger";
import type { McpHost } from "../mcp/client";
import { executeMcpTool, type McpToolOutcome, type McpToolRequest } from "../mcp/server/execute";

export class UserAgent extends Agent<Env> {
  #config: AppConfig | null = null;
  #db: Db | null = null;
  #schemaReady = false;

  private get appConfig(): AppConfig {
    if (!this.#config) this.#config = loadConfig(this.env);
    return this.#config;
  }

  private get db(): Db {
    if (!this.#db) {
      const cfg = this.appConfig;
      this.#db = createDb(cfg.supabase.url, cfg.supabase.serviceRoleKey);
    }
    return this.#db;
  }

  private get sqlExec(): SqlExecutor {
    return { sql: this.sql.bind(this) };
  }

  private ensureSchema(): void {
    if (!this.#schemaReady) {
      initDoSchema(this.sqlExec);
      this.#schemaReady = true;
    }
  }

  /** Everything the orchestrator needs from this DO, assembled once per call. */
  private get deps(): OrchestratorDeps {
    return {
      env: this.env,
      config: this.appConfig,
      db: this.db,
      sqlExec: this.sqlExec,
      waitUntil: (p) => this.ctx.waitUntil(p),
      mcpHost: this as unknown as McpHost,
    };
  }

  /** Entry point — called from the Worker webhook route via DO RPC. */
  async ingest(msg: IncomingMessage): Promise<void> {
    this.ensureSchema();
    if (seenUpdate(this.sqlExec, `${msg.channel}:${msg.updateId}`, Date.now())) {
      return; // Telegram retry or duplicate delivery
    }
    try {
      await processIncoming(this.deps, msg);
    } catch (err) {
      log("error", "ingest_failed", { error: formatError(err) });
    }
  }

  /** Scheduled routine (daily brief, heartbeat) — invoked by the cron dispatcher. */
  async runScheduledRoutine(userId: string, templateId: string): Promise<boolean> {
    this.ensureSchema();
    try {
      return await runRoutine(this.deps, userId, templateId);
    } catch (err) {
      log("error", "routine_failed", { templateId, error: formatError(err) });
      return false;
    }
  }

  /**
   * One tool call from an MCP client (src/mcp/server). Routed through the DO so
   * it is serialized against this user's chat traffic and sees the same SQLite
   * handle and MCP connections a Telegram turn would.
   */
  async callMcpTool(req: McpToolRequest): Promise<McpToolOutcome> {
    this.ensureSchema();
    try {
      return await executeMcpTool(this.deps, req);
    } catch (err) {
      const error = formatError(err);
      log("error", "mcp_call_failed", { tool: req.toolName, error });
      return { text: error, isError: true };
    }
  }
}
