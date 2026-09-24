/**
 * RRULE helpers for the reminder scheduler.
 *
 * Modeled on openmemo's parseRRule pattern
 * (ref/openmemo/supabase/functions/_shared/rrule.ts): RRule.parseString, then
 * reconstruct with an explicit dtstart + tzid so the zone rules (DST) are
 * applied per occurrence instead of once at parse time.
 *
 * rrule + tzid gotcha, verified against rrule@2.8.1 sources: the iteration
 * engine works in a "fake UTC" space where a Date's *UTC fields* encode the
 * LOCAL wall time of the zone. When `tzid` is set, each emitted occurrence is
 * converted back to a real instant by DateWithZone.rezonedDate(), but that
 * conversion (dateutil.dateInTimeZone) routes through the *host system*
 * timezone (Intl.DateTimeFormat().resolvedOptions().timeZone with a
 * toLocaleString('sv-SE') parse hack) and is only correct on hosts running at
 * UTC. Workers are UTC, but unit tests run under plain Node on dev machines,
 * so `nextOccurrence` never relies on it: it iterates a tzid-less rule in
 * wall-clock space and does the round trip itself with date-fns-tz
 * (formatInTimeZone to enter wall space, fromZonedTime to leave it), which is
 * deterministic on any host.
 */
import { RRule, type Options } from "rrule";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { isValidTimezone } from "./tz";

// Second precision: reminder occurrences never carry sub-second parts.
const WALL_FORMAT = "yyyy-MM-dd'T'HH:mm:ss";

/** Real instant -> Date whose UTC fields encode the wall clock of `timezone`. */
function instantToWallClock(instant: Date, timezone: string): Date {
  return new Date(`${formatInTimeZone(instant, timezone, WALL_FORMAT)}Z`);
}

/** Inverse of instantToWallClock; the wall time gets that date's own offset. */
function wallClockToInstant(wall: Date, timezone: string): Date {
  // String form without offset: date-fns-tz interprets it in `timezone`,
  // ignoring the host system zone entirely.
  return fromZonedTime(wall.toISOString().slice(0, 19), timezone);
}

function isUsableDate(d: Date): boolean {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/** parseString wrapper: null instead of throw, and FREQ is mandatory. */
function parseRuleOptions(rule: string): Partial<Options> | null {
  if (typeof rule !== "string" || rule.trim().length === 0) return null;
  let parsed: Partial<Options>;
  try {
    parsed = RRule.parseString(rule);
  } catch {
    return null; // unknown property, bad weekday, ...
  }
  // Frequency.YEARLY is 0, so check the type, not truthiness.
  if (typeof parsed.freq !== "number") return null;
  return parsed;
}

/**
 * Parse an RRULE string into an RRule anchored at `dtstart` (a real instant)
 * with the zone attached, so callers can inspect/serialize it. `dtstart` is
 * re-encoded to the zone's wall clock because with `tzid` set rrule reads its
 * UTC fields as local wall time (see module comment). Returns null on parse
 * failure, invalid dtstart, or invalid timezone.
 */
export function parseRecurrence(rule: string, opts: { dtstart: Date; timezone: string }): RRule | null {
  const parsed = parseRuleOptions(rule);
  if (!parsed) return null;
  if (!isUsableDate(opts.dtstart) || !isValidTimezone(opts.timezone)) return null;
  try {
    return new RRule({
      ...parsed,
      dtstart: instantToWallClock(opts.dtstart, opts.timezone),
      tzid: opts.timezone,
    });
  } catch {
    return null;
  }
}

/**
 * Next occurrence of `rule` strictly after `after`, both real UTC instants.
 * `anchor` is the recurrence start (dtstart) that supplies any field the rule
 * leaves open — e.g. FREQ=WEEKLY;BYDAY=SU fires at the anchor's local hour.
 * Strictly-after semantics let the dispatcher pass the occurrence that just
 * fired without getting it back again.
 *
 * Caveat: an UNTIL=...Z part is compared in wall-clock space (same as the
 * openmemo/tzid path), so it may drift from the true instant by the offset.
 */
export function nextOccurrence(
  rule: string,
  opts: { after: Date; anchor: Date; timezone: string },
): Date | null {
  const parsed = parseRuleOptions(rule);
  if (!parsed) return null;
  if (!isUsableDate(opts.after) || !isUsableDate(opts.anchor)) return null;
  if (!isValidTimezone(opts.timezone)) return null;

  try {
    // tzid deliberately cleared: iterate purely in wall-clock space and do the
    // instant conversion ourselves (see module comment for why).
    const iterRule = new RRule({
      ...parsed,
      dtstart: instantToWallClock(opts.anchor, opts.timezone),
      tzid: null,
    });
    const wallNext = iterRule.after(instantToWallClock(opts.after, opts.timezone), false);
    if (!wallNext) return null;
    const next = wallClockToInstant(wallNext, opts.timezone);
    return isUsableDate(next) ? next : null;
  } catch {
    return null;
  }
}

/** English description of a rule ("every week on Sunday"), raw string as fallback. */
export function describeRecurrence(rule: string): string {
  const parsed = parseRuleOptions(rule);
  if (!parsed) return rule;
  try {
    // dtstart irrelevant for the text; RRule defaults it to now.
    const text = new RRule(parsed).toText();
    if (!text || text.trim().length === 0 || text.startsWith("RRule error")) return rule;
    return text;
  } catch {
    return rule;
  }
}
