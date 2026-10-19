import { describe, expect, it } from "vitest";
import type { DinnerEvent, Preferences, Receipt } from "../types.js";
import { createEvent } from "./factory.js";
import { getStatus } from "./status.js";

// Created 18:00, reply deadline 20:00, so nudges are due from 19:00.
const CREATED = "2026-10-17T18:00:00.000Z";
const EARLY = "2026-10-17T18:30:00.000Z";
const HALF = "2026-10-17T19:15:00.000Z";
const LATE = "2026-10-17T20:30:00.000Z";

function base(): DinnerEvent {
  return createEvent(
    {
      title: "Luigi's Sat",
      organizer: { name: "Pranav", phone: "5550001111", venmo: "pranav" },
      friends: [
        { name: "Maya", phone: "5551230001" },
        { name: "Jordan", phone: "5551230002" },
        { name: "Sam", phone: "5551230003" },
        { name: "Priya", phone: "5551230004" },
      ],
      timeSlots: [
        { label: "Fri 7pm", startsAt: "2026-10-23T01:00:00.000Z" },
        { label: "Sat 7:30pm", startsAt: "2026-10-24T01:30:00.000Z" },
      ],
      budgetPerPersonCents: 5000,
    },
    { now: CREATED, id: "evt" },
  );
}

function pref(personId: string, extra: Partial<Preferences> = {}): Preferences {
  return {
    personId,
    slotIds: ["B"],
    anyTime: false,
    cuisines: [],
    avoidCuisines: [],
    dietary: [],
    plusOnes: 0,
    updatedAt: CREATED,
    ...extra,
  };
}

const receipt: Receipt = {
  id: "r1",
  items: [
    { number: 1, description: "Margherita", amountCents: 1800 },
    { number: 2, description: "Lasagna", amountCents: 2200 },
    { number: 3, description: "Garlic bread", amountCents: 900 },
  ],
  subtotalCents: 4900,
  taxCents: 392,
  tipCents: 980,
  feesCents: 0,
  discountCents: 0,
  totalCents: 6272,
  tipIncluded: false,
};

const pendingNames = (e: DinnerEvent, now: string) => getStatus(e, now).pending.map((p) => p.name);

