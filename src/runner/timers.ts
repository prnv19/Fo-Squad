// Deterministic timers for the headless runner: nudges, day-of reminders,
// payment reminders, and the deadline/after-dinner triggers that wake Claude.
// Pure: everything is derived from the events, the runner state and `now`, so a
// restart recomputes the same work and `state.done` keeps it from repeating.
//
// Quiet hours apply to sends AND triggers. A trigger may make Claude text people,
// so even a deadline decision waits for morning; nothing is lost, it just runs
// at the first tick after quiet hours end.

import { createHash } from "node:crypto";
import { DEFAULT_REPLY_WINDOW_MS, getStatus } from "../events/index.js";
import { roundStatus } from "../planning/index.js";
import { formatCents } from "../split/index.js";
import type { DinnerEvent, Person } from "../types.js";
import type { RunnerState, ScheduledSend, Trigger } from "./types.js";

export interface QuietHours {
  /** Local hour (0-23) when quiet starts, e.g. 21. */
  start: number;
  /** Local hour (0-23) when sending may resume, e.g. 9. */
  end: number;
}

export interface TimerOptions {
  timeZone: string;
  quietHours: QuietHours;
}

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";
export const DEFAULT_QUIET_HOURS: QuietHours = { start: 21, end: 9 };

/** A trigger plus the idempotency key the runner adds to `state.done` once it ran. */
export type KeyedTrigger = Trigger & { key: string };

export interface DueWork {
  sends: ScheduledSend[];
  triggers: KeyedTrigger[];
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_OF_LEAD_MS = 4 * HOUR_MS;
const DAY_OF_EARLIEST_HOUR = 9;
const AFTER_DINNER_MS = 2 * HOUR_MS;
const PAY_REMINDER_1_MS = 24 * HOUR_MS;
const PAY_REMINDER_2_MS = 72 * HOUR_MS;

// ---------- Time zone helpers (Intl only, no dependencies) ----------

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(date: Date, timeZone: string): LocalParts {
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

export function isQuietTime(date: Date, opts: TimerOptions): boolean {
  const { start, end } = opts.quietHours;
  if (start === end) return false;
  const hour = localParts(date, opts.timeZone).hour;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/** `date` if sending is allowed then, else the moment quiet hours end. */
export function nextAllowedTime(date: Date, opts: TimerOptions): Date {
  if (!isQuietTime(date, opts)) return date;
  const { start, end } = opts.quietHours;
  const p = localParts(date, opts.timeZone);
  // Evening side of a window that wraps midnight: resume tomorrow morning.
  const tomorrow = start > end && p.hour >= start;
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + (tomorrow ? 1 : 0)));
  return zonedTime(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), end, 0, opts.timeZone);
}

function localTimeLabel(date: Date, timeZone: string): string {
  const raw = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
  return raw.replace(/\s+/g, "").replace(/:00(?=[AP]M)/i, "").toLowerCase();
}

