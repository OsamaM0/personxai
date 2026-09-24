/**
 * Timezone helper tests. Egypt observes DST again since 2023: +03:00 from the
 * last Friday of April (00:00) to the last Thursday of October (24:00), else
 * +02:00. In 2026 that is Apr 24 through Oct 29. All expectations are pinned
 * to explicit instants so results do not depend on the host system timezone.
 */
import { describe, expect, it } from "vitest";
import { formatInTimeZone, getTimezoneOffset } from "date-fns-tz";
import {
  forceLocalOffset,
  guessTimezoneFromLocalTime,
  isValidTimezone,
  localHour,
  nowInTz,
} from "../../src/scheduler/tz";

const CAIRO = "Africa/Cairo";

describe("forceLocalOffset", () => {
  it("stamps a naive datetime with the winter offset (+02:00)", () => {
    expect(forceLocalOffset("2026-01-15T09:00:00", CAIRO)).toBe("2026-01-15T09:00:00+02:00");
  });

  it("stamps a naive datetime with the summer/DST offset (+03:00)", () => {
    expect(forceLocalOffset("2026-06-07T09:00:00", CAIRO)).toBe("2026-06-07T09:00:00+03:00");
  });

  it("corrects a wrong LLM-produced offset, keeping the wall clock", () => {
    // LLM claimed +03:00 in January — Cairo is +02:00 then.
    expect(forceLocalOffset("2026-01-15T09:00:00+03:00", CAIRO)).toBe("2026-01-15T09:00:00+02:00");
    // Wildly wrong offset in summer.
    expect(forceLocalOffset("2026-06-07T09:00:00-05:00", CAIRO)).toBe("2026-06-07T09:00:00+03:00");
  });

  it("replaces a Z suffix with the real local offset", () => {
    expect(forceLocalOffset("2026-01-15T09:00:00Z", CAIRO)).toBe("2026-01-15T09:00:00+02:00");
  });

  it("keeps an already-correct offset unchanged", () => {
    expect(forceLocalOffset("2026-06-07T09:00:00+03:00", CAIRO)).toBe("2026-06-07T09:00:00+03:00");
  });

  it("tracks the 2026 DST boundaries (Apr 24 on, Oct 30 off)", () => {
    expect(forceLocalOffset("2026-04-23T09:00:00", CAIRO)).toBe("2026-04-23T09:00:00+02:00");
    expect(forceLocalOffset("2026-04-24T09:00:00", CAIRO)).toBe("2026-04-24T09:00:00+03:00");
    expect(forceLocalOffset("2026-10-29T09:00:00", CAIRO)).toBe("2026-10-29T09:00:00+03:00");
    expect(forceLocalOffset("2026-10-30T09:00:00", CAIRO)).toBe("2026-10-30T09:00:00+02:00");
  });

  it("passes through unchanged for UTC owners", () => {
    expect(forceLocalOffset("2026-05-19T09:00:00Z", "UTC")).toBe("2026-05-19T09:00:00Z");
    expect(forceLocalOffset("2026-05-19T09:00:00+05:00", "Etc/UTC")).toBe("2026-05-19T09:00:00+05:00");
  });

  it("passes through non-ISO strings", () => {
    expect(forceLocalOffset("tomorrow at nine", CAIRO)).toBe("tomorrow at nine");
  });

  it("preserves fractional seconds in the wall clock", () => {
    expect(forceLocalOffset("2026-01-15T09:00:00.500", CAIRO)).toBe("2026-01-15T09:00:00.500+02:00");
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA names and Etc zones", () => {
    expect(isValidTimezone("Africa/Cairo")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Etc/GMT-3")).toBe(true);
  });

  it("rejects junk", () => {
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Cairo sometime")).toBe(false);
  });
});

describe("nowInTz", () => {
  it("returns a human-readable string with Latin digits", () => {
    const s = nowInTz(CAIRO);
    expect(s).toMatch(/\d{4}/); // a year
    expect(s).toMatch(/\d{1,2}:\d{2}/); // a time
    // Never Arabic-Indic digits, whatever the user's language is.
    expect(s).not.toMatch(/[٠-٩۰-۹]/);
  });

  it("does not throw on an invalid timezone (falls back to UTC)", () => {
    expect(() => nowInTz("Not/AZone")).not.toThrow();
    expect(nowInTz("Not/AZone")).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("localHour", () => {
  it("returns the wall-clock hour in the zone", () => {
    // 22:30Z + 2h = 00:30 next day in Cairo winter — midnight must be 0, not 24.
    expect(localHour(new Date("2026-01-15T22:30:00Z"), CAIRO)).toBe(0);
    // DST: 12:00Z + 3h.
    expect(localHour(new Date("2026-06-15T12:00:00Z"), CAIRO)).toBe(15);
    expect(localHour(new Date("2026-01-15T12:00:00Z"), "America/New_York")).toBe(7);
  });

  it("falls back to the UTC hour for an invalid zone", () => {
    expect(localHour(new Date("2026-01-15T05:00:00Z"), "Not/AZone")).toBe(5);
  });
});

describe("guessTimezoneFromLocalTime", () => {
  const winterNoon = new Date("2026-01-15T12:00:00.000Z");

  it("maps offsets to the curated zone table", () => {
    expect(guessTimezoneFromLocalTime("14:00", winterNoon)).toBe("Africa/Cairo"); // +02
    expect(guessTimezoneFromLocalTime("12:00", winterNoon)).toBe("Europe/London"); // +00
    expect(guessTimezoneFromLocalTime("17:30", winterNoon)).toBe("Asia/Kolkata"); // +05:30
    expect(guessTimezoneFromLocalTime("21:00", winterNoon)).toBe("Asia/Tokyo"); // +09
    expect(guessTimezoneFromLocalTime("07:00", winterNoon)).toBe("America/New_York"); // -05
  });

  it("rounds the clock reading to the nearest 15 minutes", () => {
    expect(guessTimezoneFromLocalTime("14:05", winterNoon)).toBe("Africa/Cairo");
  });

  it("falls back to Etc/GMT zones with the POSIX sign inversion", () => {
    // UTC+7 has no table entry -> Etc/GMT-7 (POSIX sign is inverted).
    expect(guessTimezoneFromLocalTime("19:00", winterNoon)).toBe("Etc/GMT-7");
    // UTC-1 -> Etc/GMT+1.
    expect(guessTimezoneFromLocalTime("11:00", winterNoon)).toBe("Etc/GMT+1");
  });

  it("returns null for a non-whole-hour offset with no named zone", () => {
    expect(guessTimezoneFromLocalTime("16:45", winterNoon)).toBeNull(); // +04:45
  });

  it("handles the midnight wrap", () => {
    const lateUtc = new Date("2026-01-15T23:30:00.000Z");
    expect(guessTimezoneFromLocalTime("01:30", lateUtc)).toBe("Africa/Cairo");
  });

  it("rejects malformed input", () => {
    expect(guessTimezoneFromLocalTime("25:00", winterNoon)).toBeNull();
    expect(guessTimezoneFromLocalTime("12:60", winterNoon)).toBeNull();
    expect(guessTimezoneFromLocalTime("9am", winterNoon)).toBeNull();
    expect(guessTimezoneFromLocalTime("", winterNoon)).toBeNull();
  });

  it("round-trips every table zone by offset, winter and summer", () => {
    const zones = [
      "Africa/Cairo",
      "Europe/London",
      "Europe/Berlin",
      "Europe/Paris",
      "Asia/Riyadh",
      "Asia/Dubai",
      "America/New_York",
      "America/Chicago",
      "America/Los_Angeles",
      "Asia/Kolkata",
      "Asia/Tokyo",
      "Asia/Shanghai",
      "Australia/Sydney",
    ];
    const summerNoon = new Date("2026-07-15T12:00:00.000Z");
    for (const now of [winterNoon, summerNoon]) {
      for (const zone of zones) {
        const local = formatInTimeZone(now, zone, "HH:mm");
        const guessed = guessTimezoneFromLocalTime(local, now);
        if (guessed === null) throw new Error(`no guess for ${zone} at ${now.toISOString()}`);
        // Zones sharing an offset may map to an earlier table entry (e.g.
        // Paris -> Berlin), so compare offsets rather than names.
        expect(getTimezoneOffset(guessed, now)).toBe(getTimezoneOffset(zone, now));
      }
    }
  });
});
