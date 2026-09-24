import { describe, expect, it } from "vitest";
import {
  HttpError,
  assertSameOrigin,
  assertUuid,
  bool,
  definedOnly,
  isoDate,
  matchPath,
  nullableStr,
  num,
  oneOf,
  queryLimit,
  readJsonBody,
  requiredStr,
  str,
  strArray,
  uuid,
} from "../../src/web/http";

const UUID = "11111111-2222-3333-4444-555555555555";

describe("matchPath", () => {
  it("captures named segments", () => {
    expect(matchPath("/api/tasks/:id", "/api/tasks/abc")).toEqual({ id: "abc" });
    expect(matchPath("/api/conversations/:id/messages", "/api/conversations/x/messages")).toEqual({ id: "x" });
  });

  it("rejects a different shape", () => {
    expect(matchPath("/api/tasks/:id", "/api/tasks")).toBeNull();
    expect(matchPath("/api/tasks/:id", "/api/tasks/a/b")).toBeNull();
    expect(matchPath("/api/tasks/:id", "/api/notes/a")).toBeNull();
  });

  it("rejects an empty capture rather than matching a trailing slash", () => {
    expect(matchPath("/api/tasks/:id", "/api/tasks/")).toBeNull();
  });

  it("decodes percent-encoded segments", () => {
    expect(matchPath("/api/facts/:key", "/api/facts/work%20email")).toEqual({ key: "work email" });
  });
});

describe("field coercion", () => {
  it("distinguishes absent from cleared", () => {
    expect(str({}, "a")).toBeUndefined();
    expect(nullableStr({}, "a")).toBeUndefined();
    expect(nullableStr({ a: "" }, "a")).toBeNull();
    expect(nullableStr({ a: null }, "a")).toBeNull();
    expect(nullableStr({ a: "x" }, "a")).toBe("x");
  });

  it("rejects wrong types", () => {
    expect(() => str({ a: 1 }, "a")).toThrow(HttpError);
    expect(() => bool({ a: "true" }, "a")).toThrow(HttpError);
    expect(() => strArray({ a: "x" }, "a")).toThrow(HttpError);
    expect(() => strArray({ a: [1] }, "a")).toThrow(HttpError);
  });

  it("enforces length and range limits", () => {
    expect(() => str({ a: "abcdef" }, "a", 3)).toThrow(/exceeds 3/);
    expect(() => num({ a: 9 }, "a", 0, 3)).toThrow(/between 0 and 3/);
    expect(num({ a: 2 }, "a", 0, 3)).toBe(2);
    expect(num({ a: "2" }, "a", 0, 3)).toBe(2);
    expect(() => num({ a: "abc" }, "a", 0, 3)).toThrow(HttpError);
  });

  it("requires non-blank values for required strings", () => {
    expect(() => requiredStr({ a: "   " }, "a")).toThrow(/required/);
    expect(requiredStr({ a: " x " }, "a")).toBe(" x ");
  });

  it("validates enums", () => {
    expect(oneOf({ a: "todo" }, "a", ["todo", "done"] as const)).toBe("todo");
    expect(() => oneOf({ a: "nope" }, "a", ["todo", "done"] as const)).toThrow(/must be one of/);
  });

  it("normalises and validates timestamps", () => {
    expect(isoDate({ a: "2026-08-27T09:00:00Z" }, "a")).toBe("2026-08-27T09:00:00.000Z");
    expect(isoDate({ a: "" }, "a")).toBeNull();
    expect(() => isoDate({ a: "not a date" }, "a")).toThrow(/valid timestamp/);
  });

  it("validates uuids", () => {
    expect(uuid({ a: UUID }, "a")).toBe(UUID);
    expect(uuid({ a: "" }, "a")).toBeNull();
    expect(() => uuid({ a: "abc" }, "a")).toThrow(/must be a uuid/);
    expect(() => assertUuid("abc", "task id")).toThrow(/task id must be a uuid/);
  });

  it("trims and drops blank tags", () => {
    expect(strArray({ a: [" one ", "", "two"] }, "a")).toEqual(["one", "two"]);
    expect(() => strArray({ a: Array(50).fill("x") }, "a", 40)).toThrow(/at most 40/);
  });
});

describe("definedOnly", () => {
  it("keeps nulls but drops undefined", () => {
    expect(definedOnly({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });
});

describe("queryLimit", () => {
  const u = (qs: string) => new URL(`https://x.dev/api/tasks${qs}`);

  it("falls back and caps", () => {
    expect(queryLimit(u(""), 25, 100)).toBe(25);
    expect(queryLimit(u("?limit=10"), 25, 100)).toBe(10);
    expect(queryLimit(u("?limit=5000"), 25, 100)).toBe(100);
    expect(queryLimit(u("?limit=abc"), 25, 100)).toBe(25);
    expect(queryLimit(u("?limit=-3"), 25, 100)).toBe(25);
  });
});

describe("readJsonBody", () => {
  const post = (body: string, type = "application/json") =>
    new Request("https://x.dev/api/tasks", { method: "POST", body, headers: { "content-type": type } });

  it("accepts a JSON object", async () => {
    expect(await readJsonBody(post('{"a":1}'))).toEqual({ a: 1 });
  });

  it("rejects non-objects and bad JSON", async () => {
    await expect(readJsonBody(post("[1,2]"))).rejects.toThrow(/must be a JSON object/);
    await expect(readJsonBody(post("null"))).rejects.toThrow(/must be a JSON object/);
    await expect(readJsonBody(post("{oops"))).rejects.toThrow(/valid JSON/);
    await expect(readJsonBody(post("{}", "text/plain"))).rejects.toThrow(/content-type/);
  });
});

describe("assertSameOrigin", () => {
  const url = new URL("https://app.dev/api/tasks");
  const post = (headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers });

  it("allows a matching Origin and a missing one", () => {
    expect(() => assertSameOrigin(post({ origin: "https://app.dev" }), url)).not.toThrow();
    expect(() => assertSameOrigin(post(), url)).not.toThrow();
  });

  it("rejects a foreign Origin", () => {
    expect(() => assertSameOrigin(post({ origin: "https://evil.dev" }), url)).toThrow(/cross-origin/);
  });

  it("allows Origin: null when Sec-Fetch-Site proves it is same-origin", () => {
    // A `no-referrer` document posts same-origin with a null Origin; the login
    // page hit exactly this and was rejected.
    expect(() =>
      assertSameOrigin(post({ origin: "null", "sec-fetch-site": "same-origin" }), url)
    ).not.toThrow();
  });

  it("still rejects Origin: null from a genuinely cross-site post", () => {
    expect(() =>
      assertSameOrigin(post({ origin: "null", "sec-fetch-site": "cross-site" }), url)
    ).toThrow(/cross-origin/);
    expect(() => assertSameOrigin(post({ origin: "null" }), url)).toThrow(/cross-origin/);
  });

  it("does not accept Sec-Fetch-Site as a licence for a foreign Origin", () => {
    expect(() =>
      assertSameOrigin(post({ origin: "https://evil.dev", "sec-fetch-site": "same-origin" }), url)
    ).toThrow(/cross-origin/);
  });
});
