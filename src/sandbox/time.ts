// Wall-clock helpers for an IANA time zone without a date library. The sandbox
// needs "Sat 7:30pm in Denver" as an exact instant, and the run message needs
// the simulated time the way a person in that city would read it.

/** Offset of `timeZone` from UTC at `instant`, in minutes (Denver in October: -360). */
export function zoneOffsetMinutes(timeZone: string, instant: Date): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part ?? "");
  if (!m) return 0; // "GMT" alone means UTC
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}

/** The instant when the wall clock in `timeZone` reads the given local time. */
export function zonedTime(timeZone: string, year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset even when the guess lands across a DST change.
  let guess = wall - zoneOffsetMinutes(timeZone, new Date(wall)) * 60_000;
  guess = wall - zoneOffsetMinutes(timeZone, new Date(guess)) * 60_000;
  return new Date(guess);
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(timeZone: string, instant: Date): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
  };
}

/** "Wed Oct 21, 10:05 AM" in the zone. */
export function formatLocal(timeZone: string, instant: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}

/** ISO 8601 with the zone's offset, e.g. 2026-10-24T19:30:00-06:00, which is what people (and Fo) write. */
export function isoWithOffset(timeZone: string, instant: Date): string {
  const offset = zoneOffsetMinutes(timeZone, instant);
  const local = new Date(instant.getTime() + offset * 60_000).toISOString().slice(0, 19);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
