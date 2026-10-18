import { STAGES, type DinnerEvent, type Stage } from "../types.js";
import { FoError } from "./errors.js";
import { toIso } from "./util.js";

/**
 * Forward moves plus one loop back: paying -> claiming for disputes.
 * Planning, voting and booked can all jump to claiming because a receipt can
 * arrive on a split-only night that never went through planning. Booked and
 * claiming can jump to settled when the organizer covers the whole bill.
 */
export const TRANSITIONS: Readonly<Record<Stage, readonly Stage[]>> = {
  planning: ["voting", "booked", "claiming"],
  voting: ["planning", "booked", "claiming"],
  booked: ["planning", "claiming", "settled"],
  claiming: ["paying", "settled"],
  paying: ["claiming", "settled"],
  settled: [],
};

const DESCRIPTIONS: Record<Stage, string> = {
  planning: "still collecting times and preferences",
  voting: "in the restaurant vote",
  booked: "already booked",
  claiming: "collecting who had what from the receipt",
  paying: "waiting on payments",
  settled: "already settled",
};

export function describeStage(stage: Stage): string {
  return DESCRIPTIONS[stage];
}

/** 1-based position in the six stages (planning = 1, settled = 6). */
export function stageNumber(stage: Stage): number {
  return STAGES.indexOf(stage) + 1;
}

/** True for legal moves and for staying put, which is always a harmless no-op. */
export function canTransition(from: Stage, to: Stage): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/**
 * Returns a copy of the event in stage `to`. Same-stage calls return the
 * event untouched so a repeated tool call doesn't bump updatedAt.
 */
export function transition(event: DinnerEvent, to: Stage, now: Date | string): DinnerEvent {
  if (event.stage === to) return event;
  if (!canTransition(event.stage, to)) {
    throw new FoError(
      "WRONG_STAGE",
      `Can't move "${event.title}" to ${to}: it's ${describeStage(event.stage)}.`,
    );
  }
  return { ...event, stage: to, updatedAt: toIso(now) };
}

/**
 * Guards a tool call, e.g. assertStage(event, ["voting"], "record a vote")
 * throws "Can't record a vote: this dinner is already booked."
 */
export function assertStage(event: DinnerEvent, allowed: readonly Stage[], action: string): void {
  if (!allowed.includes(event.stage)) {
    throw new FoError("WRONG_STAGE", `Can't ${action}: this dinner is ${describeStage(event.stage)}.`);
  }
}
