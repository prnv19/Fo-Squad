import { describe, expect, it } from "vitest";
import type { DinnerEvent, Person } from "../types.js";
import {
  dueWork,
  isQuietTime,
  nextAllowedTime,
  roundMarkers,
  zonedTime,
  type TimerOptions,
} from "./timers.js";
import type { RunnerState } from "./types.js";

const LA: TimerOptions = { timeZone: "America/Los_Angeles", quietHours: { start: 21, end: 9 } };
const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;
const plus = (iso: string, hours: number) => new Date(Date.parse(iso) + hours * HOUR);

function state(done: string[] = []): RunnerState {
  return { cursors: {}, done, foConversationByEvent: {}, outbox: {} };
}

const people: Person[] = [
  { id: "pranav", name: "Pranav", phone: "+15550000001", isOrganizer: true },
  { id: "maya", name: "Maya", phone: "+15550000002", isOrganizer: false },
  { id: "jordan", name: "Jordan", phone: "+15550000003", isOrganizer: false },
  { id: "sam", name: "Sam", phone: "+15550000004", isOrganizer: false, optedOut: true },
];

// Sat Oct 17 2026, 10am PDT (UTC-7). Deadline noon, so the nudge point is 11am.
const CREATED = "2026-10-17T17:00:00.000Z";
const DEADLINE = "2026-10-17T19:00:00.000Z";

function event(overrides: Partial<DinnerEvent> = {}): DinnerEvent {
  return {
    id: "dinner-1",
    title: "Saturday dinner",
    createdAt: CREATED,
    updatedAt: CREATED,
    stage: "planning",
    organizerId: "pranav",
    people: structuredClone(people),
    timeSlots: [
      { id: "A", label: "Sat 7:30pm", startsAt: "2026-10-18T02:30:00.000Z" },
      { id: "B", label: "Sun 6pm", startsAt: "2026-10-19T01:00:00.000Z" },
    ],
    replyDeadline: DEADLINE,
    nudgedIds: [],
    preferences: [],
    restaurantOptions: [],
    votes: [],
    receipts: [],
    claims: [],
    claimAnsweredIds: [],
    treatedIds: [],
    unclaimedPolicy: "block",
    feesSplitEvenly: false,
    payments: [],
    ...overrides,
  };
}

const pref = (personId: string, slotIds: string[]) => ({
  personId,
  slotIds,
  anyTime: false,
  cuisines: [],
  avoidCuisines: [],
  dietary: [],
  plusOnes: 0,
  updatedAt: CREATED,
});

describe("planning round", () => {
  it("nudges nobody before the halfway point", () => {
    const work = dueWork([event()], state(), at("2026-10-17T17:59:00Z"), LA);
    expect(work).toEqual({ sends: [], triggers: [] });
  });

  it("nudges each pending, non-opted-out, not-yet-nudged friend once after halfway", () => {
    const e = event({ preferences: [pref("jordan", ["A"])] });
    const work = dueWork([e], state(), at("2026-10-17T18:00:00Z"), LA);
    expect(work.triggers).toEqual([]);
    expect(work.sends).toHaveLength(1);
    const send = work.sends[0]!;
    expect(send).toMatchObject({
      eventId: "dinner-1",
      kind: "nudge",
      key: `dinner-1:nudge:planning:${DEADLINE}:maya`,
      to: [{ personId: "maya", name: "Maya", phone: "+15550000002" }],
    });
    expect(send.text).toContain("Saturday dinner");
    expect(send.text).toContain("A) Sat 7:30pm");

    // Someone Fo already nudged (mark_nudged) isn't nudged again.
    expect(dueWork([{ ...e, nudgedIds: ["maya"] }], state(), at("2026-10-17T18:30:00Z"), LA).sends).toEqual([]);
    // And the done key stops a repeat even before mark_nudged lands.
    expect(dueWork([e], state([send.key]), at("2026-10-17T18:30:00Z"), LA).sends).toEqual([]);
  });

  it("fires the deadline trigger once the deadline passes, with no more nudges", () => {
    const e = event({ preferences: [pref("jordan", ["A"])] });
    const work = dueWork([e], state(), at(DEADLINE), LA);
    expect(work.sends).toEqual([]);
    expect(work.triggers).toEqual([
      { kind: "deadline", eventId: "dinner-1", round: "planning", key: `dinner-1:deadline:planning:${DEADLINE}` },
    ]);
    expect(dueWork([e], state([work.triggers[0]!.key]), plus(DEADLINE, 1), LA).triggers).toEqual([]);
  });

  it("fires the deadline trigger early when everyone answered", () => {
    const e = event({ preferences: [pref("jordan", ["A"]), pref("maya", ["B"])] });
    const work = dueWork([e], state(), at("2026-10-17T17:30:00Z"), LA);
    expect(work.triggers.map((t) => t.kind)).toEqual(["deadline"]);
  });

  it("does nothing once a time is picked", () => {
    const e = event({ chosenSlotId: "A" });
    expect(dueWork([e], state(), at(DEADLINE), LA)).toEqual({ sends: [], triggers: [] });
  });
});

