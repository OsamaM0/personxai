import { describe, expect, it } from "vitest";
import { md, paginate, parseListArgs } from "../../src/agent/lists";

describe("parseListArgs", () => {
  it("splits hashtags, key:value options, and free text", () => {
    expect(parseListArgs("thesis #pdf #Papers by:tag kind:photo")).toEqual({
      q: "thesis",
      tg: ["pdf", "papers"],
      by: "tag",
      kd: "photo",
    });
  });

  it("accepts status, channel and group aliases", () => {
    expect(parseListArgs("status:done group:project in:Research")).toEqual({
      st: "done",
      by: "project",
      ch: "Research",
    });
  });

  it("ignores unknown group values and lone hashes", () => {
    expect(parseListArgs("by:banana # foo")).toEqual({ q: "# foo" });
  });

  it("returns an empty object for no args", () => {
    expect(parseListArgs("   ")).toEqual({});
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 14 }, (_, i) => i);

  it("slices pages of the requested size", () => {
    expect(paginate(items, 0, 6)).toEqual({ slice: [0, 1, 2, 3, 4, 5], page: 0, pages: 3 });
    expect(paginate(items, 2, 6)).toEqual({ slice: [12, 13], page: 2, pages: 3 });
  });

  it("clamps out-of-range pages instead of returning an empty slice", () => {
    expect(paginate(items, 9, 6).page).toBe(2);
    expect(paginate(items, -3, 6).page).toBe(0);
  });

  it("always reports at least one page", () => {
    expect(paginate([], 0, 6)).toEqual({ slice: [], page: 0, pages: 1 });
  });
});

describe("md", () => {
  it("escapes Telegram Markdown control characters in user content", () => {
    expect(md("a*b_c`d[e")).toBe("a\\*b\\_c\\`d\\[e");
  });
});
