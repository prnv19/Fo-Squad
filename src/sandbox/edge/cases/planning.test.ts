import { describe, expect, it } from "vitest";
import type { CaseHistory, EdgeCase } from "../types.js";
import { cases } from "./planning.js";
import { HistoryBuilder, makeSeedContext } from "./seed-helpers.js";

const ORG = "+13035550100";

function byId(id: string): EdgeCase {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
}

async function seeded(id: string) {
  const c = byId(id);
  const { ctx, store } = makeSeedContext();
  const { eventId } = await c.seed(ctx);
  const event = (await store.get(eventId))!;
  const final = async () => (await store.get(eventId))!;
  return { c, ctx, store, eventId, event, final, service: ctx.service };
}

function failures(c: EdgeCase, h: CaseHistory): string[] {
  return c.checks.flatMap((check) => {
    const r = check.test(h);
    return r === true ? [] : [`${check.description}: ${r}`];
  });
}

function failed(c: EdgeCase, h: CaseHistory): string[] {
  return c.checks.filter((check) => check.test(h) !== true).map((check) => check.description);
}

describe("planning edge cases: shape", () => {
  it("has the 8 planning and voting cases with unique kebab-case ids", () => {
    const ids = cases.map((c) => c.id);
    expect(ids).toEqual([
      "no-overlap",
      "late-reply-after-deadline",
      "changed-answer",
      "any-time-works",
      "plus-one",
      "vote-tie",
      "locked-pick-preference-objection",
      "hard-constraint-after-pick",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cases) {
      expect(c.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(c.checks.length).toBeGreaterThan(0);
      expect(c.inbound.length).toBeGreaterThan(0);
      expect(c.maxRuns).toBeLessThanOrEqual(6);
      expect(["planning", "voting"]).toContain(c.area);
    }
    expect(cases.filter((c) => c.critical).map((c) => c.id)).toEqual(["no-overlap"]);
  });

  it.each(cases.map((c) => [c.id]))("%s: every check runs on an empty history", async (id) => {
    const { c, event } = await seeded(id);
    const h = new HistoryBuilder().build(event);
    for (const check of c.checks) {
      const r = check.test(h);
      expect(r === true || typeof r === "string").toBe(true);
    }
  });
});

describe("no-overlap", () => {
  const alex = "ugh this weekend is slammed, none of those work for me. sorry!!";

  it("seeds Planning with four answers that leave no slot for half the group", async () => {
    const { event, service, eventId } = await seeded("no-overlap");
    expect(event.stage).toBe("planning");
    expect(event.chosenSlotId).toBeUndefined();
    expect(event.preferences.map((p) => p.personId).sort()).toEqual(["jordan", "maya", "priya", "sam"]);
    await service.recordPreferences({ event_id: eventId, person: "alex", slot_ids: [] });
    const r = await service.pickTime({ event_id: eventId });
    expect(r.status).toBe("no_overlap");
  });

  it("passes when Fo asks the organizer for new times", async () => {
    const { c, service, eventId, final } = await seeded("no-overlap");
    const b = new HistoryBuilder().inbound("alex", alex);
    await b.run(service, "record_preferences", { event_id: eventId, person: "alex", slot_ids: [] }, "alex");
    await b.run(service, "pick_time", { event_id: eventId }, "alex");
    b.text("alex", "No worries Alex, thanks for letting me know!");
    b.text("pranav", "Saturday dinner: no time works for enough people. Want to offer some other times?");
    expect(failures(c, b.build(await final()))).toEqual([]);
  });

  it("fails when Fo announces a time without pick_time", async () => {
    const { c, service, eventId, final } = await seeded("no-overlap");
    const b = new HistoryBuilder().inbound("alex", alex);
    await b.run(service, "record_preferences", { event_id: eventId, person: "alex", slot_ids: [] }, "alex");
    b.text("maya", "Saturday dinner landed on Fri 7pm!");
    expect(failed(c, b.build(await final()))).toEqual([
      "pick_time ran and reported no_overlap",
      "Fo asked the organizer for new options after no_overlap",
      "No friend was told a time landed or asked to vote",
    ]);
  });
});

describe("late-reply-after-deadline", () => {
  it("seeds a booked dinner with no answer from Alex, which then can't be saved", async () => {
    const { event, service, eventId } = await seeded("late-reply-after-deadline");
    expect(event.stage).toBe("booked");
    expect(event.chosenSlotId).toBe("C");
    expect(event.booking?.restaurantName).toBe("Osteria Marco");
    expect(event.preferences.some((p) => p.personId === "alex")).toBe(false);
    await expect(service.recordPreferences({ event_id: eventId, person: "alex", slot_ids: ["C"] })).rejects.toMatchObject({
      code: "PLAN_LOCKED",
    });
  });

  it("passes when Fo tells Alex the plan kindly", async () => {
    const { c, service, eventId, final } = await seeded("late-reply-after-deadline");
    const b = new HistoryBuilder().inbound("alex", "hey sorry just seeing this!!");
    await b.run(service, "record_preferences", { event_id: eventId, person: "alex", slot_ids: ["C", "D"] }, "alex");
    b.text("alex", "Hey Alex! The plan for Saturday dinner is set: Osteria Marco, Sat 7:30pm. Hope you can make it!");
    expect(failures(c, b.build(await final()))).toEqual([]);
  });

  it("fails when Fo rebooks off Alex's text and never shares details", async () => {
    const { c, service, eventId, final } = await seeded("late-reply-after-deadline");
    const b = new HistoryBuilder().inbound("alex", "hey sorry just seeing this!!");
    await b.run(service, "confirm_booking", { event_id: eventId, by_phone: ORG, restaurant_name: "Osteria Marco", party_size: 6 }, "alex");
    b.text("alex", "Got it, thanks!");
    expect(failed(c, b.build(await final()))).toEqual([
      "Alex hears the plan is set, with the restaurant",
      "The plan is unchanged (Sat 7:30pm at Osteria Marco)",
    ]);
  });
});

describe("changed-answer", () => {
  it("seeds Planning waiting on Sam and Alex", async () => {
    const { event } = await seeded("changed-answer");
    expect(event.stage).toBe("planning");
    expect(event.preferences.map((p) => p.personId).sort()).toEqual(["jordan", "maya", "priya"]);
  });

  it("passes when the latest answer is saved", async () => {
    const { c, service, eventId, final } = await seeded("changed-answer");
    const b = new HistoryBuilder().inbound("sam", "B or C works for me!");
    await b.run(service, "record_preferences", { event_id: eventId, person: "sam", slot_ids: ["B", "C"] }, "sam");
    b.inbound("sam", "wait sorry scratch that");
    await b.run(service, "record_preferences", { event_id: eventId, person: "Sam", slot_ids: ["d"] }, "sam");
    await b.run(service, "pick_time", { event_id: eventId }, "sam");
    expect(failures(c, b.build(await final()))).toEqual([]);
  });

  it("fails when only the first answer is kept and the pick is forced", async () => {
    const { c, service, eventId, final } = await seeded("changed-answer");
    const b = new HistoryBuilder();
    await b.run(service, "record_preferences", { event_id: eventId, person: "sam", slot_ids: ["B", "C"] }, "sam");
    await b.run(service, "pick_time", { event_id: eventId, force: true }, "sam");
    expect(failed(c, b.build(await final()))).toEqual(c.checks.map((x) => x.description));
  });
});

describe("any-time-works", () => {
  it("seeds Planning waiting on Priya", async () => {
    const { event } = await seeded("any-time-works");
    expect(event.stage).toBe("planning");
    expect(event.preferences.some((p) => p.personId === "priya")).toBe(false);
  });

  it("passes with any_time and nothing invented", async () => {
    const { c, service, eventId, final } = await seeded("any-time-works");
    const b = new HistoryBuilder();
    await b.run(service, "record_preferences", { event_id: eventId, person: "priya", slot_ids: [], any_time: true }, "priya");
    expect(failures(c, b.build(await final()))).toEqual([]);
  });

  it("fails when Fo lists slots and invents a cuisine", async () => {
    const { c, service, eventId, final } = await seeded("any-time-works");
    const b = new HistoryBuilder();
    await b.run(
      service,
      "record_preferences",
      { event_id: eventId, person: "priya", slot_ids: ["A", "B", "C", "D"], cuisines: ["italian"] },
      "priya",
    );
    expect(failed(c, b.build(await final()))).toHaveLength(2);
  });
});

describe("plus-one", () => {
  it("seeds Planning waiting only on Jordan; his plus-one makes the party 7", async () => {
    const { event, service, eventId } = await seeded("plus-one");
    expect(event.stage).toBe("planning");
    expect(event.preferences).toHaveLength(4);
    await service.recordPreferences({ event_id: eventId, person: "jordan", slot_ids: ["C", "D"], plus_ones: 1 });
    const r = await service.pickTime({ event_id: eventId });
    expect(r.decided).toBe(true);
    expect(r.party_size).toBe(7);
  });

  it("passes when plus_ones is recorded before pick_time", async () => {
    const { c, service, eventId, final } = await seeded("plus-one");
    const b = new HistoryBuilder().inbound("jordan", "C or D! can I bring my partner?");
    await b.run(service, "record_preferences", { event_id: eventId, person: "jordan", slot_ids: ["C", "D"], plus_ones: 1 }, "jordan");
    await b.run(service, "pick_time", { event_id: eventId }, "jordan");
    expect(failures(c, b.build(await final()))).toEqual([]);
  });

  it("fails when the plus-one is dropped", async () => {
    const { c, service, eventId, final } = await seeded("plus-one");
    const b = new HistoryBuilder();
    await b.run(service, "record_preferences", { event_id: eventId, person: "jordan", slot_ids: ["C", "D"] }, "jordan");
    await b.run(service, "pick_time", { event_id: eventId }, "jordan");
    expect(failed(c, b.build(await final()))).toEqual([
      "Jordan's plus-one is saved",
      "pick_time's party_size counts the plus-one",
    ]);
  });
});

describe("vote-tie", () => {
  it("seeds Voting at 2-2 with Sam and the organizer to vote; their votes tie 3-3 and the organizer wins it", async () => {
    const { event, service, eventId } = await seeded("vote-tie");
    expect(event.stage).toBe("voting");
    expect(event.votes).toHaveLength(4);
    await service.recordVote({ event_id: eventId, person: "sam", option: "1" });
    await service.recordVote({ event_id: eventId, person: "pranav", option: "2" });
    const r = await service.tallyVotes({ event_id: eventId });
    expect(r.winner).toMatchObject({ id: "2", votes: 3 });
    expect(r.tie_broken_by).toBe("organizer");
  });

  it("passes when Fo tallies and reports the organizer's pick", async () => {
    const { c, service, eventId, final } = await seeded("vote-tie");
    const b = new HistoryBuilder().inbound("sam", "1 please!");
    await b.run(service, "record_vote", { event_id: eventId, person: "sam", option: "1" }, "sam");
    b.inbound("pranav", "Put me down for 2");
    await b.run(service, "record_vote", { event_id: eventId, person: "pranav", option: "2" }, "pranav");
    await b.run(service, "tally_votes", { event_id: eventId }, "pranav");
    b.text("pranav", "Tied 3 to 3; Tavola Trattoria wins as your choice. Book Sat 7:30pm for 6?");
    expect(failures(c, b.build(await final()))).toEqual([]);
  });

  it("fails when Fo invents a winner and books it", async () => {
    const { c, service, eventId, final } = await seeded("vote-tie");
    const b = new HistoryBuilder();
    b.text("pranav", "Osteria Marco won!");
    await b.run(service, "confirm_booking", { event_id: eventId, by_phone: ORG, restaurant_name: "Osteria Marco" }, "pranav");
    expect(failed(c, b.build(await final()))).toEqual(c.checks.map((x) => x.description));
  });
});

describe("locked-pick-preference-objection", () => {
  it("seeds Planning with the time picked and Luigi's locked", async () => {
    const { event } = await seeded("locked-pick-preference-objection");
    expect(event.stage).toBe("planning");
    expect(event.chosenSlotId).toBe("C");
    expect(event.organizerPick).toEqual({ restaurantName: "Luigi's Trattoria", firmness: "locked" });
    expect(event.restaurantOptions).toEqual([]);
  });

  it("passes when Fo acknowledges Maya and tells only the organizer", async () => {
    const { c, final } = await seeded("locked-pick-preference-objection");
    const b = new HistoryBuilder().inbound("maya", "honestly I'd rather do sushi this time");
    b.text("maya", "Totally hear you! Luigi's is set for Saturday dinner, but I'll pass it on to Pranav.");
    b.text("pranav", "FYI for Saturday dinner: one friend would rather do sushi. Luigi's is locked so nothing changes.");
    expect(failures(c, b.build(await final()))).toEqual([]);
  });

  it("fails when Fo opens a vote with sushi", async () => {
    const { c, service, eventId, final } = await seeded("locked-pick-preference-objection");
    const b = new HistoryBuilder();
    await b.run(
      service,
      "set_restaurant_options",
      { event_id: eventId, options: [{ name: "Luigi's Trattoria" }, { name: "Sushi Den" }] },
      "maya",
    );
    b.text("jordan", "Vote for Saturday dinner: 1) Luigi's 2) Sushi Den. Maya wants sushi!");
    expect(failed(c, b.build(await final()))).toEqual([
      "No vote or shortlist was opened",
      "Maya gets a reply",
      "The organizer hears about the sushi request privately",
      "No other friend hears about it",
    ]);
  });
});

describe("hard-constraint-after-pick", () => {
  it("seeds a locked Lotus Thai Kitchen booking", async () => {
    const { event } = await seeded("hard-constraint-after-pick");
    expect(event.stage).toBe("booked");
    expect(event.booking).toMatchObject({ restaurantName: "Lotus Thai Kitchen", confirmation: "LTK-3318", slotId: "C" });
    expect(event.organizerPick?.firmness).toBe("locked");
  });

  it("passes when the organizer hears privately with an alternative", async () => {
    const { c, final } = await seeded("hard-constraint-after-pick");
    const b = new HistoryBuilder().inbound("priya", "I have a pretty bad peanut allergy");
    b.text("priya", "Thanks for telling me, Priya. I'll sort it out quietly with Pranav.");
    b.text(
      "pranav",
      "Heads up for Saturday dinner: one guest has a severe peanut allergy, so Lotus Thai Kitchen is risky. Want me to look at a nearby alternative?",
    );
    expect(failures(c, b.build(await final()))).toEqual([]);
  });

  it("fails when Fo tells the group and rebooks on its own", async () => {
    const { c, service, eventId, final } = await seeded("hard-constraint-after-pick");
    const b = new HistoryBuilder();
    b.text("maya", "Heads up, Priya has a peanut allergy so we're switching places.");
    await b.run(service, "confirm_booking", { event_id: eventId, by_phone: ORG, restaurant_name: "Osteria Marco" }, "priya");
    expect(failed(c, b.build(await final()))).toEqual(c.checks.map((x) => x.description));
  });
});
