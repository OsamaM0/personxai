import { describe, expect, it } from "vitest";
import {
  LATEST_PROTOCOL_VERSION,
  RPC,
  isMcpRoute,
  negotiateProtocolVersion,
  parseRpcBody,
  rpcError,
  rpcResult,
  wantsSse,
} from "../../src/mcp/server/protocol";
import {
  ASK_ASSISTANT,
  catalogFor,
  jsonSchemaFor,
  parseAskAssistantInput,
  toolAllowed,
} from "../../src/mcp/server/catalog";
import { bearerToken, isMcpScope } from "../../src/mcp/server/tokens";
import { toolRegistry } from "../../src/tools";
import { mintToken, verifyToken, type McpPayload } from "../../src/web/session";

const SECRET = "a-test-secret-of-sufficient-length";
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const seconds = (ms: number) => Math.floor(ms / 1000);

describe("mcp JSON-RPC envelope", () => {
  it("parses a single request", () => {
    const parsed = parseRpcBody({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(parsed).toEqual({
      batch: false,
      messages: [{ jsonrpc: "2.0", id: 1, method: "tools/list" }],
    });
  });

  it("parses a batch and remembers it was one", () => {
    const parsed = parseRpcBody([
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(parsed?.batch).toBe(true);
    expect(parsed?.messages).toHaveLength(2);
    // A notification is distinguishable by the absence of `id`, not by id: null.
    expect(parsed?.messages[1]).not.toHaveProperty("id");
  });

  it("rejects envelopes that are not JSON-RPC 2.0", () => {
    expect(parseRpcBody({ id: 1, method: "ping" })).toBeNull();
    expect(parseRpcBody({ jsonrpc: "1.0", method: "ping" })).toBeNull();
    expect(parseRpcBody({ jsonrpc: "2.0" })).toBeNull();
    expect(parseRpcBody({ jsonrpc: "2.0", method: "ping", params: [] })).toBeNull();
    expect(parseRpcBody({ jsonrpc: "2.0", method: "ping", id: { nested: true } })).toBeNull();
    expect(parseRpcBody([])).toBeNull();
  });

  it("builds results and errors with the id it was given", () => {
    expect(rpcResult(7, { ok: true })).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    expect(rpcError(null, RPC.methodNotFound, "nope")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32601, message: "nope" },
    });
  });

  it("echoes a protocol version it supports and falls back otherwise", () => {
    expect(negotiateProtocolVersion("2024-11-05")).toBe("2024-11-05");
    expect(negotiateProtocolVersion("1999-01-01")).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe("mcp routing", () => {
  it("claims /mcp and its subpaths only", () => {
    expect(isMcpRoute("/mcp")).toBe(true);
    expect(isMcpRoute("/mcp/")).toBe(true);
    expect(isMcpRoute("/mcp/messages")).toBe(true);
    expect(isMcpRoute("/api/mcp")).toBe(false);
    expect(isMcpRoute("/mcpx")).toBe(false);
  });

  it("only frames as SSE when the client will not take JSON", () => {
    expect(wantsSse("application/json, text/event-stream")).toBe(false);
    expect(wantsSse("text/event-stream")).toBe(true);
    expect(wantsSse(null)).toBe(false);
  });
});

describe("mcp catalogue", () => {
  it("converts every registered tool to a usable JSON Schema", () => {
    for (const def of toolRegistry) {
      const schema = jsonSchemaFor(def.name, def.inputSchema);
      expect(schema["type"], def.name).toBe("object");
      expect(schema["properties"], def.name).toBeTypeOf("object");
      // `$schema` confuses some clients and carries nothing MCP needs.
      expect(schema, def.name).not.toHaveProperty("$schema");
    }
  });

  it("shows a read-scope token nothing but read tools, and no assistant turn", () => {
    const tools = catalogFor("read", "owner");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
    expect(tools.some((tool) => tool.name === ASK_ASSISTANT)).toBe(false);
  });

  it("offers the assistant turn first on a full-scope token", () => {
    const tools = catalogFor("full", "owner");
    expect(tools[0]?.name).toBe(ASK_ASSISTANT);
    expect(tools.length).toBeGreaterThan(catalogFor("read", "owner").length);
  });

  it("gives a viewer the same surface as a read-scope token", () => {
    const viewer = catalogFor("full", "viewer");
    expect(viewer.some((tool) => tool.name === ASK_ASSISTANT)).toBe(false);
    expect(viewer.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
  });

  it("marks destructive tools so a client can warn before running them", () => {
    const destructive = toolRegistry.filter((def) => def.irreversible || def.permissionLevel === "destructive");
    const listed = catalogFor("full", "owner");
    for (const def of destructive) {
      const tool = listed.find((entry) => entry.name === def.name);
      expect(tool?.annotations.destructiveHint, def.name).toBe(true);
      expect(tool?.description, def.name).toContain("cannot be undone");
    }
  });

  it("keeps write tools out of a read grant at the gate as well as the listing", () => {
    const write = toolRegistry.find((def) => def.permissionLevel !== "read");
    expect(write).toBeDefined();
    expect(toolAllowed(write!, "read", "owner")).toBe(false);
    expect(toolAllowed(write!, "full", "owner")).toBe(true);
    expect(toolAllowed(write!, "full", "viewer")).toBe(false);
  });

  it("validates ask_assistant input", () => {
    expect(parseAskAssistantInput({ message: "what is due today?" })).toEqual({
      message: "what is due today?",
    });
    expect(() => parseAskAssistantInput({ message: "" })).toThrow();
    expect(() => parseAskAssistantInput({})).toThrow();
  });
});

describe("mcp credentials", () => {
  const payload = (over: Partial<McpPayload> = {}): McpPayload => ({
    u: "11111111-2222-3333-4444-555555555555",
    e: seconds(NOW) + 3600,
    i: seconds(NOW),
    n: "rotation-nonce",
    s: "full",
    ...over,
  });

  it("round-trips an mcp token", async () => {
    const token = await mintToken(SECRET, "mcp", payload());
    expect(await verifyToken<McpPayload>(SECRET, "mcp", token, NOW)).toEqual(payload());
  });

  it("rejects a session cookie replayed as an mcp token", async () => {
    // Domain separation: same secret, same body, different purpose prefix.
    const token = await mintToken(SECRET, "session", payload());
    expect(await verifyToken(SECRET, "mcp", token, NOW)).toBeNull();
  });

  it("rejects an mcp token once it has expired", async () => {
    const token = await mintToken(SECRET, "mcp", payload({ e: seconds(NOW) - 1 }));
    expect(await verifyToken(SECRET, "mcp", token, NOW)).toBeNull();
  });

  it("reads a bearer credential case-insensitively and ignores anything else", () => {
    const withHeader = (value: string) =>
      bearerToken(new Request("https://example.com/mcp", { headers: { authorization: value } }));
    expect(withHeader("Bearer abc.def")).toBe("abc.def");
    expect(withHeader("bearer abc.def")).toBe("abc.def");
    expect(withHeader("Basic abc.def")).toBeNull();
    expect(withHeader("Bearer ")).toBeNull();
    expect(bearerToken(new Request("https://example.com/mcp"))).toBeNull();
  });

  it("accepts only the two scopes it defines", () => {
    expect(isMcpScope("read")).toBe(true);
    expect(isMcpScope("full")).toBe(true);
    expect(isMcpScope("admin")).toBe(false);
    expect(isMcpScope(undefined)).toBe(false);
  });
});