describe("voting round", () => {
  const OPENED = "2026-10-17T20:00:00.000Z"; // 1pm PDT
  const voting = (overrides: Partial<DinnerEvent> = {}) =>
    event({
      stage: "voting",
      chosenSlotId: "A",
      updatedAt: OPENED,
      preferences: [pref("maya", ["A"]), pref("jordan", ["B"])],
      restaurantOptions: [
        { id: "1", name: "Luigi's" },
        { id: "2", name: "Tavola" },
      ],
      ...overrides,
    });

  it("needs a round marker, which records when the ballot opened", () => {
    const e = voting();
    expect(dueWork([e], state(), plus(OPENED, 3), LA)).toEqual({ sends: [], triggers: [] });
    const markers = roundMarkers([e], state(), plus(OPENED, 0.1));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatch(new RegExp(`^dinner-1:voting-open:[0-9a-f]+:${OPENED}$`));
    expect(roundMarkers([e], state(markers), plus(OPENED, 0.2))).toEqual([]);
    // A different ballot is a new round.
    const reballot = voting({ restaurantOptions: [{ id: "1", name: "Osteria" }] });
    expect(roundMarkers([reballot], state(markers), plus(OPENED, 0.2))).toHaveLength(1);
  });

  it("nudges voters who haven't voted after an hour, skipping people who can't make the slot", () => {
    const e = voting({ votes: [{ personId: "pranav", restaurantId: "1", updatedAt: OPENED }] });
    const s = state(roundMarkers([voting()], state(), at(OPENED)));
    expect(dueWork([e], s, plus(OPENED, 0.9), LA).sends).toEqual([]);
    const work = dueWork([e], s, plus(OPENED, 1), LA);
    const deadline = plus(OPENED, 2).toISOString();
    // Jordan can only do B and Sam opted out; Pranav already voted.
    expect(work.sends.map((x) => x.key)).toEqual([`dinner-1:nudge:voting:${deadline}:maya`]);
    expect(work.sends[0]!.text).toContain("1) Luigi's 2) Tavola");
  });

  it("triggers the voting deadline after two hours, and stops once there's a winner", () => {
    const e = voting();
    const s = state(roundMarkers([e], state(), at(OPENED)));
    const work = dueWork([e], s, plus(OPENED, 2), LA);
    expect(work.triggers).toEqual([
      expect.objectContaining({ kind: "deadline", round: "voting", eventId: "dinner-1" }),
    ]);
    expect(dueWork([{ ...e, winningRestaurantId: "1" }], s, plus(OPENED, 2), LA)).toEqual({ sends: [], triggers: [] });
  });
});

