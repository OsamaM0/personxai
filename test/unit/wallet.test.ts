import { describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import {
  DEFAULT_CURRENCY,
  formatMoney,
  formatQuantity,
  normalizeCurrency,
  parseAmount,
  round2,
} from "../../src/utils/money";
import { localPeriodRange, parseLocalPeriod } from "../../src/scheduler/tz";
import { parseListArgs } from "../../src/agent/lists";
import { selectTopics } from "../../src/tools/topics";

const CAIRO = "Africa/Cairo";
const NOW = new Date("2026-08-29T10:00:00Z");

describe("parseAmount", () => {
  it("accepts numbers, plain strings, and grouped strings", () => {
    expect(parseAmount(25)).toBe(25);
    expect(parseAmount("25")).toBe(25);
    expect(parseAmount("1,250.50")).toBe(1250.5);
    expect(parseAmount("25 LE")).toBe(25);
  });

  it("reads Arabic-Indic digits", () => {
    expect(parseAmount("٢٥")).toBe(25);
    expect(parseAmount("١٢٫٥")).toBe(12.5);
  });

  it("rejects anything that is not a positive amount", () => {
    expect(parseAmount("free")).toBeNull();
    expect(parseAmount(0)).toBeNull();
    expect(parseAmount(-5)).toBeNull();
    expect(parseAmount("-5")).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });

  it("rounds to two decimals", () => {
    expect(parseAmount("10.005")).toBe(10.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe("normalizeCurrency", () => {
  it("maps colloquial spellings and symbols to ISO codes", () => {
    expect(normalizeCurrency("LE")).toBe("EGP");
    expect(normalizeCurrency("جنيه")).toBe("EGP");
    expect(normalizeCurrency("$")).toBe("USD");
  });

  it("falls back to the default and keeps unknown codes", () => {
    expect(normalizeCurrency("")).toBe(DEFAULT_CURRENCY);
    expect(normalizeCurrency(null)).toBe(DEFAULT_CURRENCY);
    expect(normalizeCurrency("xyz")).toBe("XYZ");
  });
});

describe("formatMoney", () => {
  it("drops the decimals on whole amounts and keeps them otherwise", () => {
    expect(formatMoney(25, "EGP")).toBe("25 EGP");
    expect(formatMoney(1250.5, "EGP")).toBe("1,250.50 EGP");
  });

  it("renders quantities with their unit", () => {
    expect(formatQuantity(2, "kg")).toBe("2 kg");
    expect(formatQuantity(1.5, null)).toBe("1.5");
    expect(formatQuantity(null, "kg")).toBe("");
  });
});

describe("localPeriodRange", () => {
  const wall = (iso: string | null) =>
    iso === null ? null : formatInTimeZone(new Date(iso), CAIRO, "yyyy-MM-dd HH:mm");

  it("bounds today by the user's own midnight", () => {
    const range = localPeriodRange("today", CAIRO, NOW);
    expect(wall(range.from)).toBe("2026-08-29 00:00");
    expect(wall(range.to)).toBe("2026-08-30 00:00");
  });

  it("puts yesterday immediately before today", () => {
    const yesterday = localPeriodRange("yesterday", CAIRO, NOW);
    expect(wall(yesterday.from)).toBe("2026-08-28 00:00");
    expect(yesterday.to).toBe(localPeriodRange("today", CAIRO, NOW).from);
  });

  it("treats a week as the rolling last seven days", () => {
    const range = localPeriodRange("week", CAIRO, NOW);
    expect(wall(range.from)).toBe("2026-08-23 00:00");
    expect(wall(range.to)).toBe("2026-08-30 00:00");
  });

  it("uses the calendar month and year", () => {
    expect(wall(localPeriodRange("month", CAIRO, NOW).from)).toBe("2026-08-01 00:00");
    expect(wall(localPeriodRange("month", CAIRO, NOW).to)).toBe("2026-09-01 00:00");
    expect(wall(localPeriodRange("year", CAIRO, NOW).from)).toBe("2026-01-01 00:00");
    expect(wall(localPeriodRange("year", CAIRO, NOW).to)).toBe("2027-01-01 00:00");
  });

  it("leaves 'all' unbounded", () => {
    expect(localPeriodRange("all", CAIRO, NOW)).toEqual({ period: "all", from: null, to: null });
  });

  it("windows are half-open, so consecutive months never double-count", () => {
    const august = localPeriodRange("month", CAIRO, NOW);
    const september = localPeriodRange("month", CAIRO, new Date("2026-09-15T10:00:00Z"));
    expect(august.to).toBe(september.from);
  });

  it("falls back to UTC for an unknown timezone instead of throwing", () => {
    const range = localPeriodRange("today", "Not/AZone", NOW);
    expect(range.from).toBe("2026-08-29T00:00:00.000Z");
  });
});

describe("parseLocalPeriod", () => {
  it("understands English and Arabic period words", () => {
    expect(parseLocalPeriod("today")).toBe("today");
    expect(parseLocalPeriod("النهاردة")).toBe("today");
    expect(parseLocalPeriod("شهر")).toBe("month");
    expect(parseLocalPeriod("ALL")).toBe("all");
  });

  it("returns null for anything else, so it stays a search term", () => {
    expect(parseLocalPeriod("sugar")).toBeNull();
    expect(parseLocalPeriod("")).toBeNull();
  });
});

describe("parseListArgs with wallet filters", () => {
  it("reads cat: as the category and dir: as the direction", () => {
    expect(parseListArgs("cat:groceries dir:out #food sugar")).toEqual({
      kd: "groceries",
      st: "out",
      tg: ["food"],
      q: "sugar",
    });
  });

  it("accepts category grouping", () => {
    expect(parseListArgs("by:category")).toEqual({ by: "category" });
  });
});

describe("selectTopics for money talk", () => {
  it("matches English spending phrasing", () => {
    expect(selectTopics("I bought 2 kg of sugar for 25 LE")).toContain("wallet");
    expect(selectTopics("how much did I spend this month?")).toContain("wallet");
  });

  it("matches Arabic and Egyptian phrasing", () => {
    expect(selectTopics("صرفت 25 جنيه على السكر")).toContain("wallet");
    expect(selectTopics("مرتبي نزل النهاردة")).toContain("wallet");
    expect(selectTopics("فلوسي راحت فين؟")).toContain("wallet");
  });
});
