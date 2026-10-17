import type { Preferences, TimeSlot } from "../types.js";
import { displayName, joinNames, latestPerPerson, type NameMap } from "./text.js";

export type PickTimeStatus = "unanimous" | "majority" | "no_overlap" | "no_responses";

export interface SlotRank {
  slotId: string;
  label: string;
  count: number;
  organizerFree: boolean;
  /** How many fairness-priority people are free. Tie break after the organizer. */
  priorityFree: number;
}

export interface PickTimeInput {
  slots: readonly TimeSlot[];
  preferences: readonly Preferences[];
  /** Everyone who should answer, opted-out people already removed. */
  invitedIds: readonly string[];
  organizerId: string;
  /** Fairness memory, oldest concession first. */
  priorityIds?: readonly string[];
  names?: NameMap;
}

export interface PickTimeResult {
  status: PickTimeStatus;
  /** Set only for unanimous and majority. */
  slotId?: string;
  /** For no_overlap: the slot that excludes the fewest people, to ask about shifting. */
  bestSlotId?: string;
  canMake: string[];
  cantMake: string[];
  noReply: string[];
  ranking: SlotRank[];
  /** Respondents who can make the slot, plus their plus-ones. */
  partySize: number;
  tieBrokenBy?: "organizer" | "fairness" | "earliest";
  reason: string;
}

const ASK_ORGANIZER = "ask the organizer for new time options";

function canAttend(pref: Preferences, slotId: string): boolean {
  return pref.anyTime || pref.slotIds.includes(slotId);
}

export function pickTime(input: PickTimeInput): PickTimeResult {
  const { slots, invitedIds, organizerId, names } = input;
  const invited = new Set(invitedIds);
  const priority = (input.priorityIds ?? []).filter((id) => invited.has(id));

  const respondents = latestPerPerson(input.preferences.filter((p) => invited.has(p.personId)));
  const answered = new Set(respondents.map((p) => p.personId));
  const noReply = invitedIds.filter((id) => !answered.has(id));
  const organizerPref = respondents.find((p) => p.personId === organizerId);

  const slotOrder = new Map(slots.map((s, i) => [s.id, i]));
  const ranking: SlotRank[] = slots.map((slot) => {
    const free = respondents.filter((p) => canAttend(p, slot.id));
    const freeIds = new Set(free.map((p) => p.personId));
    return {
      slotId: slot.id,
      label: slot.label,
      count: free.length,
      organizerFree: organizerPref ? canAttend(organizerPref, slot.id) : false,
      priorityFree: priority.filter((id) => freeIds.has(id)).length,
    };
  });

  const startsAt = (slotId: string): number => {
    const slot = slots[slotOrder.get(slotId) ?? -1];
    const t = slot ? Date.parse(slot.startsAt) : NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  ranking.sort(
    (a, b) =>
      b.count - a.count ||
      Number(b.organizerFree) - Number(a.organizerFree) ||
      b.priorityFree - a.priorityFree ||
      startsAt(a.slotId) - startsAt(b.slotId) ||
      (slotOrder.get(a.slotId) ?? 0) - (slotOrder.get(b.slotId) ?? 0),
  );

  const empty = { canMake: [], cantMake: [], noReply, ranking, partySize: 0 };

  if (respondents.length === 0) {
    return { status: "no_responses", ...empty, reason: "Nobody has answered yet" };
  }

  const best = ranking[0];
  if (!best || best.count === 0) {
    return {
      status: "no_overlap",
      ...empty,
      reason: `No time works for anyone who answered, so ${ASK_ORGANIZER}`,
    };
  }

  const canMake = respondents.filter((p) => canAttend(p, best.slotId)).map((p) => p.personId);
  const canMakeSet = new Set(canMake);
  const cantMake = respondents.map((p) => p.personId).filter((id) => !canMakeSet.has(id));
  const partySize = respondents
    .filter((p) => canMakeSet.has(p.personId))
    .reduce((sum, p) => sum + 1 + Math.max(0, p.plusOnes || 0), 0);

  if (best.count * 2 < respondents.length) {
    return {
      status: "no_overlap",
      bestSlotId: best.slotId,
      canMake,
      cantMake,
      noReply,
      ranking,
      partySize,
      reason: `The best time, ${best.label}, only works for ${best.count} of ${respondents.length}, so ${ASK_ORGANIZER}`,
    };
  }

  const runnerUp = ranking[1];
  let tieBrokenBy: PickTimeResult["tieBrokenBy"];
  if (runnerUp && runnerUp.count === best.count) {
    if (best.organizerFree !== runnerUp.organizerFree) tieBrokenBy = "organizer";
    else if (best.priorityFree !== runnerUp.priorityFree) tieBrokenBy = "fairness";
    else tieBrokenBy = "earliest";
  }

  const unanimous = cantMake.length === 0;
  const everyone = noReply.length === 0 ? "everyone" : "everyone who replied";
  const cantNames = cantMake.map((id) => displayName(id, names));
  const reason = unanimous
    ? `${best.label} works for ${everyone}`
    : `${best.label} works for ${best.count} of ${respondents.length}; ${joinNames(cantNames)} can't make it`;

  return {
    status: unanimous ? "unanimous" : "majority",
    slotId: best.slotId,
    canMake,
    cantMake,
    noReply,
    ranking,
    partySize,
    ...(tieBrokenBy ? { tieBrokenBy } : {}),
    reason,
  };
}
