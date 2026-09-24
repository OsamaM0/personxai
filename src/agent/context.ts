/**
 * AgentContext — everything a turn needs, assembled once per incoming message.
 * Channel-agnostic: holds an OutboundPort, never Telegram types.
 */
import type { Env } from "../env";
import type { AppConfig } from "../config";
import type { Db } from "../database/client";
import type { ConversationRow, UserIdentityRow, UserRow } from "../database/types";
import type { OutboundPort } from "../channels/types";
import type { Locale } from "../i18n";
import type { SqlExecutor } from "./do-schema";
import type { McpHost } from "../mcp/client";

export interface AgentContext {
  env: Env;
  config: AppConfig;
  db: Db;
  user: UserRow;
  identity: UserIdentityRow;
  conversation: ConversationRow;
  locale: Locale;
  out: OutboundPort;
  /** Channel-native chat reference to reply into. */
  chatRef: string;
  channel: string;
  /** DO SQLite access for confirmations / ephemeral state. */
  do: SqlExecutor;
  now: Date;
  /** Deferred background work (embeddings etc.). */
  waitUntil: (p: Promise<unknown>) => void;
  /** The Durable Object hosting MCP connections, when available. */
  mcpHost?: McpHost;
}
