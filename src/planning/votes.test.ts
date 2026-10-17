import { describe, expect, it } from "vitest";
import type { RestaurantOption, Vote } from "../types.js";
import { tallyVotes } from "./votes.js";

const options: RestaurantOption[] = [
  { id: "1", name: "Luigi's" },
  { id: "2", name: "Osteria Marco" },
  { id: "3", name: "Tavola" },
];
const voterIds = ["pranav", "maya", "jordan", "sam", "priya", "alex"];

function votes(map: Record<string, string>): Vote[] {
  return Object.entries(map).map(([personId, restaurantId]) => ({
    personId,
    restaurantId,
    updatedAt: "2026-10-17T12:00:00Z",
  }));
}

describe("tallyVotes", () => {
  it("most votes wins: Luigi's won 4 to 2", () => {
    const r = tallyVotes({
      options,
      voterIds,
      organizerId: "pranav",
      votes: votes({ pranav: "1", maya: "1", jordan: "1", sam: "2", priya: "2", alex: "1" }),
    });
    expect(r.winnerId).toBe("1");
    expect(r.reason).toBe("Luigi's won 4 to 2");
    expect(r.ranking.map((o) => [o.optionId, o.votes])).toEqual([
      ["1", 4],
      ["2", 2],
      ["3", 0],
    ]);
    expect(r.ranking[1]!.voterIds).toEqual(["sam", "priya"]);
    expect(r.gaveUp).toEqual(["sam", "priya"]);
    expect(r.noVote).toEqual([]);
    expect(r.tieBrokenBy).toBeUndefined();
  });

  it("gives ties to the organizer's vote", () => {
    const r = tallyVotes({
      options,
      voterIds,
      organizerId: "pranav",
      votes: votes({ pranav: "2", maya: "1", jordan: "1", sam: "2" }),
    });
    expect(r.winnerId).toBe("2");
    expect(r.tieBrokenBy).toBe("organizer");
    expect(r.reason).toBe("Osteria Marco and Luigi's tied at 2; Osteria Marco wins as the organizer's choice");
    expect(r.noVote).toEqual(["priya", "alex"]);
  });

  it("gives ties to a fairness priority voter when the organizer didn't vote for a tied option", () => {
    const r = tallyVotes({
      options,
      voterIds,
      organizerId: "pranav",
      priorityIds: ["sam", "maya"],
      names: { sam: "Sam" },
      votes: votes({ pranav: "3", maya: "1", jordan: "1", sam: "2", priya: "2" }),
    });
    expect(r.winnerId).toBe("2");
    expect(r.tieBrokenBy).toBe("fairness");
    expect(r.reason).toContain("because Sam gave up a pick last time");
    expect(r.ranking.map((o) => o.optionId)).toEqual(["2", "1", "3"]);
  });

  it("falls back to list order", () => {
    const r = tallyVotes({
      options,
      voterIds,
      organizerId: "pranav",
      votes: votes({ maya: "3", jordan: "2" }),
    });
    expect(r.winnerId).toBe("2");
    expect(r.tieBrokenBy).toBe("list_order");
    expect(r.ranking.map((o) => o.optionId)).toEqual(["2", "3", "1"]);
  });

  it("orders runner ups with the same tie breaks so Fo can try the next one if the winner is full", () => {
    const r = tallyVotes({
      options: [...options, { id: "4", name: "Bella" }],
      voterIds,
      organizerId: "pranav",
      votes: votes({ pranav: "3", maya: "1", jordan: "1", sam: "1", priya: "3", alex: "4" }),
    });
    expect(r.ranking.map((o) => o.optionId)).toEqual(["1", "3", "4", "2"]);
  });

  it("ignores votes for unknown options and from non-voters, using each person's latest vote", () => {
    const r = tallyVotes({
      options,
      voterIds: ["pranav", "maya", "jordan"],
      organizerId: "pranav",
      votes: [
        { personId: "maya", restaurantId: "2", updatedAt: "2026-10-17T12:00:00Z" },
        { personId: "maya", restaurantId: "1", updatedAt: "2026-10-17T13:00:00Z" },
        { personId: "jordan", restaurantId: "9", updatedAt: "2026-10-17T12:00:00Z" },
        { personId: "stranger", restaurantId: "1", updatedAt: "2026-10-17T12:00:00Z" },
      ],
    });
    expect(r.winnerId).toBe("1");
    expect(r.reason).toBe("Luigi's won 1 to 0");
    expect(r.invalidVotes).toEqual([
      { personId: "jordan", restaurantId: "9", problem: "unknown_option" },
      { personId: "stranger", restaurantId: "1", problem: "not_a_voter" },
    ]);
    expect(r.noVote).toEqual(["pranav", "jordan"]);
  });

  it("has no winner without votes", () => {
    const r = tallyVotes({ options, voterIds, organizerId: "pranav", votes: [] });
    expect(r.winnerId).toBeUndefined();
    expect(r.reason).toBe("No votes yet");
    expect(r.noVote).toEqual(voterIds);
  });
});
