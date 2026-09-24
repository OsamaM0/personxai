/**
 * Google Calendar — list, create, update, delete, and find free time.
 *
 * Meet links come from the Calendar API rather than any Meet API: an event
 * created with a `conferenceData.createRequest` of type `hangoutsMeet` comes
 * back with a joinable link. That is available on a free personal account,
 * which is why it is how this assistant "creates a meeting".
 */
import { googleFetch } from "./api";

const BASE = "https://www.googleapis.com/calendar/v3";

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  /** ISO instant for timed events; YYYY-MM-DD for all-day ones. */
  start: string;
  end: string;
  allDay: boolean;
  attendees: string[];
  meetLink?: string;
  htmlLink?: string;
  status?: string;
}

interface RawEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface RawEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: RawEventTime;
  end?: RawEventTime;
  attendees?: { email?: string; responseStatus?: string }[];
  hangoutLink?: string;
  htmlLink?: string;
  status?: string;
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
}

function meetLinkOf(raw: RawEvent): string | undefined {
  if (raw.hangoutLink) return raw.hangoutLink;
  const video = raw.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video");
  return video?.uri;
}

function toEvent(raw: RawEvent): CalendarEvent {
  const allDay = Boolean(raw.start?.date && !raw.start?.dateTime);
  const event: CalendarEvent = {
    id: raw.id ?? "",
    summary: raw.summary ?? "(no title)",
    start: raw.start?.dateTime ?? raw.start?.date ?? "",
    end: raw.end?.dateTime ?? raw.end?.date ?? "",
    allDay,
    attendees: (raw.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
  };
  if (raw.description) event.description = raw.description;
  if (raw.location) event.location = raw.location;
  if (raw.status) event.status = raw.status;
  if (raw.htmlLink) event.htmlLink = raw.htmlLink;
  const meet = meetLinkOf(raw);
  if (meet) event.meetLink = meet;
  return event;
}

export interface ListEventsOptions {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  limit?: number;
  /** Free-text match against summary, description, attendees. */
  query?: string;
}

export async function listEvents(
  accessToken: string,
  opts: ListEventsOptions = {}
): Promise<CalendarEvent[]> {
  const calendarId = encodeURIComponent(opts.calendarId ?? "primary");
  const result = await googleFetch<{ items?: RawEvent[] }>(
    accessToken,
    "calendar.events.list",
    `${BASE}/calendars/${calendarId}/events`,
    {
      query: {
        // singleEvents expands recurring series into occurrences, which is what
        // "what's on Tuesday" actually means.
        singleEvents: true,
        orderBy: "startTime",
        maxResults: Math.min(Math.max(opts.limit ?? 20, 1), 100),
        timeMin: opts.timeMin ?? new Date().toISOString(),
        timeMax: opts.timeMax,
        q: opts.query,
      },
    }
  );
  return (result.items ?? []).map(toEvent);
}

export interface CreateEventInput {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  timeZone?: string;
  /** Attach a Google Meet link to the event. */
  withMeet?: boolean;
  calendarId?: string;
  /** Email the invitation to attendees rather than only adding them. */
  sendUpdates?: boolean;
}

/** All-day events are given as plain dates; timed ones as ISO instants. */
const timeField = (value: string, timeZone?: string): RawEventTime =>
  /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { date: value }
    : { dateTime: new Date(value).toISOString(), ...(timeZone ? { timeZone } : {}) };

export async function createEvent(
  accessToken: string,
  input: CreateEventInput
): Promise<CalendarEvent> {
  const calendarId = encodeURIComponent(input.calendarId ?? "primary");
  const body: Record<string, unknown> = {
    summary: input.summary,
    start: timeField(input.start, input.timeZone),
    end: timeField(input.end, input.timeZone),
  };
  if (input.description) body.description = input.description;
  if (input.location) body.location = input.location;
  if (input.attendees?.length) body.attendees = input.attendees.map((email) => ({ email }));
  if (input.withMeet) {
    // requestId must be unique per creation attempt; Google dedupes on it.
    body.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const raw = await googleFetch<RawEvent>(
    accessToken,
    "calendar.events.insert",
    `${BASE}/calendars/${calendarId}/events`,
    {
      method: "POST",
      query: {
        // Without conferenceDataVersion=1 the Meet request is silently dropped.
        conferenceDataVersion: input.withMeet ? 1 : 0,
        sendUpdates: input.sendUpdates ? "all" : "none",
      },
      body,
    }
  );
  return toEvent(raw);
}

export interface UpdateEventInput {
  eventId: string;
  calendarId?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  attendees?: string[];
  sendUpdates?: boolean;
  /** Add a Google Meet link to an event that has none. */
  withMeet?: boolean;
}

export async function updateEvent(
  accessToken: string,
  input: UpdateEventInput
): Promise<CalendarEvent> {
  const calendarId = encodeURIComponent(input.calendarId ?? "primary");
  const body: Record<string, unknown> = {};
  if (input.summary !== undefined) body.summary = input.summary;
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.start !== undefined) body.start = timeField(input.start, input.timeZone);
  if (input.end !== undefined) body.end = timeField(input.end, input.timeZone);
  if (input.attendees !== undefined) {
    body.attendees = input.attendees.map((email) => ({ email }));
  }
  if (input.withMeet) {
    body.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const raw = await googleFetch<RawEvent>(
    accessToken,
    "calendar.events.patch",
    `${BASE}/calendars/${calendarId}/events/${encodeURIComponent(input.eventId)}`,
    {
      method: "PATCH",
      query: {
        conferenceDataVersion: input.withMeet ? 1 : 0,
        sendUpdates: input.sendUpdates ? "all" : "none",
      },
      body,
    }
  );
  return toEvent(raw);
}

export async function deleteEvent(
  accessToken: string,
  eventId: string,
  calendarId = "primary"
): Promise<void> {
  await googleFetch(
    accessToken,
    "calendar.events.delete",
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" }
  );
}

export interface BusySlot {
  start: string;
  end: string;
}

/** Busy intervals in a window — the raw material for "when am I free?". */
export async function freeBusy(
  accessToken: string,
  timeMin: string,
  timeMax: string,
  calendarId = "primary"
): Promise<BusySlot[]> {
  const result = await googleFetch<{
    calendars?: Record<string, { busy?: BusySlot[] }>;
  }>(accessToken, "calendar.freebusy", `${BASE}/freeBusy`, {
    method: "POST",
    body: { timeMin, timeMax, items: [{ id: calendarId }] },
  });
  return result.calendars?.[calendarId]?.busy ?? [];
}

/**
 * Invert a busy list into openings of at least `minMinutes`.
 *
 * Pure function so it is testable without a network: the caller supplies the
 * window and Google's busy blocks, and gets back the gaps between them.
 */
export function freeSlots(
  busy: BusySlot[],
  windowStart: string,
  windowEnd: string,
  minMinutes = 30
): BusySlot[] {
  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

  const blocks = busy
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > startMs && b.start < endMs)
    .sort((a, b) => a.start - b.start);

  const out: BusySlot[] = [];
  const minMs = minMinutes * 60_000;
  let cursor = startMs;
  for (const block of blocks) {
    // Overlapping meetings must not reopen a gap already closed by an earlier one.
    if (block.start > cursor && block.start - cursor >= minMs) {
      out.push({ start: new Date(cursor).toISOString(), end: new Date(block.start).toISOString() });
    }
    cursor = Math.max(cursor, block.end);
  }
  if (endMs - cursor >= minMs) {
    out.push({ start: new Date(cursor).toISOString(), end: new Date(endMs).toISOString() });
  }
  return out;
}
