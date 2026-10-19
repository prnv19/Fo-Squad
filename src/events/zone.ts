// Time zone math (Intl only, no dependencies) and the booked-stage timer rules,
// shared by get_status and confirm_booking so they name the same moments.

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

const HOUR_MS = 60 * 60 * 1000;
/** The day-of reminder goes out this long before the table time... */
export const DAY_OF_LEAD_MS = 4 * HOUR_MS;
/** ...but never before this local hour, so a 9am breakfast gets a 9am reminder, not a 5am one. */
export const DAY_OF_EARLIEST_HOUR = 9;
/** The bill question waits this long after the start. */
export const AFTER_MEAL_MS = 2 * HOUR_MS;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function localParts(date: Date, timeZone: string): LocalParts {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour") % 24,
    minute: pick("minute"),
    second: pick("second"),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant when the wall clock in `timeZone` reads the given local time. */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetMs(new Date(wall), timeZone);
  // Re-check once so a DST change between the guess and the answer is handled.
  const second = wall - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** When to send the day-of reminder: 4 hours before the start, but not before 9am local that day. */
export function dayOfReminderAt(startsAt: Date, timeZone: string): Date {
  const local = localParts(startsAt, timeZone);
  const earliest = zonedTime(local.year, local.month, local.day, DAY_OF_EARLIEST_HOUR, 0, timeZone);
  return new Date(Math.max(startsAt.getTime() - DAY_OF_LEAD_MS, earliest.getTime()));
}

/** When to ask the organizer about the bill. */
export function billQuestionAt(startsAt: Date): Date {
  return new Date(startsAt.getTime() + AFTER_MEAL_MS);
}

/** "9:00am", "12:30pm": a local clock time for messages to Fo. */
export function localClockLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    .format(date)
    .replace(/\s+/g, "")
    .toLowerCase();
}
