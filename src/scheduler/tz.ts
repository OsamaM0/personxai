/**
 * Timezone helpers for the scheduler and prompt "live context" block.
 *
 * `forceLocalOffset` is ported from openmemo
 * (ref/openmemo/supabase/functions/_shared/tz.ts) with behavior preserved
 * exactly. Everything here must be independent of the host's system timezone:
 * Workers run at UTC, but unit tests run under plain Node on dev machines.
 */
import { formatInTimeZone, getTimezoneOffset } from "date-fns-tz";

/**
 * Strips any offset the LLM might have attached and re-stamps the wall-clock
 * with the owner's real IANA offset for that date. This makes it impossible
 * for the LLM to produce a wrong offset.
 *
 * Examples (owner in America/Santiago, UTC-4 winter):
 *   "2026-05-19T09:00:00Z"       -> "2026-05-19T09:00:00-04:00"
 *   "2026-05-19T09:00:00+00:00"  -> "2026-05-19T09:00:00-04:00"
 *   "2026-05-19T09:00:00-05:00"  -> "2026-05-19T09:00:00-04:00"
 *   "2026-05-19T09:00:00"        -> "2026-05-19T09:00:00-04:00"
 *   "2026-05-19T09:00:00-04:00"  -> "2026-05-19T09:00:00-04:00" (already correct)
 *
 * For UTC owners, the input passes through unchanged.
 */
export function forceLocalOffset(iso: string, timezone: string): string {
  if (timezone === "UTC" || timezone === "Etc/UTC") return iso;

  // Extract wall-clock portion (yyyy-MM-ddTHH:mm[:ss[.fff]])
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/);
  const wall = m?.[1];
  if (!wall) return iso; // not a recognizable ISO, pass through

  // Compute the real offset for this wall-clock instant in the owner's zone.
  // We interpret `wall` as UTC momentarily just to seed formatInTimeZone,
  // which gives us the zone's offset for that calendar date.
  const offset = formatInTimeZone(new Date(`${wall}Z`), timezone, "xxx");
  return `${wall}${offset}`;
}

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Human-readable current date+time for the system prompt live block, e.g.
 * "Thursday 27 August 2026 at 14:05". en-GB is fixed on purpose: Latin digits
 * and 24h time regardless of the user's interface language. Falls back to UTC
 * for an invalid zone instead of throwing (this runs on every turn).
 */
export function nowInTz(timezone: string): string {
  const tz = isValidTimezone(timezone) ? timezone : "UTC";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: tz,
  }).format(new Date());
}

/** Hour of day (0-23) of `date` as seen on the wall clock of `timezone`. */
export function localHour(date: Date, timezone: string): number {
  const tz = isValidTimezone(timezone) ? timezone : "UTC";
  // hourCycle h23 so midnight is "0", never "24".
  const text = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone: tz,
  }).format(date);
  const hour = Number.parseInt(text, 10);
  return Number.isNaN(hour) ? date.getUTCHours() : hour;
}

