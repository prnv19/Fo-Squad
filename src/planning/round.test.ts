import { describe, expect, it } from "vitest";
import { isLateReply, roundStatus } from "./round.js";

const deadline = "2026-10-17T14:00:00Z";
const invitedIds = ["pranav", "maya", "jordan", "sam"];

describe("roundStatus", () => {
  it("lists pending people and who still needs their one nudge before the deadline", () => {
    const r = roundStatus({
      invitedIds,
      answeredIds: ["pranav", "maya"],
      nudgedIds: ["jordan"],
      deadline,
      now: "2026-10-17T13:00:00Z",
    });
    expect(r).toEqual({
      pending: ["jordan", "sam"],
      toNudge: ["sam"],
      deadlinePassed: false,
      readyToDecide: false,
      locked: false,
    });
  });

  it("is ready as soon as everyone answers, without locking", () => {
    const r = roundStatus({ invitedIds, answeredIds: invitedIds, nudgedIds: [], deadline, now: "2026-10-17T12:30:00Z" });
    expect(r.readyToDecide).toBe(true);
    expect(r.locked).toBe(false);
    expect(r.toNudge).toEqual([]);
  });

  it("decides with whoever answered once the deadline passes, and stops nudging", () => {
    const r = roundStatus({ invitedIds, answeredIds: ["maya"], nudgedIds: [], deadline, now: deadline });
    expect(r.deadlinePassed).toBe(true);
    expect(r.readyToDecide).toBe(true);
    expect(r.locked).toBe(true);
    expect(r.pending).toEqual(["pranav", "jordan", "sam"]);
    expect(r.toNudge).toEqual([]);
  });

  it("never passes without a deadline", () => {
    const r = roundStatus({ invitedIds, answeredIds: [], nudgedIds: [], now: "2030-01-01T00:00:00Z" });
    expect(r.deadlinePassed).toBe(false);
    expect(r.toNudge).toEqual(invitedIds);
  });
});

describe("isLateReply", () => {
  it("flags replies at or after the deadline", () => {
    expect(isLateReply(deadline, "2026-10-17T13:59:59Z")).toBe(false);
    expect(isLateReply(deadline, "2026-10-17T14:00:00Z")).toBe(true);
    expect(isLateReply(deadline, "2026-10-17T15:00:00Z")).toBe(true);
    expect(isLateReply(undefined, "2026-10-17T15:00:00Z")).toBe(false);
  });
});