describe("getStatus: planning", () => {
  it("asks Fo to text everyone when nobody has answered", () => {
    const s = getStatus(base(), EARLY);
    expect(s).toMatchObject({ eventId: "evt", title: "Luigi's Sat", stage: "planning", stageNumber: 1 });
    expect(s.nextAction).toMatch(/^Text each friend the time options and ask about food and dietary needs/);
    expect(s.pending.map((p) => p.id)).toEqual(["maya", "jordan", "sam", "priya"]);
  });

  it("mentions a locked organizer pick in the first text", () => {
    const e = { ...base(), organizerPick: { restaurantName: "Luigi's", firmness: "locked" as const } };
    expect(getStatus(e, EARLY).nextAction).toContain("Tell them dinner is at Luigi's.");
  });

  it("waits before half the window", () => {
    const e = { ...base(), preferences: [pref("maya"), pref("jordan")] };
    const s = getStatus(e, EARLY);
    expect(s.nextAction).toMatch(/^Waiting on Sam and Priya\./);
    expect(s.pending.map((p) => p.name)).toEqual(["Sam", "Priya"]);
  });

  it("nudges quiet friends once after half the window", () => {
    const e = { ...base(), preferences: [pref("maya"), pref("jordan")] };
    expect(getStatus(e, HALF).nextAction).toBe("Nudge Sam and Priya once.");
  });

  it("only nudges people not already nudged", () => {
    const e = { ...base(), preferences: [pref("maya")], nudgedIds: ["jordan"] };
    expect(getStatus(e, HALF).nextAction).toBe("Nudge Sam and Priya once.");
    const allNudged = { ...e, nudgedIds: ["jordan", "sam", "priya"] };
    expect(getStatus(allNudged, HALF).nextAction).toMatch(/^Waiting on Jordan, Sam and Priya\. Call pick_time/);
  });

  it("nudges everyone if nobody answered by half the window", () => {
    expect(getStatus(base(), HALF).nextAction).toBe("Nudge Maya, Jordan, Sam and Priya once.");
  });

  it("calls pick_time when everyone answered", () => {
    const e = { ...base(), preferences: ["maya", "jordan", "sam", "priya"].map((id) => pref(id)) };
    expect(getStatus(e, EARLY).nextAction).toBe("Everyone answered. Call pick_time.");
    expect(getStatus(e, EARLY).pending).toEqual([]);
  });

  it("calls pick_time after the deadline", () => {
    const e = { ...base(), preferences: [pref("maya")] };
    const s = getStatus(e, LATE);
    expect(s.nextAction).toMatch(/Call pick_time to decide with whoever answered\.$/);
    expect(s.details.deadlinePassed).toBe(true);
  });

  it("asks the organizer when nobody answered by the deadline", () => {
    expect(getStatus(base(), LATE).nextAction).toMatch(/^Nobody answered/);
  });

  it("finds restaurants once a slot is chosen, respecting dietary needs and the tightest budget", () => {
    const e = {
      ...base(),
      chosenSlotId: "B",
      preferences: [
        pref("maya", { dietary: ["vegetarian"], budgetCents: 3500 }),
        pref("jordan", { dietary: ["nut allergy"] }),
        // Sam can't make B, so his budget and diet don't constrain the pick.
        pref("sam", { slotIds: ["A"], dietary: ["vegan"], budgetCents: 2000 }),
      ],
    };
    const s = getStatus(e, EARLY);
    expect(s.nextAction).toBe(
      "Find three restaurants with a table open at Sat 7:30pm that fit the winning cuisine from pick_time, every dietary need (vegetarian, nut allergy) and about $35.00 per person or less, then call set_restaurant_options.",
    );
    expect(s.pending).toEqual([]);
  });

  it("names the chosen cuisine once pick_time saved it", () => {
    const e = {
      ...base(),
      chosenSlotId: "B",
      chosenCuisine: "italian",
      preferences: [pref("maya", { dietary: ["vegetarian"] })],
    };
    expect(getStatus(e, EARLY).nextAction).toBe(
      "Find three Italian restaurants with a table open at Sat 7:30pm that fit every dietary need (vegetarian) and about $50.00 per person or less, then call set_restaurant_options.",
    );
    const noLimits = { ...e, budgetPerPersonCents: undefined, preferences: [] };
    expect(getStatus(noLimits, EARLY).nextAction).toBe(
      "Find three Italian restaurants with a table open at Sat 7:30pm, then call set_restaurant_options.",
    );
  });

  it("treats replies cleared by new time options as pending", () => {
    const e = {
      ...base(),
      preferences: ["maya", "jordan", "sam", "priya"].map((id) => pref(id, { slotsStale: id === "sam" ? true : undefined })),
    };
    expect(pendingNames(e, EARLY)).toEqual(["Sam"]);
  });

  it("books the organizer's locked pick once a slot is chosen", () => {
    const e = {
      ...base(),
      chosenSlotId: "B",
      organizerPick: { restaurantName: "Luigi's", firmness: "locked" as const },
    };
    expect(getStatus(e, EARLY).nextAction).toBe(
      "Book Luigi's for Sat 7:30pm after the organizer approves, then call confirm_booking.",
    );
  });

  it("handles split-only events with no time slots", () => {
    const e = { ...base(), timeSlots: [] };
    expect(getStatus(e, EARLY).nextAction).toMatch(/add_receipt/);
  });
});

describe("getStatus: opted out", () => {
  it("excludes opted-out people from pending and mentions them", () => {
    const e = base();
    e.people = e.people.map((p) => (p.id === "sam" ? { ...p, optedOut: true } : p));
    e.preferences = [pref("maya"), pref("jordan")];
    const s = getStatus(e, HALF);
    expect(s.pending.map((p) => p.name)).toEqual(["Priya"]);
    expect(s.nextAction).toBe("Nudge Priya once. Don't text Sam (opted out).");
    expect(s.details.optedOut).toEqual(["Sam"]);
  });

  it("tells Fo when every friend opted out", () => {
    const e = base();
    e.people = e.people.map((p) => (p.isOrganizer ? p : { ...p, optedOut: true }));
    expect(getStatus(e, EARLY).nextAction).toMatch(/^Every friend on this dinner opted out/);
  });

  it("asks the organizer for an opted-out attendee's claims", () => {
    const e: DinnerEvent = {
      ...base(),
      stage: "claiming",
      receipts: [receipt],
      attendeeIds: ["pranav", "maya", "sam"],
      claims: [
        { personId: "pranav", itemNumber: 1, weight: 1 },
        { personId: "maya", itemNumber: 2, weight: 1 },
      ],
    };
    e.people = e.people.map((p) => (p.id === "sam" ? { ...p, optedOut: true } : p));
    const s = getStatus(e, LATE);
    expect(s.pending).toEqual([]);
    expect(s.nextAction).toMatch(/^Ask the organizer which items Sam had/);
  });
});

