import { describe, expect, it } from "vitest";
import type { Preferences, TimeSlot } from "../types.js";
import { pickTime } from "./time.js";

const slots: TimeSlot[] = [
  { id: "A", label: "Fri 7pm", startsAt: "2026-10-23T19:00:00-07:00" },
  { id: "B", label: "Sat 6pm", startsAt: "2026-10-24T18:00:00-07:00" },
  { id: "C", label: "Sat 7:30pm", startsAt: "2026-10-24T19:30:00-07:00" },
  { id: "D", label: "Sun 6pm", startsAt: "2026-10-25T18:00:00-07:00" },
];

function pref(personId: string, slotIds: string[], extra: Partial<Preferences> = {}): Preferences {
  return {
    personId,
    slotIds,
    anyTime: false,
    cuisines: [],
    avoidCuisines: [],
    dietary: [],
    plusOnes: 0,
    updatedAt: "2026-10-17T12:00:00Z",
    ...extra,
  };
}

const group = ["pranav", "maya", "jordan", "sam", "priya", "alex"];

describe("pickTime", () => {
  it("picks the slot that works for everyone (demo scenario)", () => {
    const r = pickTime({
      slots,
      invitedIds: group,
      organizerId: "pranav",
      preferences: [
        pref("pranav", ["A", "C"]),
        pref("maya", ["B", "C"]),
        pref("jordan", ["C", "D"]),
        pref("sam", ["A", "C"]),
        pref("priya", ["C"]),
        pref("alex", [], { anyTime: true }),
      ],
    });
    expect(r.status).toBe("unanimous");
    expect(r.slotId).toBe("C");
    expect(r.canMake).toEqual(group);
    expect(r.cantMake).toEqual([]);
    expect(r.partySize).toBe(6);
    expect(r.reason).toBe("Sat 7:30pm works for everyone");
    expect(r.ranking[0]).toMatchObject({ slotId: "C", count: 6, organizerFree: true });
  });

  it("says 'everyone who replied' when some people never answered", () => {
    const r = pickTime({
      slots,
      invitedIds: group,
      organizerId: "pranav",
      preferences: [pref("pranav", ["C"]), pref("maya", ["B", "C"])],
    });
    expect(r.status).toBe("unanimous");
    expect(r.noReply).toEqual(["jordan", "sam", "priya", "alex"]);
    expect(r.reason).toBe("Sat 7:30pm works for everyone who replied");
  });

  it("falls back to majority and names who can't make it", () => {
    const r = pickTime({
      slots,
      invitedIds: ["pranav", "maya", "jordan", "sam", "priya"],
      organizerId: "pranav",
      preferences: [
        pref("pranav", ["B"]),
        pref("maya", ["B", "C"]),
        pref("jordan", ["B"]),
        pref("sam", ["D"]),
        pref("priya", ["B"], { plusOnes: 1 }),
      ],
      names: { sam: "Sam" },
    });
    expect(r.status).toBe("majority");
    expect(r.slotId).toBe("B");
    expect(r.cantMake).toEqual(["sam"]);
    expect(r.partySize).toBe(5);
    expect(r.reason).toBe("Sat 6pm works for 4 of 5; Sam can't make it");
  });

  it("breaks ties toward slots where the organizer is free", () => {
    const r = pickTime({
      slots,
      invitedIds: ["pranav", "maya", "jordan"],
      organizerId: "pranav",
      preferences: [pref("pranav", ["D"]), pref("maya", ["A", "D"]), pref("jordan", ["A"])],
    });
    expect(r.slotId).toBe("D");
    expect(r.tieBrokenBy).toBe("organizer");
    expect(r.reason).toBe("Sun 6pm works for 2 of 3; Jordan can't make it");
  });

  it("then breaks ties by the earliest slot, regardless of listing order", () => {
    const shuffled = [slots[3]!, slots[2]!, slots[1]!, slots[0]!];
    const r = pickTime({
      slots: shuffled,
      invitedIds: ["pranav", "maya", "jordan"],
      organizerId: "pranav",
      preferences: [pref("pranav", ["B", "D"]), pref("maya", ["B", "D"]), pref("jordan", [])],
    });
    expect(r.slotId).toBe("B");
    expect(r.tieBrokenBy).toBe("earliest");
  });

  it("uses fairness priority between the organizer and earliest tie breaks", () => {
    const r = pickTime({
      slots,
      invitedIds: ["pranav", "maya", "jordan"],
      organizerId: "pranav",
      priorityIds: ["jordan"],
      preferences: [pref("pranav", ["B", "D"]), pref("maya", ["B"]), pref("jordan", ["D"])],
    });
    expect(r.slotId).toBe("D");
    expect(r.tieBrokenBy).toBe("fairness");
  });

  it("treats any time as available for every slot", () => {
    const r = pickTime({
      slots,
      invitedIds: ["pranav", "maya"],
      organizerId: "pranav",
      preferences: [pref("pranav", [], { anyTime: true }), pref("maya", [], { anyTime: true })],
    });
    expect(r.status).toBe("unanimous");
    expect(r.slotId).toBe("A");
    expect(r.ranking.every((s) => s.count === 2)).toBe(true);
  });

  it("asks the organizer for new options when fewer than half can make the best slot", () => {
    const r = pickTime({
      slots,
      invitedIds: ["pranav", "maya", "jordan", "sam", "priya"],
      organizerId: "pranav",
      preferences: [
        pref("pranav", ["A"]),
        pref("maya", ["A"]),
        pref("jordan", ["B"]),
        pref("sam", ["C"]),
        pref("priya", ["D"]),
      ],
    });
    expect(r.status).toBe("no_overlap");
    expect(r.slotId).toBeUndefined();
    expect(r.bestSlotId).toBe("A");
    expect(r.reason).toContain("ask the organizer for new time options");
  });

  it("exactly half is still enough", () => {
    const r = pickTime({
      slots,
      invitedIds: ["pranav", "maya", "jordan", "sam"],
      organizerId: "pranav",
      preferences: [pref("pranav", ["A"]), pref("maya", ["A"]), pref("jordan", ["B"]), pref("sam", ["C"])],
    });
    expect(r.status).toBe("majority");
    expect(r.slotId).toBe("A");
  });

  it("reports no overlap when nobody can make any slot", () => {
    const r = pickTime({
      slots,
      invitedIds: ["pranav", "maya"],
      organizerId: "pranav",
      preferences: [pref("pranav", []), pref("maya", ["Z"])],
    });
    expect(r.status).toBe("no_overlap");
    expect(r.reason).toContain("ask the organizer for new time options");
  });

  it("reports no responses", () => {
    const r = pickTime({ slots, invitedIds: ["pranav", "maya"], organizerId: "pranav", preferences: [] });
    expect(r.status).toBe("no_responses");
    expect(r.noReply).toEqual(["pranav", "maya"]);
    expect(r.slotId).toBeUndefined();
  });

  it("counts only the latest answer per person and ignores people not invited", () => {
    const r = pickTime({
      slots,
      invitedIds: ["pranav", "maya"],
      organizerId: "pranav",
      preferences: [
        pref("maya", ["A"], { updatedAt: "2026-10-17T12:00:00Z" }),
        pref("pranav", ["B"]),
        pref("maya", ["B"], { updatedAt: "2026-10-17T13:00:00Z" }),
        pref("stranger", ["A"]),
      ],
    });
    expect(r.status).toBe("unanimous");
    expect(r.slotId).toBe("B");
    expect(r.ranking.find((s) => s.slotId === "A")!.count).toBe(0);
  });
});