describe("booked", () => {
  // Sat 7:30pm PDT.
  const STARTS = "2026-10-18T02:30:00.000Z";
  const booked = (startsAt = STARTS, slotId = "A") =>
    event({
      stage: "booked",
      chosenSlotId: slotId,
      preferences: [pref("maya", ["A"]), pref("jordan", ["B"])],
      booking: { restaurantName: "Luigi's", slotId, startsAt, partySize: 3 },
    });

  it("reminds everyone going four hours before, skipping opted-out and can't-make people", () => {
    expect(dueWork([booked()], state(), plus(STARTS, -4.1), LA).sends).toEqual([]);
    const work = dueWork([booked()], state(), plus(STARTS, -4), LA);
    expect(work.sends).toHaveLength(1);
    expect(work.sends[0]).toMatchObject({
      kind: "day_of_reminder",
      key: `dinner-1:day-of:${STARTS}`,
      text: "Reminder: Luigi's tonight at 7:30pm!",
    });
    expect(work.sends[0]!.to.map((t) => t.personId)).toEqual(["pranav", "maya"]);
    expect(dueWork([booked()], state([work.sends[0]!.key]), plus(STARTS, -1), LA).sends).toEqual([]);
  });

  it("never reminds before 9am local, and drops a reminder once dinner started", () => {
    // Brunch at 10am PDT: four hours before is 6am, so 9am wins.
    const brunch = "2026-10-17T17:00:00.000Z";
    expect(dueWork([booked(brunch)], state(), at("2026-10-17T15:59:00Z"), LA).sends).toEqual([]);
    const work = dueWork([booked(brunch)], state(), at("2026-10-17T16:00:00Z"), LA);
    expect(work.sends[0]?.text).toBe("Reminder: Luigi's today at 10am!");
    expect(dueWork([booked(brunch)], state(), at("2026-10-17T17:00:00Z"), LA).sends).toEqual([]);
  });

  it("triggers after_dinner two hours after the start, deferred past quiet hours", () => {
    // 9:30pm PDT is quiet, so it waits for 9am Sunday.
    expect(dueWork([booked()], state(), plus(STARTS, 2), LA).triggers).toEqual([]);
    const morning = at("2026-10-18T16:00:00Z");
    const work = dueWork([booked()], state(), morning, LA);
    expect(work.triggers).toEqual([
      { kind: "after_dinner", eventId: "dinner-1", key: `dinner-1:after-dinner:${STARTS}` },
    ]);
    expect(dueWork([booked()], state([work.triggers[0]!.key]), morning, LA).triggers).toEqual([]);
  });
});

describe("paying", () => {
  // Shares calculated Sun 10am PDT.
  const CALC = "2026-10-18T17:00:00.000Z";
  const paying = (payments: DinnerEvent["payments"]) => event({ stage: "paying", payments });
  const pending = (personId: string, amountCents: number, updatedAt = CALC) => ({
    personId,
    amountCents,
    status: "pending" as const,
    venmoUrl: `https://venmo.com/pranav?txn=pay&amount=${amountCents / 100}`,
    updatedAt,
  });

  it("sends reminder 1 at 24h and 2 at 72h, only for pending payments", () => {
    const e = paying([
      pending("maya", 2688),
      { ...pending("jordan", 4736), status: "says_paid" },
      { ...pending("pranav-friend", 1000), status: "paid" },
    ]);
    expect(dueWork([e], state(), plus(CALC, 23.9), LA).sends).toEqual([]);

    const first = dueWork([e], state(), plus(CALC, 24), LA).sends;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "payment_reminder", key: "dinner-1:pay-reminder:1:maya:2688" });
    expect(first[0]!.text).toContain("$26.88");
    expect(first[0]!.text).toContain("https://venmo.com/pranav?txn=pay&amount=26.88");
    expect(first[0]!.text).toContain("Saturday dinner");

    const s = state([first[0]!.key]);
    expect(dueWork([e], s, plus(CALC, 71), LA).sends).toEqual([]);
    const second = dueWork([e], s, plus(CALC, 72), LA).sends;
    expect(second.map((x) => x.key)).toEqual(["dinner-1:pay-reminder:2:maya:2688"]);

    // After reminder 2, nothing more: no send and no trigger.
    expect(dueWork([e], state([first[0]!.key, second[0]!.key]), plus(CALC, 200), LA)).toEqual({ sends: [], triggers: [] });
  });

  it("sends only the last reminder if the runner missed the first window", () => {
    const e = paying([pending("maya", 2688)]);
    expect(dueWork([e], state(), plus(CALC, 80), LA).sends.map((x) => x.key)).toEqual([
      "dinner-1:pay-reminder:2:maya:2688",
    ]);
  });

  it("restarts reminders for a recalculated share", () => {
    const old = state(["dinner-1:pay-reminder:1:maya:2688", "dinner-1:pay-reminder:2:maya:2688"]);
    // A dispute changed Maya's share on day 4; calculate_shares resets it to pending with a new timestamp.
    const recalc = plus(CALC, 96).toISOString();
    const e = paying([pending("maya", 2400, recalc)]);
    expect(dueWork([e], old, plus(CALC, 100), LA).sends).toEqual([]);
    const work = dueWork([e], old, plus(recalc, 24), LA);
    expect(work.sends.map((x) => x.key)).toEqual(["dinner-1:pay-reminder:1:maya:2400"]);
    expect(work.sends[0]!.text).toContain("$24.00");
  });

  it("skips opted-out people", () => {
    const e = paying([pending("sam", 2000)]);
    expect(dueWork([e], state(), plus(CALC, 30), LA).sends).toEqual([]);
  });
});

