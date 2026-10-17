import { describe, expect, it } from "vitest";
import { STAGES, type Stage } from "../types.js";
import { FoError } from "./errors.js";
import { createEvent } from "./factory.js";
import { assertStage, canTransition, stageNumber, transition } from "./stage.js";

const T0 = "2026-10-17T18:00:00.000Z";
const T1 = "2026-10-17T19:00:00.000Z";

function eventAt(stage: Stage) {
  const e = createEvent(
    {
      title: "Dinner",
      organizer: { name: "Pranav", phone: "5550001111" },
      friends: [{ name: "Maya", phone: "5551234567" }],
      timeSlots: [],
    },
    { now: T0, id: "evt" },
  );
  return { ...e, stage };
}

const LEGAL: [Stage, Stage][] = [
  ["planning", "voting"],
  ["planning", "booked"],
  ["voting", "booked"],
  ["voting", "planning"],
  ["booked", "planning"],
  ["planning", "claiming"],
  ["voting", "claiming"],
  ["booked", "claiming"],
  ["claiming", "paying"],
  ["paying", "claiming"],
  ["paying", "settled"],
];

describe("canTransition", () => {
  it("allows exactly the legal moves (plus staying put)", () => {
    for (const from of STAGES) {
      for (const to of STAGES) {
        const expected = from === to || LEGAL.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });
});

describe("transition", () => {
  it.each(LEGAL)("%s -> %s returns a new event with updatedAt bumped", (from, to) => {
    const e = eventAt(from);
    const next = transition(e, to, new Date(T1));
    expect(next).not.toBe(e);
    expect(next.stage).toBe(to);
    expect(next.updatedAt).toBe(T1);
    expect(e.stage).toBe(from);
  });

  it.each<[Stage, Stage]>([
    ["planning", "paying"],
    ["planning", "settled"],
    ["booked", "voting"],
    ["claiming", "planning"],
    ["claiming", "booked"],
    ["claiming", "settled"],
    ["paying", "booked"],
  ])("%s -> %s throws WRONG_STAGE", (from, to) => {
    expect(() => transition(eventAt(from), to, T1)).toThrow(FoError);
    expect(() => transition(eventAt(from), to, T1)).toThrow(expect.objectContaining({ code: "WRONG_STAGE" }));
  });

  it("is a no-op for the same stage", () => {
    for (const stage of STAGES) {
      const e = eventAt(stage);
      const next = transition(e, stage, T1);
      expect(next).toBe(e);
      expect(next.updatedAt).toBe(T0);
    }
  });

  it("never leaves settled", () => {
    for (const to of STAGES.filter((s) => s !== "settled")) {
      expect(() => transition(eventAt("settled"), to, T1)).toThrow(/already settled/);
    }
  });
});

describe("assertStage", () => {
  it("passes for allowed stages", () => {
    expect(() => assertStage(eventAt("voting"), ["voting"], "record a vote")).not.toThrow();
  });

  it("throws a relayable message", () => {
    expect(() => assertStage(eventAt("booked"), ["voting"], "record a vote")).toThrow(
      "Can't record a vote: this dinner is already booked.",
    );
  });
});

describe("stageNumber", () => {
  it("numbers stages 1 to 6", () => {
    expect(STAGES.map(stageNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
