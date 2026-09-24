/**
 * MCP client glue.
 *
 * The Agents SDK gives every Agent an `MCPClientManager` at `this.mcp`, which
 * handles connection lifecycle, hibernation-safe reconnects, and JSON-Schema →
 * Zod tool conversion. This module owns only the policy on top: which servers a
 * user has enabled, connecting them lazily, and recording connection health.
 */
import type { ToolSet } from "ai";
import type { Db } from "../database/client";
import { listMcpServers, updateMcpServer } from "../database/repos/skills";
import { formatError, log } from "../utils/logger";

/** The slice of `this.mcp` we depend on — keeps this module testable and SDK-version tolerant. */
export interface McpManagerLike {
  getAITools(): ToolSet;
}

export interface McpHost {
  mcp: McpManagerLike;
  addMcpServer(
    name: string,
    url: string,
    options?: { transport?: { headers?: Record<string, string> } }
  ): Promise<{ state?: string; authUrl?: string } | void>;
}

const connected = new Set<string>();

/**
 * Connect every enabled server for a user (idempotent per DO lifetime — the SDK
 * itself dedups by name+URL, this just avoids the round trips).
 */
export async function connectUserMcpServers(host: McpHost, db: Db, userId: string): Promise<number> {
  let servers: Awaited<ReturnType<typeof listMcpServers>>;
  try {
    servers = await listMcpServers(db, userId, true);
  } catch (err) {
    log("warn", "mcp_list_failed", { error: formatError(err) });
    return 0;
  }

  let live = 0;
  for (const server of servers) {
    const key = `${userId}:${server.name}:${server.url}`;
    if (connected.has(key)) {
      live++;
      continue;
    }
    try {
      const headers = server.auth_header
        ? { Authorization: server.auth_header }
        : undefined;
      const result = await host.addMcpServer(
        server.name,
        server.url,
        headers ? { transport: { headers } } : undefined
      );
      if (result && typeof result === "object" && result.state === "authenticating") {
        // OAuth servers need a browser round trip; surface it rather than hanging.
        await updateMcpServer(db, userId, server.id, {
          last_error: "authorization required",
        }).catch(() => {});
        log("warn", "mcp_needs_auth", { server: server.name });
        continue;
      }
      connected.add(key);
      live++;
      await updateMcpServer(db, userId, server.id, {
        last_connected_at: new Date().toISOString(),
        last_error: null,
      }).catch(() => {});
    } catch (err) {
      const message = formatError(err);
      log("warn", "mcp_connect_failed", { server: server.name, error: message });
      await updateMcpServer(db, userId, server.id, { last_error: message.slice(0, 500) }).catch(
        () => {}
      );
    }
  }
  return live;
}

/** Tools exposed by connected MCP servers, namespaced by the SDK. */
export function mcpToolSet(host: McpHost): ToolSet {
  try {
    return host.mcp.getAITools();
  } catch (err) {
    log("warn", "mcp_tools_failed", { error: formatError(err) });
    return {};
  }
}