function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const x = localParts(a, timeZone);
  const y = localParts(b, timeZone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

// ---------- Voting round start ----------

// The event has no field for when voting opened (replyDeadline is the planning
// round only), so the runner records the moment it first sees each ballot as a
// marker in state.done. A new ballot (set_restaurant_options with different
// options resets votes and nudges) gets a new signature and a fresh round.

function ballotSignature(event: DinnerEvent): string {
  const names = event.restaurantOptions.map((o) => o.name.toLowerCase());
  return createHash("sha256").update(JSON.stringify(names)).digest("hex").slice(0, 10);
}

function votingMarkerPrefix(event: DinnerEvent): string {
  return `${event.id}:voting-open:${ballotSignature(event)}:`;
}

function votingOpenedAt(event: DinnerEvent, done: readonly string[]): Date | undefined {
  const prefix = votingMarkerPrefix(event);
  const marker = done.find((k) => k.startsWith(prefix));
  if (!marker) return undefined;
  const at = new Date(marker.slice(prefix.length));
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * Marker keys to add to `state.done` for voting rounds seen for the first time.
 * Call before `dueWork` each tick. With no votes yet, the event's updatedAt is
 * the moment set_restaurant_options opened the ballot; otherwise `now` is the
 * best guess (the runner ticks every minute, so it's close).
 */
export function roundMarkers(events: DinnerEvent[], state: RunnerState, now: Date): string[] {
  const keys: string[] = [];
  for (const event of events) {
    if (event.stage !== "voting" || event.restaurantOptions.length === 0) continue;
    if (votingOpenedAt(event, state.done)) continue;
    const updated = Date.parse(event.updatedAt);
    const opened =
      event.votes.length === 0 && event.nudgedIds.length === 0 && !Number.isNaN(updated) && updated <= now.getTime()
        ? new Date(updated)
        : now;
    keys.push(`${votingMarkerPrefix(event)}${opened.toISOString()}`);
  }
  return keys;
}

// ---------- Rules ----------

function recipient(p: Person): ScheduledSend["to"][number] {
  return { personId: p.id, name: p.name, phone: p.phone };
}

function firstName(p: Person): string {
  return p.name.split(/\s+/)[0] ?? p.name;
}

/** Same rule as getStatus and the service: unknown availability counts as "might come". */
function canMakeSlot(event: DinnerEvent, person: Person, slotId: string): boolean {
  if (person.id === event.organizerId) return true;
  const pref = event.preferences.find((p) => p.personId === person.id);
  if (!pref || pref.slotsStale) return true;
  return pref.anyTime || pref.slotIds.includes(slotId);
}

interface Round {
  stage: "planning" | "voting";
  deadline?: Date;
  nudgeAfter?: Date;
  nudgeText: (p: Person) => string;
}

function planningRound(event: DinnerEvent): Round | undefined {
  if (event.timeSlots.length === 0 || event.chosenSlotId) return undefined;
  const deadline = event.replyDeadline ? new Date(event.replyDeadline) : undefined;
  const slots = event.timeSlots.map((s) => `${s.id}) ${s.label}`).join(" ");
  const round: Round = {
    stage: "planning",
    nudgeText: (p) =>
      `Hi ${firstName(p)}, quick nudge about ${event.title}: which times work for you? ${slots}. Any food preferences or dietary needs?`,
  };
  if (deadline && !Number.isNaN(deadline.getTime())) round.deadline = deadline;
  return round;
}

function votingRound(event: DinnerEvent, done: readonly string[]): Round | undefined {
  if (event.restaurantOptions.length === 0 || event.winningRestaurantId) return undefined;
  const opened = votingOpenedAt(event, done);
  if (!opened) return undefined;
  const ballot = event.restaurantOptions.map((o) => `${o.id}) ${o.name}`).join(" ");
  return {
    stage: "voting",
    deadline: new Date(opened.getTime() + DEFAULT_REPLY_WINDOW_MS),
    nudgeAfter: new Date(opened.getTime() + DEFAULT_REPLY_WINDOW_MS / 2),
    nudgeText: (p) => `Hi ${firstName(p)}, quick nudge to vote for ${event.title}: ${ballot}. Reply with a number.`,
  };
}

function roundWork(event: DinnerEvent, round: Round, now: Date, out: DueWork): void {
  const status = getStatus(event, now);
  // Planning's halfway point comes from getStatus so the runner and Fo agree on it.
  const nudgeAfterRaw = round.stage === "planning" ? status.details.nudgeAfter : round.nudgeAfter?.toISOString();
  const nudgeAfter = typeof nudgeAfterRaw === "string" ? Date.parse(nudgeAfterRaw) : undefined;
  const deadlineIso = round.deadline?.toISOString();
  const rs = roundStatus({
    invitedIds: status.pending.map((p) => p.id),
    answeredIds: [],
    nudgedIds: event.nudgedIds,
    ...(deadlineIso ? { deadline: deadlineIso } : {}),
    now: now.toISOString(),
  });

  if (nudgeAfter !== undefined && deadlineIso && now.getTime() >= nudgeAfter) {
    for (const id of rs.toNudge) {
      const person = event.people.find((p) => p.id === id);
      if (!person || person.optedOut) continue;
      out.sends.push({
        eventId: event.id,
        key: `${event.id}:nudge:${round.stage}:${deadlineIso}:${person.id}`,
        kind: "nudge",
        to: [recipient(person)],
        text: round.nudgeText(person),
      });
    }
  }

  if (rs.readyToDecide) {
    out.triggers.push({
      kind: "deadline",
      eventId: event.id,
      round: round.stage,
      key: `${event.id}:deadline:${round.stage}:${deadlineIso ?? "none"}`,
    });
  }
}

function bookedWork(event: DinnerEvent, now: Date, opts: TimerOptions, out: DueWork): void {
  const booking = event.booking;
  if (!booking) return;
  const starts = new Date(booking.startsAt);
  if (Number.isNaN(starts.getTime())) return;
  const nowMs = now.getTime();

  const local = localParts(starts, opts.timeZone);
  const earliest = zonedTime(local.year, local.month, local.day, DAY_OF_EARLIEST_HOUR, 0, opts.timeZone);
  const remindAt = Math.max(starts.getTime() - DAY_OF_LEAD_MS, earliest.getTime());
  // A reminder after the table time is useless, so a missed one is dropped.
  if (nowMs >= remindAt && nowMs < starts.getTime()) {
    const going = event.people.filter((p) => !p.optedOut && canMakeSlot(event, p, booking.slotId));
    if (going.length > 0) {
      const when = sameLocalDay(now, starts, opts.timeZone)
        ? local.hour >= 17
          ? "tonight"
          : "today"
        : `on ${new Intl.DateTimeFormat("en-US", { timeZone: opts.timeZone, weekday: "long" }).format(starts)}`;
      out.sends.push({
        eventId: event.id,
        key: `${event.id}:day-of:${starts.toISOString()}`,
        kind: "day_of_reminder",
        to: going.map(recipient),
        text: `Reminder: ${booking.restaurantName} ${when} at ${localTimeLabel(starts, opts.timeZone)}!`,
      });
    }
  }

  if (nowMs >= starts.getTime() + AFTER_DINNER_MS) {
    out.triggers.push({ kind: "after_dinner", eventId: event.id, key: `${event.id}:after-dinner:${starts.toISOString()}` });
  }
}

function payingWork(event: DinnerEvent, now: Date, out: DueWork): void {
  const organizer = event.people.find((p) => p.id === event.organizerId);
  const nowMs = now.getTime();
  for (const pay of event.payments) {
    if (pay.status !== "pending" || pay.amountCents <= 0) continue;
    const person = event.people.find((p) => p.id === pay.personId);
    if (!person || person.optedOut || person.id === event.organizerId) continue;
    // calculate_shares stamps updatedAt on a new or changed amount, and only
    // status changes touch it after that, so for a pending payment it is when
    // this share was calculated.
    const base = Date.parse(pay.updatedAt);
    if (Number.isNaN(base)) continue;
    // Reminder 1 only inside its own window: if the runner was down past 72h,
    // send just the last one rather than two back to back.
    const n = nowMs >= base + PAY_REMINDER_2_MS ? 2 : nowMs >= base + PAY_REMINDER_1_MS ? 1 : 0;
    if (n === 0) continue;
    const amount = formatCents(pay.amountCents);
    const payee = organizer ? firstName(organizer) : "the organizer";
    const how = pay.venmoUrl ? `Pay ${payee} here: ${pay.venmoUrl}` : `Please pay ${payee} back when you can.`;
    const lead = n === 1 ? "friendly reminder" : "one last reminder";
    out.sends.push({
      eventId: event.id,
      key: `${event.id}:pay-reminder:${n}:${person.id}:${pay.amountCents}`,
      kind: "payment_reminder",
      to: [recipient(person)],
      text: `Hi ${firstName(person)}, ${lead}: your share for ${event.title} is ${amount}. ${how}`,
    });
  }
}

/**
 * Sends and triggers due at `now`. Skips keys already in `state.done`, and
 * returns nothing during quiet hours (so work is deferred to the morning).
 */
export function dueWork(events: DinnerEvent[], state: RunnerState, now: Date, opts: TimerOptions): DueWork {
  const out: DueWork = { sends: [], triggers: [] };
  if (isQuietTime(now, opts)) return out;
  for (const event of events) {
    switch (event.stage) {
      case "planning": {
        const round = planningRound(event);
        if (round) roundWork(event, round, now, out);
        break;
      }
      case "voting": {
        const round = votingRound(event, state.done);
        if (round) roundWork(event, round, now, out);
        break;
      }
      case "booked":
        bookedWork(event, now, opts, out);
        break;
      case "paying":
        payingWork(event, now, out);
        break;
      default:
        break;
    }
  }
  const done = new Set(state.done);
  return {
    sends: out.sends.filter((s) => !done.has(s.key)),
    triggers: out.triggers.filter((t) => !done.has(t.key)),
  };
}