describe("getStatus: voting", () => {
  const voting = (): DinnerEvent => ({
    ...base(),
    stage: "voting",
    chosenSlotId: "B",
    preferences: [pref("maya"), pref("jordan"), pref("sam", { slotIds: ["A"] }), pref("priya", { anyTime: true, slotIds: [] })],
    restaurantOptions: [
      { id: "1", name: "Luigi's" },
      { id: "2", name: "Osteria Marco" },
    ],
  });

  it("lists pending voters who can make the slot, including the organizer", () => {
    const e = { ...voting(), votes: [{ personId: "maya", restaurantId: "1", updatedAt: CREATED }] };
    const s = getStatus(e, EARLY);
    expect(s.stageNumber).toBe(2);
    expect(s.pending.map((p) => p.name)).toEqual(["Pranav", "Jordan", "Priya"]);
    expect(s.nextAction).toMatch(/^Waiting on votes from Pranav, Jordan and Priya\./);
  });

  it("tallies when everyone voted", () => {
    const e = {
      ...voting(),
      votes: ["pranav", "maya", "jordan", "priya"].map((personId) => ({ personId, restaurantId: "1", updatedAt: CREATED })),
    };
    expect(getStatus(e, EARLY).nextAction).toBe(
      "Everyone voted. Call tally_votes, then ask the organizer to approve booking the winner.",
    );
  });

  it("asks for approval once there is a winner", () => {
    const e = { ...voting(), winningRestaurantId: "2" };
    expect(getStatus(e, EARLY).nextAction).toBe(
      "Ask the organizer to approve booking Osteria Marco for Sat 7:30pm, then call confirm_booking.",
    );
  });
});

describe("getStatus: booked", () => {
  const booked = (): DinnerEvent => ({
    ...base(),
    stage: "booked",
    chosenSlotId: "B",
    booking: { restaurantName: "Luigi's", slotId: "B", startsAt: "2026-10-24T01:30:00.000Z", partySize: 5 },
  });

  it("schedules the reminder 4 hours before dinner, and the bill question 2 hours after it starts", () => {
    // Starts 6:30pm Los Angeles time.
    const s = getStatus(booked(), EARLY);
    expect(s.stageNumber).toBe(3);
    expect(s.nextAction).toBe(
      `Send each attendee the day-of reminder "Reminder: Luigi's, Sat 7:30pm!" at 2026-10-23T21:30:00.000Z (2:30pm America/Los_Angeles, before the Sat 7:30pm start). Ask the organizer about the bill at 2026-10-24T03:30:00.000Z.`,
    );
    expect(s.details).toMatchObject({ dayOfReminderAt: "2026-10-23T21:30:00.000Z", billQuestionAt: "2026-10-24T03:30:00.000Z" });
  });

  it("lists the other ballot choices as backups for a hard constraint raised after booking", () => {
    const e = { ...booked(), restaurantOptions: [{ id: "1", name: "Luigi's" }, { id: "2", name: "Osteria Marco", cuisine: "Italian" }] };
    const s = getStatus(e, EARLY);
    expect(s.details.backupOptions).toEqual([{ name: "Osteria Marco", cuisine: "Italian", notes: undefined }]);
    expect(s.nextAction).toMatch(/name a place from backupOptions that works for everyone\.$/);
    expect(getStatus(booked(), EARLY).details.backupOptions).toBeUndefined();
  });

  it("never schedules a lunch reminder after the lunch, or before 9am", () => {
    // Noon lunch in Denver (18:00Z): 4 hours before is 8am local, so it waits until 9am.
    const noon = { ...booked(), booking: { ...booked().booking!, startsAt: "2026-10-19T18:00:00.000Z" } };
    const s = getStatus(noon, "2026-10-18T18:00:00.000Z", "America/Denver");
    expect(s.details.dayOfReminderAt).toBe("2026-10-19T15:00:00.000Z");
    expect(s.nextAction).toContain("(9:00am America/Denver, before the Sat 7:30pm start)");
    expect(s.nextAction).not.toMatch(/afternoon/);
  });

  it("asks for the reminder right away once its time has passed, until the start", () => {
    const s = getStatus(booked(), "2026-10-23T23:00:00.000Z");
    expect(s.nextAction).toBe(
      `Send each attendee the day-of reminder now if it hasn't gone out: "Reminder: Luigi's, Sat 7:30pm!" Ask the organizer about the bill at 2026-10-24T03:30:00.000Z.`,
    );
  });

  it("after dinner, asks the organizer whether to split or cover the bill", () => {
    const next = getStatus(booked(), "2026-10-24T04:00:00.000Z").nextAction;
    expect(next).toContain('"Want me to split the bill, or is it on you?"');
    expect(next).toContain("Split: ask for the receipt photo, then call add_receipt.");
    expect(next).toContain("Their treat: call cover_bill");
  });
});

