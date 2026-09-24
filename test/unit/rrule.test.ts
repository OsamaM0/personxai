/**
 * RRULE helper tests. Cairo DST 2026: +03:00 from Apr 24 (last Friday of
 * April) through Oct 29 (last Thursday of October), +02:00 otherwise. All
 * inputs/outputs are real UTC instants; expectations never depend on the host
 * system timezone.
 */
import { describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { RRule } from "rrule";
import { describeRecurrence, nextOccurrence, parseRecurrence } from "../../src/scheduler/rrule";

const CAIRO = "Africa/Cairo";

function must(d: Date | null): Date {
  if (d === null) throw new Error("expected an occurrence, got null");
  return d;
}

describe("nextOccurrence", () => {
  it("keeps the local hour for weekly Sundays across the spring-forward boundary", () => {
    // Sunday 2026-04-19 09:00 Cairo (+02) = 07:00Z. DST starts Apr 24.
    const anchor = new Date("2026-04-19T07:00:00.000Z");
    const next = must(
      nextOccurrence("FREQ=WEEKLY;BYDAY=SU", { after: anchor, anchor, timezone: CAIRO }),
    );
    // Sunday 2026-04-26 09:00 Cairo is now +03 = 06:00Z.
    expect(next.toISOString()).toBe("2026-04-26T06:00:00.000Z");
    expect(formatInTimeZone(next, CAIRO, "EEEE HH:mm")).toBe("Sunday 09:00");
  });

  it("keeps the local hour across the fall-back boundary", () => {
    // Sunday 2026-10-25 09:00 Cairo (+03) = 06:00Z. DST ends Oct 29 24:00.
    const anchor = new Date("2026-10-25T06:00:00.000Z");
    const next = must(
      nextOccurrence("FREQ=WEEKLY;BYDAY=SU", { after: anchor, anchor, timezone: CAIRO }),
    );
    // Sunday 2026-11-01 09:00 Cairo is back to +02 = 07:00Z.
    expect(next.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(formatInTimeZone(next, CAIRO, "EEEE HH:mm")).toBe("Sunday 09:00");
  });

  it("advances week by week inside a DST period", () => {
    const anchor = new Date("2026-04-26T06:00:00.000Z"); // Sunday 09:00 +03
    const next = must(
      nextOccurrence("FREQ=WEEKLY;BYDAY=SU", { after: anchor, anchor, timezone: CAIRO }),
    );
    expect(next.toISOString()).toBe("2026-05-03T06:00:00.000Z");
  });

  it("handles a simple FREQ=DAILY rule", () => {
    const anchor = new Date("2026-01-15T07:00:00.000Z"); // 09:00 Cairo winter
    const next = must(nextOccurrence("FREQ=DAILY", { after: anchor, anchor, timezone: CAIRO }));
    expect(next.toISOString()).toBe("2026-01-16T07:00:00.000Z");
    expect(formatInTimeZone(next, CAIRO, "HH:mm")).toBe("09:00");

    // A later `after` on the same day still lands on tomorrow's occurrence.
    const later = must(
      nextOccurrence("FREQ=DAILY", {
        after: new Date("2026-01-15T20:00:00.000Z"),
        anchor,
        timezone: CAIRO,
      }),
    );
    expect(later.toISOString()).toBe("2026-01-16T07:00:00.000Z");
  });

  it("returns a future anchor as the first occurrence", () => {
    const next = must(
      nextOccurrence("FREQ=DAILY", {
        after: new Date("2026-01-01T00:00:00.000Z"),
        anchor: new Date("2026-01-15T07:00:00.000Z"),
        timezone: CAIRO,
      }),
    );
    expect(next.toISOString()).toBe("2026-01-15T07:00:00.000Z");
  });

  it("applies BYHOUR in local time across a DST jump", () => {
    // Thu 2026-04-23 09:00 (+02) = 07:00Z; Fri Apr 24 is the first +03 day.
    const anchor = new Date("2026-04-23T07:00:00.000Z");
    const next = must(
      nextOccurrence("FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", {
        after: anchor,
        anchor,
        timezone: CAIRO,
      }),
    );
    expect(next.toISOString()).toBe("2026-04-24T06:00:00.000Z");
    expect(formatInTimeZone(next, CAIRO, "HH:mm")).toBe("09:00");
  });

  it("works for UTC owners", () => {
    const anchor = new Date("2026-01-15T09:00:00.000Z");
    const next = must(nextOccurrence("FREQ=DAILY", { after: anchor, anchor, timezone: "UTC" }));
    expect(next.toISOString()).toBe("2026-01-16T09:00:00.000Z");
  });

  it("returns null for invalid rules", () => {
    const opts = { after: new Date(), anchor: new Date(), timezone: CAIRO };
    expect(nextOccurrence("garbage", opts)).toBeNull();
    expect(nextOccurrence("FREQ=NOPE", opts)).toBeNull();
    expect(nextOccurrence("", opts)).toBeNull();
  });

  it("returns null for an invalid timezone or invalid dates", () => {
    const now = new Date();
    expect(nextOccurrence("FREQ=DAILY", { after: now, anchor: now, timezone: "Not/AZone" })).toBeNull();
    expect(
      nextOccurrence("FREQ=DAILY", { after: new Date(Number.NaN), anchor: now, timezone: CAIRO }),
    ).toBeNull();
  });
});

describe("parseRecurrence", () => {
  it("builds an RRule carrying the zone, with dtstart re-encoded to wall clock", () => {
    const rule = parseRecurrence("FREQ=WEEKLY;BYDAY=SU", {
      dtstart: new Date("2026-04-19T07:00:00.000Z"), // 09:00 Cairo wall time
      timezone: CAIRO,
    });
    expect(rule).not.toBeNull();
    expect(rule?.options.tzid).toBe(CAIRO);
    expect(rule?.options.freq).toBe(RRule.WEEKLY);
    // With tzid set, rrule reads dtstart's UTC fields as local wall time.
    expect(rule?.options.dtstart.toISOString()).toBe("2026-04-19T09:00:00.000Z");
  });

  it("returns null on parse failure or bad inputs", () => {
    const dtstart = new Date("2026-01-01T00:00:00.000Z");
    expect(parseRecurrence("garbage", { dtstart, timezone: CAIRO })).toBeNull();
    expect(parseRecurrence("FREQ=NOPE", { dtstart, timezone: CAIRO })).toBeNull();
    expect(parseRecurrence("", { dtstart, timezone: CAIRO })).toBeNull();
    expect(parseRecurrence("FREQ=DAILY", { dtstart, timezone: "Not/AZone" })).toBeNull();
    expect(parseRecurrence("FREQ=DAILY", { dtstart: new Date(Number.NaN), timezone: CAIRO })).toBeNull();
  });
});

describe("describeRecurrence", () => {
  it("describes common rules in English", () => {
    expect(describeRecurrence("FREQ=WEEKLY;BYDAY=SU")).toContain("Sunday");
    expect(describeRecurrence("FREQ=DAILY")).toContain("day");
    expect(describeRecurrence("FREQ=DAILY;INTERVAL=3")).toContain("3");
  });

  it("falls back to the raw string for rules it cannot parse", () => {
    expect(describeRecurrence("not-a-rule")).toBe("not-a-rule");
    expect(describeRecurrence("")).toBe("");
  });
});
