import { describe, expect, it } from "vitest";
import { billQuestionAt, dayOfReminderAt, isTimeZone, localClockLabel } from "./zone.js";

describe("dayOfReminderAt", () => {
  it("is 4 hours before a dinner", () => {
    // 7:30pm Denver.
    expect(dayOfReminderAt(new Date("2026-10-25T01:30:00Z"), "America/Denver").toISOString()).toBe("2026-10-24T21:30:00.000Z");
  });

  it("waits until 9am local for a lunch or breakfast, but stays before the start", () => {
    // Noon Denver: 8am would be too early, so 9am.
    expect(dayOfReminderAt(new Date("2026-10-19T18:00:00Z"), "America/Denver").toISOString()).toBe("2026-10-19T15:00:00.000Z");
    // 9am Denver: the reminder goes out at the start, never earlier than 9am.
    expect(dayOfReminderAt(new Date("2026-10-19T15:00:00Z"), "America/Denver").toISOString()).toBe("2026-10-19T15:00:00.000Z");
  });

  it("uses the local day across a DST change", () => {
    // Sun 1 Nov 2026, 11am Los Angeles (PST, UTC-8): 9am local is 17:00Z.
    expect(dayOfReminderAt(new Date("2026-11-01T19:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });
});

describe("helpers", () => {
  it("puts the bill question 2 hours after the start", () => {
    expect(billQuestionAt(new Date("2026-10-19T18:00:00Z")).toISOString()).toBe("2026-10-19T20:00:00.000Z");
  });

  it("labels local clock times and validates zones", () => {
    expect(localClockLabel(new Date("2026-10-19T15:00:00Z"), "America/Denver")).toBe("9:00am");
    expect(isTimeZone("America/Denver")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});
