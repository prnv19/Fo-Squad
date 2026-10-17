import { describe, expect, it } from "vitest";
import { SimClock } from "./clock.js";
import { SandboxBus } from "./events.js";

const T0 = new Date("2026-10-21T16:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("SimClock", () => {
  it("runs items in time order, same-time items in scheduling order, and jumps the clock to each", async () => {
    const clock = new SimClock(T0);
    const seen: string[] = [];
    clock.schedule(at(30), () => seen.push(`c@${clock.nowIso()}`), "c");
    clock.schedule(at(10), () => seen.push(`a@${clock.nowIso()}`), "a");
    clock.schedule(at(10), () => seen.push(`b@${clock.nowIso()}`), "b");
    expect(clock.pending().map((p) => p.description)).toEqual(["a", "b", "c"]);

    while (await clock.advanceToNext());
    expect(seen).toEqual([`a@${at(10).toISOString()}`, `b@${at(10).toISOString()}`, `c@${at(30).toISOString()}`]);
    expect(clock.hasPending()).toBe(false);
    expect(await clock.advanceToNext()).toBe(false);
  });

  it("items scheduled while running join the queue in order; the past is clamped to now", async () => {
    const clock = new SimClock(T0);
    const seen: string[] = [];
    clock.schedule(at(5), () => {
      seen.push("first");
      clock.schedule(at(1), () => seen.push(`late@${clock.nowIso()}`), "in the past");
      clock.schedule(at(6), () => seen.push("second"), "second");
    }, "first");
    clock.schedule(at(20), () => seen.push("third"), "third");
    while (await clock.advanceToNext());
    expect(seen).toEqual(["first", `late@${at(5).toISOString()}`, "second", "third"]);
  });

  it("emits scheduled events (unless announce: false) and a clock event only when time moves", async () => {
    const bus = new SandboxBus();
    const clock = new SimClock(T0, { bus });
    clock.schedule(at(0), () => {}, "now-ish", { announce: false });
    clock.schedule(at(90), () => {}, "deadline");
    while (await clock.advanceToNext());
    expect(bus.history).toEqual([
      { type: "scheduled", at: T0.toISOString(), runAt: at(90).toISOString(), description: "deadline" },
      { type: "clock", at: at(90).toISOString() },
    ]);
  });

  it("cancels, and paces through onAdvance with the size of each jump", async () => {
    const jumps: number[] = [];
    const clock = new SimClock(T0, { onAdvance: (from, to) => void jumps.push(to - from) });
    const id = clock.schedule(at(10), () => {}, "cancel me");
    clock.schedule(at(20), () => {}, "keep");
    expect(clock.cancel(id)).toBe(true);
    while (await clock.advanceToNext());
    expect(jumps).toEqual([20 * 60_000]);
  });
});
