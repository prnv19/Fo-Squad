import type { RestaurantOption, Vote } from "../types.js";
import { displayName, joinNames, latestPerPerson, type NameMap } from "./text.js";

export interface TallyVotesInput {
  options: readonly RestaurantOption[];
  votes: readonly Vote[];
  /** Everyone allowed to vote, opted-out people already removed. */
  voterIds: readonly string[];
  organizerId: string;
  /** Fairness memory, oldest concession first. */
  priorityIds?: readonly string[];
  names?: NameMap;
}

export interface OptionRank {
  optionId: string;
  name: string;
  votes: number;
  voterIds: string[];
}

export interface InvalidVote {
  personId: string;
  restaurantId: string;
  problem: "unknown_option" | "not_a_voter";
}

export interface TallyVotesResult {
  winnerId?: string;
  /** Every option, best first, same tie breaks. Next one down is the runner up if the winner is full. */
  ranking: OptionRank[];
  noVote: string[];
  invalidVotes: InvalidVote[];
  tieBrokenBy?: "organizer" | "fairness" | "list_order";
  reason: string;
  /** Voters whose pick lost. Feed to fairness memory. */
  gaveUp: string[];
}

export function tallyVotes(input: TallyVotesInput): TallyVotesResult {
  const { options, organizerId, names } = input;
  const voters = new Set(input.voterIds);
  const optionIds = new Set(options.map((o) => o.id));

  const invalidVotes: InvalidVote[] = [];
  const valid: Vote[] = [];
  // Latest vote per person decides, even if that latest vote turns out to be invalid,
  // so Fo re-asks rather than silently counting an older choice.
  for (const v of latestPerPerson(input.votes)) {
    if (!voters.has(v.personId)) {
      invalidVotes.push({ personId: v.personId, restaurantId: v.restaurantId, problem: "not_a_voter" });
    } else if (!optionIds.has(v.restaurantId)) {
      invalidVotes.push({ personId: v.personId, restaurantId: v.restaurantId, problem: "unknown_option" });
    } else {
      valid.push(v);
    }
  }

  const voted = new Set(valid.map((v) => v.personId));
  const noVote = input.voterIds.filter((id) => !voted.has(id));
  const organizerChoice = valid.find((v) => v.personId === organizerId)?.restaurantId;

  // Lower = better: the option backed by the person who has waited longest.
  const priority = (input.priorityIds ?? []).filter((id) => voters.has(id) && id !== organizerId);
  const priorityRank = (voterIds: readonly string[]): number => {
    const idx = priority.findIndex((id) => voterIds.includes(id));
    return idx === -1 ? Number.POSITIVE_INFINITY : idx;
  };

  const listed = options.map((o, index) => {
    const voterIds = input.voterIds.filter((id) => valid.some((v) => v.personId === id && v.restaurantId === o.id));
    return { optionId: o.id, name: o.name, votes: voterIds.length, voterIds, index };
  });
  const cmpPriority = (a: (typeof listed)[number], b: (typeof listed)[number]): number => {
    const pa = priorityRank(a.voterIds);
    const pb = priorityRank(b.voterIds);
    return pa === pb ? 0 : pa < pb ? -1 : 1;
  };
  const sorted = [...listed].sort(
    (a, b) =>
      b.votes - a.votes ||
      Number(b.optionId === organizerChoice) - Number(a.optionId === organizerChoice) ||
      cmpPriority(a, b) ||
      a.index - b.index,
  );
  const ranking: OptionRank[] = sorted.map(({ index: _index, ...rest }) => rest);

  const best = sorted[0];
  if (!best || best.votes === 0) {
    return {
      ranking,
      noVote,
      invalidVotes,
      reason: options.length === 0 ? "There are no options to vote on" : "No votes yet",
      gaveUp: [],
    };
  }

  const second = sorted[1];
  let tieBrokenBy: TallyVotesResult["tieBrokenBy"];
  if (second && second.votes === best.votes) {
    if ((best.optionId === organizerChoice) !== (second.optionId === organizerChoice)) tieBrokenBy = "organizer";
    else if (cmpPriority(best, second) !== 0) tieBrokenBy = "fairness";
    else tieBrokenBy = "list_order";
  }

  let reason: string;
  if (!tieBrokenBy) {
    reason = `${best.name} won ${best.votes} to ${second?.votes ?? 0}`;
  } else {
    const tiedNames = sorted.filter((o) => o.votes === best.votes).map((o) => o.name);
    const tie = `${joinNames(tiedNames)} tied at ${best.votes}`;
    if (tieBrokenBy === "organizer") {
      reason = `${tie}; ${best.name} wins as the organizer's choice`;
    } else if (tieBrokenBy === "fairness") {
      const who = priority.find((id) => best.voterIds.includes(id))!;
      const name = displayName(who, names);
      reason = `${tie}; ${best.name} wins because ${name} gave up a pick last time`;
    } else {
      reason = `${tie}; ${best.name} wins as the first option listed`;
    }
  }

  const gaveUp = valid.filter((v) => v.restaurantId !== best.optionId).map((v) => v.personId);
  return { winnerId: best.optionId, ranking, noVote, invalidVotes, ...(tieBrokenBy ? { tieBrokenBy } : {}), reason, gaveUp };
}
