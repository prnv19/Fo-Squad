// Edge-case suite: short, targeted sandbox runs. Each case seeds a dinner
// straight to the right stage through the service (free, no Claude), then
// delivers the tricky texts and lets Claude-as-Fo handle them. Deterministic
// checks grade the outcome; the transcript is kept for human review.

import type { FoSquadService } from "../../service.js";
import type { DinnerEvent } from "../../types.js";
import type { SandboxEvent } from "../events.js";

export type EdgeArea = "planning" | "voting" | "booking" | "claiming" | "payment" | "messaging" | "security";

export interface SeedPerson {
  id: string; // "pranav", "maya", ...
  name: string;
  phone: string; // fake E.164, +1303555xxxx
  isOrganizer: boolean;
}

export interface SeedContext {
  /** Service on the simulated clock with a fresh in-memory store. */
  service: FoSquadService;
  /** Simulated now. Seeds should build times relative to this. */
  now: () => Date;
  /** Move the simulated clock forward (e.g. past a deadline) while seeding. */
  advanceMinutes: (minutes: number) => void;
  /** Default cast: Pranav (organizer), Maya, Jordan, Sam, Priya, Alex. */
  people: SeedPerson[];
  timeZone: string;
}

/** A scripted text one persona sends, optionally after a delay or in reply to Fo. */
export interface InboundStep {
  from: string; // person id
  text: string;
  /** Simulated minutes after the previous step (or after seeding). Default 1. */
  afterMinutes?: number;
}

/** A one-shot scripted reply: when Fo texts `to` and the text matches, reply. */
export interface ReplyRule {
  to: string; // person id Fo is texting
  when: RegExp;
  reply: string;
  afterMinutes?: number;
}

/** Overrides for stubbed real-world actions in this case. */
export interface StubOverrides {
  /** Return text Fo sees from the restaurant call, e.g. "Fully booked at 7:30pm." */
  callRestaurant?: (restaurant: string, request: string) => string;
  /** Replace the dummy receipt read by read_receipt_photo. Plain text lines. */
  receiptText?: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result: unknown;
  /** Person id whose text started the coordinator run, or "timer". */
  triggeredBy: string;
}

export interface CaseHistory {
  events: SandboxEvent[];
  toolCalls: ToolCallRecord[];
  /** Texts Fo sent to a person, in order. */
  textsTo(personId: string): string[];
  /** All texts Fo sent, with recipient. */
  allTexts(): { to: string; text: string }[];
  /** State of the seeded dinner when the case ended. */
  finalEvent: DinnerEvent;
  stubbed: { action: string; detail: string }[];
  /** schedule_action calls that landed within 5 simulated minutes of a timer already pending (each costs a run). */
  duplicateTimers?: { description: string; runAt: string; duplicateOf: string }[];
  /** by_phone values that didn't match whoever started the run (see the engine's audit). */
  auditFlags?: string[];
}

export interface Check {
  description: string;
  /** true = pass; a string = fail with that explanation. */
  test: (h: CaseHistory) => true | string;
}

export interface EdgeCase {
  id: string; // kebab-case, unique
  title: string;
  area: EdgeArea;
  /** Which row of the plan's edge-case tables this covers. */
  planRef: string;
  /** Bold (must-work-before-demo) in the plan. */
  critical: boolean;
  seed: (ctx: SeedContext) => Promise<{ eventId: string }>;
  inbound: InboundStep[];
  replies?: ReplyRule[];
  stubs?: StubOverrides;
  /** Cap on coordinator runs for this case. Default 8. */
  maxRuns?: number;
  checks: Check[];
}
