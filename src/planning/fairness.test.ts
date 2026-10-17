import { describe, expect, it } from "vitest";
import type { Concession, Person } from "../types.js";
import { fairnessNote, newConcessions, priorityIds, priorityPhones, redeem } from "./fairness.js";
import { tallyVotes } from "./votes.js";

const people: Person[] = [
  { id: "pranav", name: "Pranav", phone: "+15550000001", isOrganizer: true },
  { id: "maya", name: "Maya", phone: "+15550000002", isOrganizer: false },
  { id: "jordan", name: "Jordan", phone: "+15550000003", isOrganizer: false },
  { id: "sam", name: "Sam", phone: "+15550000004", isOrganizer: false },
];
const phones = people.map((p) => p.phone);

describe("fairness memory", () => {
  it("round trips across two events", () => {
    // Event 1: Maya and Sam lose the vote.
    let memory: Concession[] = [];
    memory.push(
      ...newConcessions({
        eventId: "e1",
        people,
        gaveUpIds: ["maya"],
        what: "restaurant vote",
        now: "2026-10-10T20:00:00Z",
      }),
      ...newConcessions({
        eventId: "e1",
        people,
        gaveUpIds: ["sam"],
        what: "cuisine: thai",
        now: "2026-10-10T21:00:00Z",
      }),
    );
    expect(memory).toHaveLength(2);
    expect(priorityPhones(memory, phones)).toEqual(["+15550000002", "+15550000004"]);

    // Re-running the same tally doesn't double count.
    const again = newConcessions({
      eventId: "e1",
      people,
      gaveUpIds: ["maya"],
      what: "restaurant vote",
      now: "2026-10-10T22:00:00Z",
      existing: memory,
    });
    expect(again).toEqual([]);

    // Concessions from the same event are not redeemed in that event.
    expect(redeem(memory, ["+15550000002"], "e1")).toEqual(memory);

    // Event 2: a different group of people with new ids, same phones.
    const event2People: Person[] = [
      { id: "jordan", name: "Jordan", phone: "+15550000003", isOrganizer: true },
      { id: "maya-k", name: "Maya", phone: "+15550000002", isOrganizer: false },
      { id: "pranav", name: "Pranav", phone: "+15550000001", isOrganizer: false },
    ];
    const ids = priorityIds(memory, event2People);
    expect(ids).toEqual(["maya-k"]);
    expect(fairnessNote({ people: event2People, priorityPhones: ["+15550000002"] })).toBe(
      "Maya gave up a pick last time, so Maya gets priority tonight.",
    );

    const tally = tallyVotes({
      options: [
        { id: "1", name: "Luigi's" },
        { id: "2", name: "Thai Basil" },
      ],
      voterIds: ["jordan", "maya-k", "pranav"],
      organizerId: "jordan",
      priorityIds: ids,
      names: { "maya-k": "Maya" },
      votes: [
        { personId: "maya-k", restaurantId: "2", updatedAt: "2026-10-17T12:00:00Z" },
        { personId: "pranav", restaurantId: "1", updatedAt: "2026-10-17T12:00:00Z" },
      ],
    });
    expect(tally.winnerId).toBe("2");
    expect(tally.tieBrokenBy).toBe("fairness");

    memory = redeem(memory, ["+15550000002"], "e2");
    expect(memory.find((c) => c.phone === "+15550000002")!.redeemedInEventId).toBe("e2");
    expect(memory.find((c) => c.phone === "+15550000004")!.redeemedInEventId).toBeUndefined();
    expect(priorityPhones(memory, phones)).toEqual(["+15550000004"]);
  });

  it("skips unknown ids and phones outside the group", () => {
    expect(newConcessions({ eventId: "e1", people, gaveUpIds: ["ghost"], what: "x", now: "2026-10-10T00:00:00Z" })).toEqual([]);
    const memory: Concession[] = [{ phone: "+19999999999", eventId: "e0", what: "x", at: "2026-01-01T00:00:00Z" }];
    expect(priorityPhones(memory, phones)).toEqual([]);
  });

  it("orders priority by each phone's oldest open concession", () => {
    const memory: Concession[] = [
      { phone: "+15550000003", eventId: "e1", what: "a", at: "2026-02-01T00:00:00Z" },
      { phone: "+15550000002", eventId: "e1", what: "a", at: "2026-03-01T00:00:00Z" },
      { phone: "+15550000002", eventId: "e0", what: "a", at: "2026-01-01T00:00:00Z" },
    ];
    expect(priorityPhones(memory, phones)).toEqual(["+15550000002", "+15550000003"]);
  });

  it("writes notes without gendered pronouns", () => {
    expect(fairnessNote({ people, priorityPhones: [] })).toBeUndefined();
    const note = fairnessNote({ people, priorityPhones: ["+15550000002", "+15550000004"] })!;
    expect(note).toBe("Maya and Sam gave up a pick last time, so they get priority tonight.");
    expect(note).not.toMatch(/\b(her|his|she|he)\b/i);
  });
});
