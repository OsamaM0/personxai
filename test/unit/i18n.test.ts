import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  isRtl,
  resolveLocale,
  t,
  type Locale,
  type MessageKey,
} from "../../src/i18n";
import { ar } from "../../src/i18n/locales/ar";
import { arEG } from "../../src/i18n/locales/ar-eg";
import { en } from "../../src/i18n/locales/en";

const ALL_KEYS = Object.keys(en) as MessageKey[];
const LOCALES: Locale[] = ["en", "ar", "ar-EG"];
// Widened view so tests can probe keys the narrow arEG type does not declare.
const arEGTable: Partial<Record<MessageKey, string>> = arEG;

describe("message catalogs", () => {
  it("ar covers exactly the en key set", () => {
    expect(Object.keys(ar).sort()).toEqual([...ALL_KEYS].sort());
  });

  it("arEG only overrides keys that exist in en", () => {
    for (const key of Object.keys(arEG)) {
      expect(ALL_KEYS).toContain(key);
    }
  });

  it("every en key resolves to a non-empty string in all three locales", () => {
    for (const locale of LOCALES) {
      for (const key of ALL_KEYS) {
        const msg = t(locale, key);
        expect(msg, `${locale}:${key}`).toBeTypeOf("string");
        expect(msg.length, `${locale}:${key}`).toBeGreaterThan(0);
        // A raw key echo means the lookup fell through every catalog.
        expect(msg, `${locale}:${key}`).not.toBe(key);
      }
    }
  });

  it("translations use exactly the placeholders of the en template", () => {
    const placeholders = (s: string): string[] =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
    for (const key of ALL_KEYS) {
      const base = placeholders(en[key]);
      expect(placeholders(ar[key]), `ar:${key}`).toEqual(base);
      const override = arEGTable[key];
      if (override !== undefined) {
        expect(placeholders(override), `ar-EG:${key}`).toEqual(base);
      }
    }
  });
});

describe("t interpolation and fallback", () => {
  it("interpolates {param} placeholders (strings and numbers)", () => {
    expect(t("en", "tz_saved", { timezone: "Africa/Cairo" })).toContain("Africa/Cairo");
    const runs = t("en", "status_line_runs", {
      runs: 12,
      promptTokens: 3400,
      completionTokens: 890,
      period: "7d",
    });
    expect(runs).toContain("12");
    expect(runs).toContain("3400");
    expect(runs).toContain("890");
    expect(runs).toContain("7d");
    expect(runs).not.toMatch(/\{\w+\}/);
  });

  it("leaves placeholders intact when the param is missing", () => {
    expect(t("en", "tz_saved")).toContain("{timezone}");
    expect(t("en", "tz_saved", { other: "x" })).toContain("{timezone}");
  });

  it("interpolates in Arabic locales too", () => {
    expect(t("ar", "context_switched", { title: "مشروع العمل" })).toContain("مشروع العمل");
    expect(t("ar-EG", "confirm_prompt", { action: "delete note 5" })).toContain("delete note 5");
  });

  it("ar-EG falls back to ar for keys it does not override", () => {
    expect(arEGTable.help_text).toBeUndefined();
    expect(t("ar-EG", "help_text")).toBe(t("ar", "help_text"));
  });

  it("ar-EG overrides win over ar", () => {
    expect(t("ar-EG", "cancelled")).toBe(arEG.cancelled);
    expect(t("ar-EG", "cancelled")).not.toBe(t("ar", "cancelled"));
  });
});

describe("date/time formatting", () => {
  // 12:34 UTC = 14:34 in Africa/Cairo (UTC+2; Egypt DST starts late April).
  const iso = "2026-03-15T12:34:00Z";

  it("uses Latin digits for Arabic locales (no Arabic-Indic U+0660-0669)", () => {
    for (const locale of ["ar", "ar-EG"] as const) {
      const s = formatDateTime(iso, "Africa/Cairo", locale);
      expect(s, `${locale}:${s}`).not.toMatch(/[٠-٩]/);
      expect(s).toMatch(/[0-9]/);
      expect(s).toContain("2026");
      expect(s).toContain(":34");
    }
  });

  it("formats English with en-GB conventions in the target timezone", () => {
    const s = formatDateTime(iso, "Africa/Cairo", "en");
    expect(s).toContain("15");
    expect(s).toContain("Mar");
    expect(s).toContain("2026");
    expect(s).toContain("14:34"); // en-GB short time is 24h; Cairo is UTC+2 in March
  });

  it("formatDate renders the date only", () => {
    const s = formatDate(iso, "Africa/Cairo", "en");
    expect(s).toContain("15");
    expect(s).toContain("Mar");
    expect(s).toContain("2026");
    expect(s).not.toContain(":");
    expect(formatDate(iso, "Africa/Cairo", "ar-EG")).not.toMatch(/[٠-٩]/);
  });

  it("accepts Date objects and ISO strings interchangeably", () => {
    expect(formatDateTime(new Date(iso), "Africa/Cairo", "en")).toBe(
      formatDateTime(iso, "Africa/Cairo", "en"),
    );
  });

  it("degrades to UTC instead of throwing on an invalid stored timezone", () => {
    expect(formatDateTime(iso, "Not/AZone", "en")).toContain("12:34");
  });
});

describe("resolveLocale", () => {
  it("maps ar-EG variants to ar-EG", () => {
    expect(resolveLocale("ar-EG")).toBe("ar-EG");
    expect(resolveLocale("ar-eg")).toBe("ar-EG");
    expect(resolveLocale("AR_EG")).toBe("ar-EG");
  });

  it("maps other Arabic tags to ar", () => {
    expect(resolveLocale("ar")).toBe("ar");
    expect(resolveLocale("ar-SA")).toBe("ar");
    expect(resolveLocale("AR")).toBe("ar");
  });

  it("defaults everything else to en", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale("")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale(null)).toBe("en");
  });
});

describe("isRtl", () => {
  it("marks Arabic locales RTL and English LTR", () => {
    expect(isRtl("ar")).toBe(true);
    expect(isRtl("ar-EG")).toBe(true);
    expect(isRtl("en")).toBe(false);
  });
});
