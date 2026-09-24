import { describe, expect, it } from "vitest";
import { needsConfirmation } from "../../src/security/autonomy";
import type { ConfirmationDecision } from "../../src/security/autonomy";
import { hasRoleAtLeast, roleAllowsPermission } from "../../src/security/rbac";
import type { PermissionLevel } from "../../src/security/rbac";
import { takeToken } from "../../src/security/ratelimit";
import { redactToolArgs, summarizeToolResult } from "../../src/security/redact";

const LEVELS: PermissionLevel[] = ["read", "write", "destructive", "external"];
const AUTONOMIES = [0, 1, 2, 3] as const;

describe("needsConfirmation", () => {
  // Expected matrix with no flags: [level][autonomy] -> requires.
  const BASE: Record<PermissionLevel, Record<number, boolean>> = {
    read: { 0: false, 1: false, 2: false, 3: false },
    write: { 0: true, 1: false, 2: false, 3: false },
    destructive: { 0: true, 1: true, 2: true, 3: false },
    external: { 0: true, 1: true, 2: false, 3: false },
  };

  for (const level of LEVELS) {
    for (const autonomy of AUTONOMIES) {
      const requires = BASE[level][autonomy] as boolean;
      it(`${level} @ autonomy ${autonomy} -> ${requires ? "confirm" : "pass"}`, () => {
        const expected: ConfirmationDecision = requires
          ? { requires: true, reason: "autonomy" }
          : { requires: false, reason: "none" };
        expect(needsConfirmation({ level, autonomy })).toEqual(expected);
      });
    }
  }

  it("destructive + irreversible confirms even at autonomy 3", () => {
    expect(
      needsConfirmation({ level: "destructive", autonomy: 3, irreversible: true })
    ).toEqual({ requires: true, reason: "irreversible" });
  });

  it("irreversible outranks autonomy as the reason at lower autonomy", () => {
    for (const autonomy of [0, 1, 2]) {
      expect(
        needsConfirmation({ level: "destructive", autonomy, irreversible: true })
      ).toEqual({ requires: true, reason: "irreversible" });
    }
  });

  it("irreversible does not change non-destructive rows", () => {
    expect(
      needsConfirmation({ level: "read", autonomy: 0, irreversible: true })
    ).toEqual({ requires: false, reason: "none" });
    expect(
      needsConfirmation({ level: "write", autonomy: 3, irreversible: true })
    ).toEqual({ requires: false, reason: "none" });
  });

  it("toolFlag always confirms and outranks every other reason", () => {
    for (const level of LEVELS) {
      for (const autonomy of AUTONOMIES) {
        expect(
          needsConfirmation({ level, autonomy, toolFlag: true, irreversible: true })
        ).toEqual({ requires: true, reason: "tool_flag" });
      }
    }
  });
});

describe("roleAllowsPermission", () => {
  it("viewer is read-only", () => {
    expect(roleAllowsPermission("viewer", "read")).toBe(true);
    expect(roleAllowsPermission("viewer", "write")).toBe(false);
    expect(roleAllowsPermission("viewer", "destructive")).toBe(false);
    expect(roleAllowsPermission("viewer", "external")).toBe(false);
  });

  it("user, admin, and owner get every level", () => {
    for (const role of ["user", "admin", "owner"] as const) {
      for (const level of LEVELS) {
        expect(roleAllowsPermission(role, level)).toBe(true);
      }
    }
  });
});

describe("hasRoleAtLeast", () => {
  it("respects owner > admin > user > viewer", () => {
    expect(hasRoleAtLeast("owner", "admin")).toBe(true);
    expect(hasRoleAtLeast("owner", "owner")).toBe(true);
    expect(hasRoleAtLeast("admin", "admin")).toBe(true);
    expect(hasRoleAtLeast("admin", "owner")).toBe(false);
    expect(hasRoleAtLeast("user", "viewer")).toBe(true);
    expect(hasRoleAtLeast("user", "admin")).toBe(false);
    expect(hasRoleAtLeast("viewer", "viewer")).toBe(true);
    expect(hasRoleAtLeast("viewer", "user")).toBe(false);
  });
});

describe("takeToken", () => {
  const opts = { capacity: 2, refillPerMinute: 1 };

  it("null state initializes a full bucket", () => {
    const r = takeToken(null, 1_000, { capacity: 5, refillPerMinute: 1 });
    expect(r.allowed).toBe(true);
    expect(r.state).toEqual({ tokens: 4, lastRefillMs: 1_000 });
  });

  it("drains to zero then denies", () => {
    let r = takeToken(null, 0, opts);
    expect(r.allowed).toBe(true);
    r = takeToken(r.state, 0, opts);
    expect(r.allowed).toBe(true);
    expect(r.state.tokens).toBe(0);
    r = takeToken(r.state, 0, opts);
    expect(r.allowed).toBe(false);
    expect(r.state.tokens).toBe(0);
  });

  it("refills continuously and accumulates across denials", () => {
    let r = takeToken({ tokens: 0, lastRefillMs: 0 }, 30_000, opts);
    // 0.5 min * 1/min = 0.5 tokens: still short of one.
    expect(r.allowed).toBe(false);
    expect(r.state.tokens).toBeCloseTo(0.5, 10);
    expect(r.state.lastRefillMs).toBe(30_000);
    // Another 30s brings it to a full token.
    r = takeToken(r.state, 60_000, opts);
    expect(r.allowed).toBe(true);
    expect(r.state.tokens).toBeCloseTo(0, 10);
  });

  it("caps refill at capacity", () => {
    let r = takeToken({ tokens: 0, lastRefillMs: 0 }, 3_600_000, opts);
    // An hour would refill 60 tokens; capacity holds it at 2.
    expect(r.allowed).toBe(true);
    expect(r.state.tokens).toBe(1);
    r = takeToken(r.state, 3_600_000, opts);
    expect(r.allowed).toBe(true);
    r = takeToken(r.state, 3_600_000, opts);
    expect(r.allowed).toBe(false);
  });

  it("ignores a clock that moved backwards", () => {
    const r = takeToken(
      { tokens: 0.5, lastRefillMs: 60_000 },
      0,
      { capacity: 10, refillPerMinute: 100 }
    );
    expect(r.allowed).toBe(false);
    expect(r.state.tokens).toBeCloseTo(0.5, 10);
  });
});

describe("redactToolArgs", () => {
  it("masks sensitive keys, truncates long strings, caps arrays", () => {
    const out = redactToolArgs({
      api_key: "sk-live-abc",
      text: "x".repeat(300),
      items: Array.from({ length: 25 }, (_, i) => i),
    }) as Record<string, unknown>;
    expect(out.api_key).toBe("[redacted]");
    expect((out.text as string).length).toBe(200);
    expect(out.items).toHaveLength(10);
  });
});

describe("summarizeToolResult", () => {
  it("stringifies JSON and truncates", () => {
    expect(summarizeToolResult({ ok: true }, 100)).toBe('{"ok":true}');
    expect(summarizeToolResult({ text: "y".repeat(500) }, 50)).toHaveLength(50);
  });

  it("falls back to String() when JSON.stringify cannot produce a string", () => {
    expect(summarizeToolResult(undefined, 100)).toBe("undefined");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summarizeToolResult(circular, 100)).toBe("[object Object]");
  });
});