describe("getStatus: claiming", () => {
  const claiming = (): DinnerEvent => ({ ...base(), stage: "claiming", receipts: [receipt] });

  it("asks who came first", () => {
    const s = getStatus(claiming(), LATE);
    expect(s.stageNumber).toBe(4);
    expect(s.nextAction).toBe("Confirm who actually came, then call set_attendees.");
  });

  it("waits on claims from attendees without claim rows", () => {
    const e = {
      ...claiming(),
      attendeeIds: ["pranav", "maya", "jordan"],
      claims: [{ personId: "maya", itemNumber: 1, weight: 1 }],
    };
    expect(pendingNames(e, LATE)).toEqual(["Pranav", "Jordan"]);
    expect(getStatus(e, LATE).nextAction).toBe("Waiting on claims from Pranav and Jordan.");
  });

  it("counts 'I had nothing' replies from claimAnsweredIds as answered", () => {
    const e: DinnerEvent = {
      ...claiming(),
      attendeeIds: ["pranav", "maya", "jordan"],
      claims: [
        { personId: "maya", itemNumber: 1, weight: 1 },
        { personId: "maya", itemNumber: 2, weight: 1 },
        { personId: "maya", itemNumber: 3, weight: 1 },
      ],
      claimAnsweredIds: ["maya", "jordan"],
    };
    expect(pendingNames(e, LATE)).toEqual(["Pranav"]);
    const allIn = { ...e, claimAnsweredIds: ["maya", "jordan", "pranav"] };
    expect(getStatus(allIn, LATE).nextAction).toMatch(/^Call calculate_shares/);
  });

  it("flags unclaimed items under the block policy", () => {
    const e = {
      ...claiming(),
      attendeeIds: ["pranav", "maya"],
      claims: [
        { personId: "maya", itemNumber: 1, weight: 1 },
        { personId: "pranav", itemNumber: 2, weight: 1 },
      ],
    };
    const s = getStatus(e, LATE);
    expect(s.nextAction).toMatch(/^Everyone answered but item 3 is unclaimed\./);
    expect(s.details.unclaimedItems).toEqual([3]);
  });

  it("includes the numbered item list, so a late reply in a fresh turn can be matched to numbers", () => {
    const s = getStatus({ ...claiming(), attendeeIds: ["pranav", "maya"] }, LATE);
    expect(s.details.itemList).toMatch(/^1\) \S.* \$\d+\.\d{2} {2}2\) /);
  });

  it("calculates once all claims are in", () => {
    const e = {
      ...claiming(),
      attendeeIds: ["pranav", "maya"],
      claims: [
        { personId: "maya", itemNumber: 1, weight: 1 },
        { personId: "maya", itemNumber: 3, weight: 1 },
        { personId: "pranav", itemNumber: 2, weight: 1 },
        { personId: "pranav", itemNumber: 3, weight: 1 },
      ],
    };
    expect(getStatus(e, LATE).nextAction).toBe(
      "Call calculate_shares and show the organizer the totals before sending.",
    );
  });

  it("calculates with unclaimed items when the policy splits them evenly", () => {
    const e: DinnerEvent = {
      ...claiming(),
      unclaimedPolicy: "split_evenly",
      attendeeIds: ["maya"],
      claims: [{ personId: "maya", itemNumber: 1, weight: 1 }],
    };
    expect(getStatus(e, LATE).nextAction).toMatch(/^Call calculate_shares/);
  });
});

describe("getStatus: paying", () => {
  const paying = (): DinnerEvent => ({
    ...base(),
    stage: "paying",
    receipts: [receipt],
    attendeeIds: ["pranav", "maya", "jordan"],
    shares: [
      { personId: "pranav", items: [], subtotalCents: 2000, extrasCents: 0, treatCents: 0, totalCents: 2000 },
      { personId: "maya", items: [], subtotalCents: 2688, extrasCents: 0, treatCents: 0, totalCents: 2688 },
      { personId: "jordan", items: [], subtotalCents: 4736, extrasCents: 0, treatCents: 0, totalCents: 4736 },
    ],
  });

  it("waits for the organizer's yes, then send_totals finishes it", () => {
    const s = getStatus(paying(), LATE);
    expect(s.stageNumber).toBe(5);
    expect(s.pending).toEqual([]);
    expect(s.nextAction).toMatch(/^Show the organizer the totals from calculate_shares and wait for their yes\. Then call send_totals/);
    expect(s.details.totals).toEqual([
      { name: "Pranav", total: "$20.00" },
      { name: "Maya", total: "$26.88" },
      { name: "Jordan", total: "$47.36" },
    ]);
  });

  it("asks for calculate_shares when there are no totals yet", () => {
    expect(getStatus({ ...paying(), shares: [] }, LATE).nextAction).toMatch(/^No totals yet\. Call calculate_shares/);
  });
});

describe("getStatus: settled", () => {
  it("is done", () => {
    const s = getStatus({ ...base(), stage: "settled" }, LATE);
    expect(s).toMatchObject({
      stage: "settled",
      stageNumber: 6,
      pending: [],
      nextAction: "Totals are approved and each friend's message has their Venmo link. Night complete once those are sent! Payments are between each friend and the organizer: don't track or chase them.",
    });
  });
});