// First zone whose current offset matches wins, so order encodes preference.
const OFFSET_GUESS_ZONES: readonly string[] = [
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

/**
 * Onboarding helper: the user tells us their current wall clock ("HH:MM") and
 * we derive a plausible IANA zone from the difference to UTC now. Preference
 * order: a curated zone list (DST-aware, checked at `now`), then a fixed
 * Etc/GMT zone for whole-hour offsets, else null.
 */
export function guessTimezoneFromLocalTime(hhmm: string, now: Date = new Date()): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  const hStr = m?.[1];
  const minStr = m?.[2];
  if (hStr === undefined || minStr === undefined) return null;

  const userMinutes = Number(hStr) * 60 + Number(minStr);
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let diff = userMinutes - utcMinutes;
  // Normalize the day wrap into (-12h, +12h]. Zones at +13/+14 are
  // indistinguishable from -11/-10 given only a wall clock, so they lose.
  if (diff > 720) diff -= 1440;
  if (diff <= -720) diff += 1440;
  // Clock readings are approximate; real offsets are multiples of 15 min.
  const offsetMinutes = Math.round(diff / 15) * 15;

  for (const zone of OFFSET_GUESS_ZONES) {
    if (getTimezoneOffset(zone, now) / 60_000 === offsetMinutes) return zone;
  }

  if (offsetMinutes % 60 !== 0) return null; // e.g. +05:45 with no named match
  const hours = offsetMinutes / 60;
  if (hours === 0) return "UTC";
  // POSIX Etc/GMT zones invert the sign: Etc/GMT-3 means UTC+3.
  const fallback = `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
  return isValidTimezone(fallback) ? fallback : null;
}

// ── Local calendar windows (wallet totals, "this month", "today") ────────────

export type LocalPeriod = "today" | "yesterday" | "week" | "month" | "year" | "all";

export const LOCAL_PERIODS: LocalPeriod[] = ["today", "yesterday", "week", "month", "year", "all"];

export interface PeriodRange {
  period: LocalPeriod;
  /** Inclusive start, ISO UTC; null for an unbounded window. */
  from: string | null;
  /** Exclusive end, ISO UTC; null for an unbounded window. */
  to: string | null;
}

/**
 * A local wall clock ("2026-08-29T00:00") as an instant. forceLocalOffset
 * passes UTC through unchanged, and a bare wall clock would then be read in the
 * HOST's zone — Workers run at UTC, unit tests do not — so stamp Z ourselves.
 */
function localInstant(wall: string, timezone: string): Date {
  const forced = forceLocalOffset(wall, timezone);
  return new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(forced) ? forced : forced + "Z");
}

/** Midnight of a local calendar date, shifted by whole days on the calendar (DST-safe). */
function localMidnight(date: Date, timezone: string, dayShift = 0): Date {
  const [y, m, d] = formatInTimeZone(date, timezone, "yyyy-MM-dd").split("-").map(Number);
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + dayShift));
  return localInstant(`${shifted.toISOString().slice(0, 10)}T00:00`, timezone);
}

/** Midnight on the first day of a local month, offset by whole months. */
function localMonthStart(date: Date, timezone: string, monthShift = 0): Date {
  const [y, m] = formatInTimeZone(date, timezone, "yyyy-MM").split("-").map(Number);
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + monthShift, 1));
  return localInstant(`${shifted.toISOString().slice(0, 10)}T00:00`, timezone);
}

/**
 * Resolve a named period into a half-open [from, to) window on the user's own
 * calendar. "week" is the rolling last 7 days (including today) rather than a
 * week that starts on a weekday users disagree about; "month" and "year" are
 * the calendar ones, to date.
 */
export function localPeriodRange(
  period: LocalPeriod,
  timezone: string,
  now: Date = new Date()
): PeriodRange {
  const tz = isValidTimezone(timezone) ? timezone : "UTC";
  const tomorrow = localMidnight(now, tz, 1);
  switch (period) {
    case "today":
      return { period, from: localMidnight(now, tz).toISOString(), to: tomorrow.toISOString() };
    case "yesterday":
      return {
        period,
        from: localMidnight(now, tz, -1).toISOString(),
        to: localMidnight(now, tz).toISOString(),
      };
    case "week":
      return { period, from: localMidnight(now, tz, -6).toISOString(), to: tomorrow.toISOString() };
    case "month":
      return {
        period,
        from: localMonthStart(now, tz).toISOString(),
        to: localMonthStart(now, tz, 1).toISOString(),
      };
    case "year": {
      const year = Number(formatInTimeZone(now, tz, "yyyy"));
      return {
        period,
        from: localInstant(`${year}-01-01T00:00`, tz).toISOString(),
        to: localInstant(`${year + 1}-01-01T00:00`, tz).toISOString(),
      };
    }
    default:
      return { period: "all", from: null, to: null };
  }
}

/** Map a user-typed word ("today", "شهر", "month") to a period, or null. */
export function parseLocalPeriod(raw: string | null | undefined): LocalPeriod | null {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/^(today|day|النهاردة|اليوم)$/.test(text)) return "today";
  if (/^(yesterday|امبارح|إمبارح|أمس)$/.test(text)) return "yesterday";
  if (/^(week|7d|weekly|اسبوع|أسبوع|الاسبوع|الأسبوع)$/.test(text)) return "week";
  if (/^(month|monthly|شهر|الشهر)$/.test(text)) return "month";
  if (/^(year|yearly|سنة|السنة)$/.test(text)) return "year";
  if (/^(all|total|everything|الكل|كله)$/.test(text)) return "all";
  return null;
}
