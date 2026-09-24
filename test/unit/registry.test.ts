import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, toAiToolSet, ToolCallCollector } from "../../src/tools/registry";
import type { AgentContext } from "../../src/agent/context";
import type { SqlExecutor } from "../../src/agent/do-schema";
import type { OutboundButton } from "../../src/channels/types";

/** Minimal in-memory stand-in for the DO's SQLite, covering the callbacks table. */
function fakeSql(): SqlExecutor & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const q = strings.join("?");
      if (q.includes("INSERT INTO callbacks")) {
        const [token, kind, payload, created_at, expires_at] = values;
        rows.set(String(token), { token, kind, payload, created_at, expires_at, consumed: 0 });
        return [];
      }
      if (q.includes("SELECT token, kind, payload")) {
        const row = rows.get(String(values[0]));
        return row ? ([row] as T[]) : [];
      }
      if (q.includes("UPDATE callbacks SET consumed")) {
        const row = rows.get(String(values[0]));
        if (row) row["consumed"] = 1;
        return [];
      }
      if (q.includes("DELETE FROM callbacks WHERE expires_at")) return [];
      if (q.includes("SELECT COUNT(*)")) return [{ n: rows.size } as T];
      if (q.includes("DELETE FROM callbacks")) {
        rows.clear();
        return [];
      }
      return [];
    },
  };
}

interface SentButtons {
  text: string;
  buttons: OutboundButton[][];
}

function fakeCtx(overrides: { autonomy?: number; role?: string } = {}) {
  const sent: SentButtons[] = [];
  const sql = fakeSql();
  const ctx = {
    env: {},
    config: {
      limits: {
        toolTimeoutMs: 200,
        toolResultChars: 300,
        toolBudgetPerTurn: 12,
      },
    },
    db: {},
    user: {
      id: "u1",
      role: overrides.role ?? "owner",
      autonomy_level: overrides.autonomy ?? 1,
      timezone: "UTC",
      language: "en",
    },
    identity: {},
    conversation: { id: "c1" },
    locale: "en",
    out: {
      sendText: async () => undefined,
      sendButtons: async (_chat: string, text: string, buttons: OutboundButton[][]) => {
        sent.push({ text, buttons });
        return "1";
      },
      editText: async () => {},
      chatAction: async () => {},
      answerCallback: async () => {},
    },
    chatRef: "chat1",
    channel: "telegram",
    do: sql,
    now: new Date("2026-08-27T10:00:00Z"),
    waitUntil: () => {},
  } as unknown as AgentContext;
  return { ctx, sent, sql };
}

const echoTool = defineTool({
  name: "echo",
  description: "echo",
  inputSchema: z.object({ v: z.string() }),
  topics: ["tasks"],
  permissionLevel: "read",
  execute: async (input) => ({ echoed: input.v }),
});

async function callTool(set: Record<string, unknown>, name: string, input: unknown) {
  const tool = set[name] as { execute: (i: unknown, opts: unknown) => Promise<unknown> };
  return tool.execute(input, { toolCallId: "t1", messages: [] });
}

describe("tool registry gate", () => {
  it("executes a read tool and records the call", async () => {
    const { ctx } = fakeCtx();
    const collector = new ToolCallCollector(12);
    const set = toAiToolSet([echoTool], ctx, collector);
    const result = await callTool(set, "echo", { v: "hi" });
    expect(result).toEqual({ echoed: "hi" });
    expect(collector.rows).toHaveLength(1);
    expect(collector.rows[0]?.status).toBe("ok");
  });

  it("denies tools beyond the viewer role", async () => {
    const { ctx } = fakeCtx({ role: "viewer" });
    const writeTool = defineTool({ ...echoTool, name: "w", permissionLevel: "write" });
    const collector = new ToolCallCollector(12);
    const set = toAiToolSet([writeTool], ctx, collector);
    const result = (await callTool(set, "w", { v: "x" })) as { error?: string };
    expect(result.error).toMatch(/permission denied/);
  });

  it("sends confirmation buttons for write tools at autonomy 0 instead of executing", async () => {
    const { ctx, sent, sql } = fakeCtx({ autonomy: 0 });
    let executed = false;
    const writeTool = defineTool({
      name: "make",
      description: "make",
      inputSchema: z.object({ v: z.string() }),
      topics: ["tasks"],
      permissionLevel: "write",
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });
    const collector = new ToolCallCollector(12);
    const set = toAiToolSet([writeTool], ctx, collector);
    const result = (await callTool(set, "make", { v: "x" })) as { status?: string };
    expect(result.status).toBe("awaiting_confirmation");
    expect(executed).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.buttons[0]).toHaveLength(2);
    expect(sql.rows.size).toBe(1);
    const data = sent[0]?.buttons[0]?.[0]?.data ?? "";
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  });

  it("suppresses duplicate creates in the same turn", async () => {
    const { ctx } = fakeCtx();
    let count = 0;
    const createTool = defineTool({
      name: "mk",
      description: "mk",
      inputSchema: z.object({ v: z.string() }),
      topics: ["tasks"],
      permissionLevel: "write",
      isCreate: true,
      execute: async () => {
        count++;
        return { n: count };
      },
    });
    const collector = new ToolCallCollector(12);
    const set = toAiToolSet([createTool], ctx, collector);
    await callTool(set, "mk", { v: "same" });
    const second = (await callTool(set, "mk", { v: "same" })) as { error?: string };
    expect(count).toBe(1);
    expect(second.error).toMatch(/duplicate/);
  });

  it("stops when the tool budget is exhausted", async () => {
    const { ctx } = fakeCtx();
    const collector = new ToolCallCollector(1);
    const set = toAiToolSet([echoTool], ctx, collector);
    await callTool(set, "echo", { v: "1" });
    const second = (await callTool(set, "echo", { v: "2" })) as { error?: string };
    expect(second.error).toMatch(/budget/);
  });

  it("times out slow tools and reports the error to the model", async () => {
    const { ctx } = fakeCtx();
    const slow = defineTool({
      name: "slow",
      description: "slow",
      inputSchema: z.object({}),
      topics: ["tasks"],
      permissionLevel: "read",
      timeoutMs: 30,
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5000)),
    });
    const collector = new ToolCallCollector(12);
    const set = toAiToolSet([slow], ctx, collector);
    const result = (await callTool(set, "slow", {})) as { error?: string };
    expect(result.error).toMatch(/timed out/);
  });

  it("truncates oversized results", async () => {
    const { ctx } = fakeCtx();
    const big = defineTool({
      name: "big",
      description: "big",
      inputSchema: z.object({}),
      topics: ["tasks"],
      permissionLevel: "read",
      execute: async () => ({ blob: "x".repeat(5000) }),
    });
    const collector = new ToolCallCollector(12);
    const set = toAiToolSet([big], ctx, collector);
    const result = (await callTool(set, "big", {})) as { truncated?: boolean; summary?: string };
    expect(result.truncated).toBe(true);
    expect((result.summary ?? "").length).toBeLessThanOrEqual(320);
  });

  it("returns zod validation problems as tool errors", async () => {
    const { ctx } = fakeCtx();
    const collector = new ToolCallCollector(12);
    const set = toAiToolSet([echoTool], ctx, collector);
    const result = (await callTool(set, "echo", { v: 42 })) as { error?: string };
    expect(result.error).toBeTruthy();
  });
});
