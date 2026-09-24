import { describe, expect, it } from "vitest";
import { gateMcpTools, getMcpExecutor } from "../../src/mcp/permissions";
import { ToolCallCollector } from "../../src/tools/registry";
import type { AgentContext } from "../../src/agent/context";
import type { OutboundButton } from "../../src/channels/types";
import type { SqlExecutor } from "../../src/agent/do-schema";

function fakeSql(): SqlExecutor {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const q = strings.join("?");
      if (q.includes("INSERT INTO callbacks")) {
        const [token, kind, payload] = values;
        rows.set(String(token), { token, kind, payload, consumed: 0, expires_at: Number.MAX_SAFE_INTEGER });
        return [];
      }
      if (q.includes("SELECT token, kind, payload")) {
        const row = rows.get(String(values[0]));
        return row ? ([row] as T[]) : [];
      }
      return [];
    },
  };
}

function ctxWith(autonomy: number) {
  const sent: { text: string; buttons: OutboundButton[][] }[] = [];
  const ctx = {
    config: { limits: { toolTimeoutMs: 500, toolResultChars: 300, toolBudgetPerTurn: 12 } },
    user: { id: "u1", role: "owner", autonomy_level: autonomy },
    locale: "en",
    chatRef: "c1",
    do: fakeSql(),
    now: new Date("2026-08-27T10:00:00Z"),
    out: {
      sendText: async () => undefined,
      sendButtons: async (_c: string, text: string, buttons: OutboundButton[][]) => {
        sent.push({ text, buttons });
        return "1";
      },
      editText: async () => {},
      chatAction: async () => {},
      answerCallback: async () => {},
    },
  } as unknown as AgentContext;
  return { ctx, sent };
}

function rawTool(onCall: () => void) {
  return {
    github_search: {
      description: "search github",
      inputSchema: { type: "object" } as never,
      execute: async (input: unknown) => {
        onCall();
        return { ok: true, echo: input };
      },
    },
  } as never;
}

async function call(set: Record<string, unknown>, name: string, input: unknown) {
  const tool = set[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> };
  return tool.execute(input, { toolCallId: "t", messages: [] });
}

describe("MCP tool gate", () => {
  it("runs external tools directly at autonomy 2+", async () => {
    let called = false;
    const { ctx } = ctxWith(2);
    const collector = new ToolCallCollector(12);
    const gated = gateMcpTools(rawTool(() => { called = true; }), ctx, collector);
    const result = (await call(gated as never, "github_search", { q: "x" })) as { ok?: boolean };
    expect(called).toBe(true);
    expect(result.ok).toBe(true);
    expect(collector.rows[0]?.tool_name).toBe("mcp:github_search");
  });

  it("requires confirmation at autonomy 0 and 1", async () => {
    for (const level of [0, 1]) {
      let called = false;
      const { ctx, sent } = ctxWith(level);
      const collector = new ToolCallCollector(12);
      const gated = gateMcpTools(rawTool(() => { called = true; }), ctx, collector);
      const result = (await call(gated as never, "github_search", { q: "x" })) as { status?: string };
      expect(result.status).toBe("awaiting_confirmation");
      expect(called).toBe(false);
      expect(sent).toHaveLength(1);
      const data = sent[0]?.buttons[0]?.[0]?.data ?? "";
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }
  });

  it("registers an executor so confirmed calls can run later", async () => {
    const { ctx } = ctxWith(0);
    const collector = new ToolCallCollector(12);
    gateMcpTools(rawTool(() => {}), ctx, collector);
    expect(typeof getMcpExecutor("github_search")).toBe("function");
  });

  it("respects the per-turn tool budget", async () => {
    const { ctx } = ctxWith(3);
    const collector = new ToolCallCollector(1);
    const gated = gateMcpTools(rawTool(() => {}), ctx, collector);
    await call(gated as never, "github_search", { q: "1" });
    const second = (await call(gated as never, "github_search", { q: "2" })) as { error?: string };
    expect(second.error).toMatch(/budget/);
  });
});