describe("quiet hours", () => {
  // Nudge point 11am PDT; check a nudge that first became due late in the evening.
  const lateDeadline = "2026-10-18T06:00:00.000Z"; // 11pm PDT Sat
  const lateCreated = "2026-10-18T02:00:00.000Z"; // 7pm PDT Sat -> nudge at 9pm
  const late = () => event({ createdAt: lateCreated, updatedAt: lateCreated, replyDeadline: lateDeadline });

  it("holds sends and triggers through the night and releases them at 9am local", () => {
    expect(dueWork([late()], state(), at("2026-10-18T04:00:00Z"), LA)).toEqual({ sends: [], triggers: [] }); // 9pm
    expect(dueWork([late()], state(), at("2026-10-18T07:30:00Z"), LA)).toEqual({ sends: [], triggers: [] }); // 12:30am
    expect(dueWork([late()], state(), at("2026-10-18T15:59:00Z"), LA)).toEqual({ sends: [], triggers: [] }); // 8:59am
    const morning = dueWork([late()], state(), at("2026-10-18T16:00:00Z"), LA); // 9am
    // The deadline passed overnight, so it's a decision now rather than nudges.
    expect(morning.sends).toEqual([]);
    expect(morning.triggers.map((t) => t.kind)).toEqual(["deadline"]);
  });

  it("uses the configured time zone", () => {
    // 6:30am in New York is 3:30am in LA: quiet in both. 10am NY is 7am LA: open in NY only.
    const ny: TimerOptions = { ...LA, timeZone: "America/New_York" };
    const instant = at("2026-10-18T14:00:00Z");
    expect(isQuietTime(instant, ny)).toBe(false);
    expect(isQuietTime(instant, LA)).toBe(true);
    const e = event({ preferences: [pref("jordan", ["A"])], createdAt: "2026-10-18T12:00:00Z", replyDeadline: "2026-10-18T15:00:00Z" });
    expect(dueWork([e], state(), instant, ny).sends).toHaveLength(1);
    expect(dueWork([e], state(), instant, LA).sends).toEqual([]);
  });

  it("defers across midnight to the end of quiet hours", () => {
    expect(nextAllowedTime(at("2026-10-18T06:00:00Z"), LA).toISOString()).toBe("2026-10-18T16:00:00.000Z"); // 11pm -> 9am next day
    expect(nextAllowedTime(at("2026-10-18T09:00:00Z"), LA).toISOString()).toBe("2026-10-18T16:00:00.000Z"); // 2am -> 9am same day
    const noon = at("2026-10-18T19:00:00Z");
    expect(nextAllowedTime(noon, LA)).toBe(noon);
  });

  it("handles the DST change", () => {
    // US DST ends Nov 1 2026: 9am that day is PST (UTC-8).
    expect(zonedTime(2026, 11, 1, 9, 0, "America/Los_Angeles").toISOString()).toBe("2026-11-01T17:00:00.000Z");
    expect(zonedTime(2026, 10, 31, 9, 0, "America/Los_Angeles").toISOString()).toBe("2026-10-31T16:00:00.000Z");
  });
});
