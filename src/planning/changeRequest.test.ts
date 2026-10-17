import { describe, expect, it } from "vitest";
import { evaluateChangeRequest, type ChangeRequestInput } from "./changeRequest.js";

const base = { objectorCount: 1, groupSize: 6 } as const;

describe("evaluateChangeRequest", () => {
  const cases: [string, ChangeRequestInput, string][] = [
    // Reason table, before booking.
    ["hard constraint, locked", { ...base, reason: "hard_constraint", firmness: "locked", timing: "before_booking" }, "notify_organizer_privately"],
    ["hard constraint, suggested", { ...base, reason: "hard_constraint", firmness: "suggested", timing: "before_booking" }, "add_alternative_and_notify"],
    ["preference, locked", { ...base, reason: "preference", firmness: "locked", timing: "before_booking" }, "acknowledge_and_save"],
    ["preference, locked, even if everyone objects", { reason: "preference", firmness: "locked", timing: "before_booking", objectorCount: 5, groupSize: 6 }, "acknowledge_and_save"],
    ["preference, suggested, one objection", { ...base, reason: "preference", firmness: "suggested", timing: "before_booking" }, "keep_pick"],
    ["preference, suggested, under half", { reason: "preference", firmness: "suggested", timing: "before_booking", objectorCount: 2, groupSize: 6 }, "keep_pick"],
    ["preference, suggested, exactly half", { reason: "preference", firmness: "suggested", timing: "before_booking", objectorCount: 3, groupSize: 6 }, "run_quick_vote"],
    ["preference, suggested, majority", { reason: "preference", firmness: "suggested", timing: "before_booking", objectorCount: 4, groupSize: 5 }, "run_quick_vote"],
    ["preference, suggested, one of two is still one objection", { reason: "preference", firmness: "suggested", timing: "before_booking", objectorCount: 1, groupSize: 2 }, "keep_pick"],
    // Timing table.
    ["after booking, hard constraint, locked", { ...base, reason: "hard_constraint", firmness: "locked", timing: "after_booking" }, "check_new_place_and_ask_organizer"],
    ["after booking, hard constraint, suggested", { ...base, reason: "hard_constraint", firmness: "suggested", timing: "after_booking" }, "check_new_place_and_ask_organizer"],
    ["after booking, preference, suggested, half the group", { reason: "preference", firmness: "suggested", timing: "after_booking", objectorCount: 3, groupSize: 6 }, "check_new_place_and_ask_organizer"],
    ["after booking, preference, suggested, one objection", { ...base, reason: "preference", firmness: "suggested", timing: "after_booking" }, "keep_pick"],
    ["after booking, preference, locked", { ...base, reason: "preference", firmness: "locked", timing: "after_booking" }, "acknowledge_and_save"],
    ["hours before, hard constraint, locked", { ...base, reason: "hard_constraint", firmness: "locked", timing: "hours_before" }, "notify_organizer_privately"],
    ["hours before, hard constraint, suggested", { ...base, reason: "hard_constraint", firmness: "suggested", timing: "hours_before" }, "notify_organizer_privately"],
    ["hours before, preference, locked", { ...base, reason: "preference", firmness: "locked", timing: "hours_before" }, "decline_politely"],
    ["hours before, preference, suggested, whole group", { reason: "preference", firmness: "suggested", timing: "hours_before", objectorCount: 6, groupSize: 6 }, "decline_politely"],
  ];

  it.each(cases)("%s", (_label, input, action) => {
    const r = evaluateChangeRequest(input);
    expect(r.action).toBe(action);
    expect(r.changesPlan).toBe(false);
    expect(r.explanation.length).toBeGreaterThan(0);
  });

  it("always sends hard constraints to the organizer", () => {
    for (const firmness of ["locked", "suggested"] as const) {
      for (const timing of ["before_booking", "after_booking", "hours_before"] as const) {
        const r = evaluateChangeRequest({ ...base, reason: "hard_constraint", firmness, timing });
        expect(r.notifyOrganizer).toBe(true);
      }
    }
  });

  it("saves passed-over preferences for next time", () => {
    expect(evaluateChangeRequest({ ...base, reason: "preference", firmness: "locked", timing: "before_booking" }).saveForNextTime).toBe(true);
    expect(evaluateChangeRequest({ ...base, reason: "preference", firmness: "suggested", timing: "before_booking" }).saveForNextTime).toBe(true);
    expect(evaluateChangeRequest({ ...base, reason: "preference", firmness: "suggested", timing: "hours_before" }).saveForNextTime).toBe(true);
  });
});
