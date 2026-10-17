import { describe, expect, it } from "vitest";
import { createEvent, type CreateEventInput } from "./factory.js";
import { isValidEventId } from "./ids.js";

const NOW = new Date("2026-10-17T18:00:00.000Z");

function input(overrides: Partial<CreateEventInput> = {}): CreateEventInput {
  return {
    title: "Luigi's Sat",
    organizer: { name: "Pranav", phone: "(555) 000-1111", venmo: "@pranav-u" },
    friends: [
      { name: "Maya", phone: "555-123-4567" },
      { name: "Jordan", phone: "555-222-3333" },
    ],
    timeSlots: [
      { label: "Fri 7pm", startsAt: "2026-10-23T01:00:00.000Z" },
      { label: "Sat 6pm", startsAt: "2026-10-24T00:00:00.000Z" },
      { label: "Sat 7:30pm", startsAt: "2026-10-24T01:30:00.000Z" },
    ],
    ...overrides,
  };
}

describe("createEvent", () => {
  it("builds a full event with sane defaults", () => {
    const e = createEvent(input(), { now: NOW, id: "evt_test" });
    expect(e).toMatchObject({
      id: "evt_test",
      title: "Luigi's Sat",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      stage: "planning",
      organizerId: "pranav",
      organizerVenmo: "pranav-u",
      replyDeadline: "2026-10-17T20:00:00.000Z",
      nudgedIds: [],
      preferences: [],
      restaurantOptions: [],
      votes: [],
      receipts: [],
      claims: [],
      treatedIds: [],
      unclaimedPolicy: "block",
      feesSplitEvenly: false,
      payments: [],
    });
    expect(e.people).toEqual([
      { id: "pranav", name: "Pranav", phone: "+15550001111", isOrganizer: true },
      { id: "maya", name: "Maya", phone: "+15551234567", isOrganizer: false },
      { id: "jordan", name: "Jordan", phone: "+15552223333", isOrganizer: false },
    ]);
    expect(e.timeSlots.map((s) => s.id)).toEqual(["A", "B", "C"]);
    expect(e.timeSlots[2]).toEqual({ id: "C", label: "Sat 7:30pm", startsAt: "2026-10-24T01:30:00.000Z" });
    expect(e.attendeeIds).toBeUndefined();
    expect(e.budgetPerPersonCents).toBeUndefined();
  });

  it("keeps optional fields", () => {
    const e = createEvent(
      input({
        budgetPerPersonCents: 5000,
        cuisineHint: " italian-ish ",
        replyDeadline: "2026-10-17T22:00:00Z",
        organizerPick: { restaurantName: "Luigi's", firmness: "locked" },
      }),
      { now: NOW, id: "evt_test" },
    );
    expect(e.budgetPerPersonCents).toBe(5000);
    expect(e.cuisineHint).toBe("italian-ish");
    expect(e.replyDeadline).toBe("2026-10-17T22:00:00.000Z");
    expect(e.organizerPick).toEqual({ restaurantName: "Luigi's", firmness: "locked" });
  });

  it("generates a readable id from the title", () => {
    const e = createEvent(input(), { now: NOW });
    expect(e.id).toMatch(/^luigis-sat-[0-9a-z]{4}$/);
    expect(isValidEventId(e.id)).toBe(true);
    expect(createEvent(input({ title: "!!!" }), { now: NOW }).id).toMatch(/^dinner-[0-9a-z]{4}$/);
  });

  it("gives duplicate names distinct ids", () => {
    const e = createEvent(
      input({
        friends: [
          { name: "Maya", phone: "555-123-4567" },
          { name: "maya", phone: "555-222-3333" },
          { name: "Pranav", phone: "555-444-5555" },
        ],
      }),
      { now: NOW, id: "evt_test" },
    );
    expect(e.people.map((p) => p.id)).toEqual(["pranav", "maya", "maya-2", "pranav-2"]);
  });

  it("allows no time slots for split-only nights", () => {
    expect(createEvent(input({ timeSlots: [] }), { now: NOW, id: "x" }).timeSlots).toEqual([]);
  });

  it("drops an empty venmo handle", () => {
    const e = createEvent(input({ organizer: { name: "Pranav", phone: "5550001111", venmo: "@" } }), {
      now: NOW,
      id: "x",
    });
    expect(e.organizerVenmo).toBeUndefined();
  });

  it.each<[string, Partial<CreateEventInput>, RegExp]>([
    ["no friends", { friends: [] }, /at least one friend/],
    ["blank title", { title: "  " }, /title/],
    [
      "organizer phone among friends",
      { friends: [{ name: "Maya", phone: "+1 555 000 1111" }] },
      /Maya's number .* organizer's own number/,
    ],
    [
      "duplicate friend phones",
      {
        friends: [
          { name: "Maya", phone: "555-123-4567" },
          { name: "Sam", phone: "(555) 123-4567" },
        ],
      },
      /Maya and Sam have the same number/,
    ],
    ["bad phone", { friends: [{ name: "Maya", phone: "nope" }] }, /Maya's number/],
    ["blank friend name", { friends: [{ name: " ", phone: "555-123-4567" }] }, /Friend #1 needs a name/],
    ["bad slot time", { timeSlots: [{ label: "Fri", startsAt: "someday" }] }, /Time option A/],
    ["blank slot label", { timeSlots: [{ label: "", startsAt: "2026-10-23T01:00:00Z" }] }, /Time option A/],
    ["past deadline", { replyDeadline: "2026-10-17T17:00:00Z" }, /future/],
    ["bad deadline", { replyDeadline: "tonight" }, /deadline/],
    ["fractional budget", { budgetPerPersonCents: 50.5 }, /budget/],
    ["bad venmo", { organizer: { name: "P", phone: "5550001111", venmo: "@pra nav" } }, /Venmo/],
    [
      "bad pick firmness",
      { organizerPick: { restaurantName: "Luigi's", firmness: "maybe" as "locked" } },
      /locked/,
    ],
  ])("rejects %s", (_name, overrides, message) => {
    expect(() => createEvent(input(overrides), { now: NOW, id: "x" })).toThrow(message);
    expect(() => createEvent(input(overrides), { now: NOW, id: "x" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("rejects unsafe injected ids", () => {
    expect(() => createEvent(input(), { now: NOW, id: "../etc" })).toThrow(/valid event id/);
  });
});
