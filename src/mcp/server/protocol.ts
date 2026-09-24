/**
 * JSON-RPC 2.0 framing for the MCP server surface.
 *
 * Deliberately hand-rolled and dependency-free: the worker already speaks HTTP
 * and JSON, and the Streamable-HTTP transport is a thin envelope over both. The
 * MCP-specific policy (auth, tool catalogue, execution) lives in the siblings of
 * this file; this one only knows about message shapes.
 */

/**
 * Protocol revisions this server can speak, newest first. `initialize` echoes
 * the client's version when it appears here, otherwise it answers with the
 * newest one and lets the client decide whether it can continue.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export type RpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** Absent on notifications — those get no response. */
  id?: RpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Standard JSON-RPC codes. MCP adds no codes of its own below -32000. */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function rpcResult(id: RpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: RpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

export interface ParsedRpcBody {
  /** True when the client sent an array (JSON-RPC batch, pre-2025-06-18 clients). */
  batch: boolean;
  messages: JsonRpcRequest[];
}

/** A message with no `id` is a notification: acknowledged, never answered. */
export function isNotification(msg: JsonRpcRequest): boolean {
  return msg.id === undefined;
}

/**
 * Validate the outer envelope only. Per-method `params` validation belongs to
 * the handler, which can return -32602 with a useful message.
 */
export function parseRpcBody(body: unknown): ParsedRpcBody | null {
  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0) return null;
  const messages: JsonRpcRequest[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (record["jsonrpc"] !== "2.0") return null;
    if (typeof record["method"] !== "string") return null;
    const id = record["id"];
    if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
      return null;
    }
    const params = record["params"];
    if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params))) {
      return null;
    }
    messages.push({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id: id as RpcId }),
      method: record["method"] as string,
      ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
    });
  }
  return { batch: Array.isArray(body), messages };
}

export const MCP_PATH = "/mcp";

export function isMcpRoute(pathname: string): boolean {
  return pathname === MCP_PATH || pathname.startsWith(MCP_PATH + "/");
}

/**
 * Some clients advertise only `text/event-stream`. The response is a single
 * message either way — SSE framing is used only when that is all the client
 * said it would accept.
 */
export function wantsSse(accept: string | null): boolean {
  const value = (accept ?? "").toLowerCase();
  return value.includes("text/event-stream") && !value.includes("application/json");
}

export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}
