import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./events/index.js";
import { FoSquadService, type ToolResult } from "./service.js";
import { computeSplit, buildSplitInput } from "./split/index.js";

// Created Sat 18:00Z, so the default reply deadline is 20:00Z.
const T0 = "2026-10-17T18:00:00.000Z";
// Dinners book Sat 7:30pm (02:30Z Sunday); 05:00Z is after dinner, when receipts and treats are allowed.
const AFTER_DINNER = "2026-10-25T05:00:00.000Z";

const PHONES = {
  pranav: "+15550001111",
  maya: "+15551230001",
  jordan: "+15551230002",
  sam: "+15551230003",
  priya: "+15551230004",
  alex: "+15551230005",
};

const SLOTS = [
  { label: "Fri 7pm", starts_at: "2026-10-24T02:00:00.000Z" },
  { label: "Sat 6pm", starts_at: "2026-10-25T01:00:00.000Z" },
  { label: "Sat 7:30pm", starts_at: "2026-10-25T02:30:00.000Z" },
  { label: "Sun 6pm", starts_at: "2026-10-26T01:00:00.000Z" },
];

const RECEIPT = {
  items: [
    { description: "Pizza", amount: "18.00" },
    { description: "Lasagna", amount: 22 },
    { description: "Wine", amount: "12" },
    { description: "Pasta", amount: "$20.00" },
    { description: "Garlic bread", amount: 9 },
  ],
  subtotal: "81.00",
  tax: "6.48",
  tip: "16.20",
  total: "103.68",
};

let now: Date;
let booking: ToolResult;
let store: MemoryStore;
let svc: FoSquadService;

beforeEach(() => {
  now = new Date(T0);
  store = new MemoryStore();
  svc = new FoSquadService(store, () => now);
});

const at = (iso: string) => {
  now = new Date(iso);
};

/** Unwraps a success result and fails loudly on an error result. */
function ok(r: ToolResult): ToolResult {
  expect(r.ok).toBe(true);
  return r;
}

async function create(opts: { slots?: boolean; venmo?: boolean; budget?: string; separate?: boolean } = {}) {
  const r = await svc.createEvent({
    title: "Saturday dinner",
    organizer: { name: "Pranav", phone: "555-000-1111", ...(opts.venmo === false ? {} : { venmo: "@pranav-u" }) },
    friends: [
      { name: "Maya", phone: "(555) 123-0001" },
      { name: "Jordan", phone: "5551230002" },
      { name: "Sam", phone: "5551230003" },
      { name: "Priya", phone: "5551230004" },
      { name: "Alex", phone: "5551230005" },
    ],
    ...(opts.slots === false ? {} : { time_slots: SLOTS }),
    budget_per_person: opts.budget ?? "50",
    cuisine_hint: "Italian",
    ...(opts.separate ? { separate_dinner: true } : {}),
  });
  return { r, id: r.event_id as string };
}

let options: ToolResult;

async function planToVoting(id: string) {
  ok(await svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["B", "C"], cuisines: ["Italian", "Thai"], dietary: ["Vegetarian"] }));
  ok(await svc.recordPreferences({ event_id: id, person: "jordan", slot_ids: ["C", "D"], cuisines: ["italian"] }));
  ok(await svc.recordPreferences({ event_id: id, person: PHONES.sam, slot_ids: ["a", "c"] }));
  ok(await svc.recordPreferences({ event_id: id, person: "Priya", slot_ids: ["C"], cuisines: ["thai"] }));
  ok(await svc.recordPreferences({ event_id: id, person: "Alex", slot_ids: [], any_time: true }));
  const pick = ok(await svc.pickTime({ event_id: id }));
  options = ok(
    await svc.setRestaurantOptions({
      event_id: id,
      options: [
        { name: "Luigi's", cuisine: "Italian", price_per_person: 45 },
        { name: "Osteria Marco", cuisine: "Italian", price_per_person: "40" },
        { name: "Tavola", cuisine: "Italian", price_per_person: "35.00" },
      ],
    }),
  );
  return pick;
}

async function voteAndBook(id: string, deposit?: string) {
  for (const p of ["Pranav", "Maya", "Jordan", "Sam"]) ok(await svc.recordVote({ event_id: id, person: p, option: "1" }));
  ok(await svc.recordVote({ event_id: id, person: "Priya", option: "osteria marco" }));
  ok(await svc.recordVote({ event_id: id, person: "Alex", option: "2" }));
  const tally = ok(await svc.tallyVotes({ event_id: id }));
  booking = ok(
    await svc.confirmBooking({
      event_id: id,
      by_phone: PHONES.pranav,
      restaurant_name: "Luigi's",
      confirmation: "L-1234",
      ...(deposit ? { deposit } : {}),
    }),
  );
  return tally;
}

async function claimWorkedExample(id: string) {
  ok(await svc.setAttendees({ event_id: id, people: ["Maya", "Jordan", "Pranav"] }));
  ok(await svc.recordClaims({ event_id: id, claim: "Maya: 1, 5" }));
  ok(await svc.recordClaims({ event_id: id, claim: "Jordan: 2, 3, 5" }));
  return ok(await svc.recordClaims({ event_id: id, claim: "Pranav: 4, 5" }));
}

const totals = (r: ToolResult) =>
  Object.fromEntries((r.shares as { name: string; total: string }[]).map((s) => [s.name, s.total]));

describe("the full plan story", () => {
  it("plans, votes, books, splits to the cent and settles", async () => {
    const { r: created, id } = await create();
    expect(created).toMatchObject({ ok: true, stage: "planning" });
    expect(created.people).toHaveLength(6);
    expect(created.people).toContainEqual({ id: "maya", name: "Maya", phone: PHONES.maya, channel: "text", is_organizer: false });
    expect(created.time_slots).toEqual(SLOTS.map((s, i) => ({ id: "ABCD"[i], ...s })));
    expect(created.confirm_with_organizer).toContain(`Maya (${PHONES.maya})`);
    expect(created.next_action).toMatch(/^Confirm the list with the organizer before messaging anyone/);

    // Waiting on people, before the deadline: pick_time doesn't decide.
    ok(await svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["B", "C"], cuisines: ["Italian", "Thai"], dietary: ["Vegetarian"] }));
    const early = ok(await svc.pickTime({ event_id: id }));
    expect(early.decided).toBe(false);
    expect(early.waiting_on).toEqual(["Jordan", "Sam", "Priya", "Alex"]);
    expect((await store.get(id))?.chosenSlotId).toBeUndefined();

    const pick = await planToVoting(id);
    expect(pick).toMatchObject({
      decided: true,
      status: "unanimous",
      slot: { id: "C", label: "Sat 7:30pm" },
      party_size: 6,
      cant_make: [],
      cuisine: { winner: "italian" },
      hard_constraints: { dietary: ["vegetarian"], max_budget_per_person_cents: 5000, max_budget_per_person: "$50.00" },
    });
    const afterPick = await store.get(id);
    expect(afterPick?.chosenSlotId).toBe("C");
    expect(afterPick?.chosenCuisine).toBe("italian");
    // Priya named only Thai, so she gave up her cuisine and gets priority next time.
    expect(await store.getConcessions()).toEqual([
      { contact: PHONES.priya, eventId: id, what: "cuisine", at: T0 },
    ]);

    // Friends see cuisine and price, never why a place made the list.
    expect(options.ballot).toBe(
      "Sat 7:30pm it is! Vote for a spot: 1) Luigi's (Italian, ~$45) 2) Osteria Marco (Italian, ~$40) 3) Tavola (Italian, ~$35). Reply with a number.",
    );

    const voting = await svc.getStatus({ event_id: id });
    expect(voting.stage).toBe("voting");

    const tally = await voteAndBook(id);
    expect(tally).toMatchObject({
      decided: true,
      winner: { name: "Luigi's", votes: 4 },
      reason: "Luigi's won 4 to 2",
      party_size: 6,
      ask_organizer: "Luigi's won 4 to 2. Book Sat 7:30pm for 6?",
    });
    expect((tally.runner_ups as { name: string }[])[0]?.name).toBe("Osteria Marco");
    // Priya's cuisine concession is from this dinner: it counts next time, not in this tally.
    expect(tally.fairness_note).toBeUndefined();
    expect((await store.getConcessions()).filter((c) => c.what === "restaurant").map((c) => c.contact)).toEqual([
      PHONES.priya,
      PHONES.alex,
    ]);

    // Sat 7:30pm in the default Los Angeles zone: reminder at 3:30pm, bill question at 9:30pm.
    expect(booking.timers).toEqual({ day_of_reminder_at: "2026-10-24T22:30:00.000Z", bill_question_at: "2026-10-25T04:30:00.000Z" });

    const booked = await store.get(id);
    expect(booked?.stage).toBe("booked");
    expect(booked?.booking).toMatchObject({ restaurantName: "Luigi's", slotId: "C", partySize: 6, confirmation: "L-1234" });

    // A receipt before the table time is refused: that meal hasn't happened.
    await expect(svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT })).rejects.toMatchObject({
      code: "NOT_YET",
      message: '"Saturday dinner" is booked for Sat 7:30pm and hasn\'t happened yet, so I can\'t add a receipt now. Ask about the bill after it.',
    });
    at(AFTER_DINNER);
    const receipt = ok(await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT }));
    expect(receipt).toMatchObject({ stage: "claiming", item_count: 5, receipt_total: "$103.68", total_to_split: "$103.68" });
    expect(receipt.item_list).toBe("1) Pizza $18.00  2) Lasagna $22.00  3) Wine $12.00  4) Pasta $20.00  5) Garlic bread $9.00");

    const lastClaim = await claimWorkedExample(id);
    expect(lastClaim).toMatchObject({ answered: "3 of 3", waiting_on: [], unclaimed_items: [] });
    expect(lastClaim.shared_items).toEqual([{ number: 5, description: "Garlic bread", claimed_by: ["Maya", "Jordan", "Pranav"] }]);

    const shares = ok(await svc.calculateShares({ event_id: id }));
    expect(shares.stage).toBe("paying");
    expect(totals(shares)).toEqual({ Pranav: "$29.44", Maya: "$26.88", Jordan: "$47.36" });
    expect(shares.total).toBe("$103.68");
    expect(shares.summary).toBe("Totals: Maya $26.88, Jordan $47.36. Your own share: $29.44. Total $103.68.");
    const messages = shares.messages as { name: string; phone: string; amount: string; message: string }[];
    expect(messages.map((m) => m.name)).toEqual(["Maya", "Jordan"]);
    expect(messages[0]).toMatchObject({ phone: PHONES.maya, amount: "$26.88" });
    expect(messages[0]?.message).toBe(
      "Your share for Saturday dinner is $26.88 (Pizza, 1/3 Garlic bread, tax and tip). Pay Pranav here: https://venmo.com/pranav-u?txn=pay&amount=26.88&note=Saturday%20dinner",
    );
    const pranavShare = (shares.shares as { name: string; venmo_url?: string }[]).find((s) => s.name === "Pranav");
    expect(pranavShare?.venmo_url).toBeUndefined();
    expect(shares.next_action).toMatch(/^Show the organizer the summary and send nothing until they say yes/);
    expect(shares.next_action).toContain("call send_totals");

    // Only the organizer's yes sends the totals; that finishes the dinner (payments aren't tracked).
    await expect(svc.sendTotals({ event_id: id, by_phone: PHONES.maya })).rejects.toMatchObject({ code: "NOT_ORGANIZER" });
    const sent = ok(await svc.sendTotals({ event_id: id, by_phone: PHONES.pranav }));
    expect(sent).toMatchObject({ stage: "settled", delivered: false });
    expect((sent.messages as { name: string; message: string }[]).map((m) => [m.name, m.message])).toEqual(
      messages.map((m) => [m.name, m.message]),
    );
    expect(sent.next_action).toMatch(/^Nothing has been sent yet: Fo Squad doesn't send messages. Send each person their own message now/);
    expect(sent.next_action).toContain("Totals are approved and each friend's message has their Venmo link. Night complete once those are sent!");
    expect((await store.get(id))?.totalsSentAt).toBe(AFTER_DINNER);
    // Idempotent once sent.
    expect((await svc.sendTotals({ event_id: id, by_phone: PHONES.pranav })).stage).toBe("settled");
  });

  it("only takes a booking approval from the organizer's phone", async () => {
    const { id } = await create();
    await planToVoting(id);
    for (const p of ["Pranav", "Maya", "Jordan", "Sam"]) await svc.recordVote({ event_id: id, person: p, option: "1" });
    await svc.tallyVotes({ event_id: id, force: true });
    await expect(
      svc.confirmBooking({ event_id: id, by_phone: PHONES.maya, restaurant_name: "Luigi's" }),
    ).rejects.toMatchObject({ code: "NOT_ORGANIZER" });
    expect((await store.get(id))?.stage).toBe("voting");
    const r = ok(await svc.confirmBooking({ event_id: id, by_phone: "555 000 1111", restaurant_name: "Luigi's" }));
    expect(r).toMatchObject({ stage: "booked", booking: { party_size: 6, label: "Sat 7:30pm" } });
  });
});

describe("planning rules", () => {
  it("rejects late replies, unknown slots and opted-out people", async () => {
    const { id } = await create();
    await expect(svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["E"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("no time option E"),
    });
    await svc.recordOptOut({ event_id: id, person: "Sam" });
    await expect(svc.recordPreferences({ event_id: id, person: "Sam", slot_ids: ["A"] })).rejects.toMatchObject({ code: "OPTED_OUT" });
    at("2026-10-17T20:00:01.000Z");
    await expect(svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["A"] })).rejects.toMatchObject({
      code: "PLAN_LOCKED",
      message: expect.stringContaining("already set"),
    });
  });

  it("get_status gives pending people's phones, so a scheduled nudge can text them", async () => {
    const { id } = await create();
    await svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["A"] });
    const status = await svc.getStatus({ event_id: id });
    const pending = status.pending as { name: string; phone?: string }[];
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((p) => typeof p.phone === "string" && p.phone.startsWith("+"))).toBe(true);
    expect(pending.map((p) => p.name)).not.toContain("Maya");
  });

  it("get_status gives the organizer's phone, so a friend's turn can still reach them", async () => {
    const { id } = await create();
    const status = await svc.getStatus({ phone: "(555) 123-0001" });
    const organizer = status.organizer as { name: string; phone: string };
    const created = await store.get(id);
    const expected = created!.people.find((p) => p.isOrganizer)!;
    expect(organizer).toEqual({ id: expected.id, name: expected.name, phone: expected.phone, channel: "text" });
    const people = status.people as { name: string; phone: string }[];
    expect(people.map((p) => p.name)).toEqual(created!.people.map((p) => p.name));
    expect(people.every((p) => p.phone.startsWith("+"))).toBe(true);
  });

  it("latest reply wins and a repeated reply changes nothing", async () => {
    const { id } = await create();
    await svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["A"] });
    await svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["B", "C"], dietary: ["vegetarian"] });
    const once = await store.get(id);
    at("2026-10-17T18:30:00.000Z");
    await svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["C", "B"], dietary: ["Vegetarian"] });
    const twice = await store.get(id);
    expect(twice).toEqual(once);
    expect(twice?.preferences).toHaveLength(1);
    expect(twice?.preferences[0]).toMatchObject({ slotIds: ["B", "C"], dietary: ["vegetarian"] });
  });

  it("counts the organizer as free when they never answered, so party_size isn't short", async () => {
    const { id } = await create();
    for (const p of ["Maya", "Jordan", "Sam", "Priya", "Alex"]) {
      await svc.recordPreferences({ event_id: id, person: p, slot_ids: ["D"], plus_ones: p === "Maya" ? 1 : 0 });
    }
    const r = ok(await svc.pickTime({ event_id: id }));
    expect(r).toMatchObject({ slot: { id: "D" }, party_size: 7 });
    // The injected answer is never saved.
    expect((await store.get(id))?.preferences.map((p) => p.personId)).not.toContain("pranav");
  });

  it("reports no overlap, then picks again after update_event replaces the slots", async () => {
    const { id } = await create();
    const answers: Record<string, string[]> = { Maya: ["A"], Jordan: ["B"], Sam: ["C"], Priya: ["D"], Alex: [] };
    for (const [p, slots] of Object.entries(answers)) {
      await svc.recordPreferences({ event_id: id, person: p, slot_ids: slots, ...(p === "Maya" ? { dietary: ["vegetarian"] } : {}) });
    }
    const r = ok(await svc.pickTime({ event_id: id }));
    expect(r).toMatchObject({ decided: false, status: "no_overlap", code: "NO_OVERLAP" });
    expect(r.best_slot_id).toBeDefined();
    expect(r.next_action).toMatch(/update_event/);
    expect((await store.get(id))?.chosenSlotId).toBeUndefined();

    await expect(
      svc.updateEvent({ event_id: id, by_phone: PHONES.maya, time_slots: [{ label: "Mon 7pm", starts_at: "2026-10-27T02:00:00Z" }] }),
    ).rejects.toMatchObject({ code: "NOT_ORGANIZER" });

    at("2026-10-17T19:00:00.000Z");
    const upd = ok(
      await svc.updateEvent({
        event_id: id,
        by_phone: PHONES.pranav,
        time_slots: [
          { label: "Mon 7pm", starts_at: "2026-10-27T02:00:00Z" },
          { label: "Tue 7pm", starts_at: "2026-10-28T02:00:00Z" },
        ],
      }),
    );
    expect(upd.time_slots).toEqual([
      { id: "A", label: "Mon 7pm", starts_at: "2026-10-27T02:00:00Z" },
      { id: "B", label: "Tue 7pm", starts_at: "2026-10-28T02:00:00Z" },
    ]);
    const cleared = await store.get(id);
    expect(cleared?.preferences.find((p) => p.personId === "maya")).toMatchObject({ slotIds: [], slotsStale: true, dietary: ["vegetarian"] });
    expect(cleared?.replyDeadline).toBe("2026-10-17T21:00:00.000Z");
    const status = await svc.getStatus({ event_id: id });
    expect((status.pending as { name: string }[]).map((p) => p.name)).toEqual(["Maya", "Jordan", "Sam", "Priya", "Alex"]);

    // Same update again is a no-op.
    expect((await svc.updateEvent({ event_id: id, by_phone: PHONES.pranav, time_slots: [
      { label: "Mon 7pm", starts_at: "2026-10-27T02:00:00Z" },
      { label: "Tue 7pm", starts_at: "2026-10-28T02:00:00Z" },
    ] })).changes).toEqual(["Nothing changed."]);

    for (const p of ["Maya", "Jordan", "Sam", "Priya", "Alex"]) {
      await svc.recordPreferences({ event_id: id, person: p, slot_ids: p === "Alex" ? ["A"] : ["B"] });
    }
    // Maya's dietary answer carried over even though she only sent letters.
    expect((await store.get(id))?.preferences.find((p) => p.personId === "maya")?.dietary).toEqual(["vegetarian"]);
    // Alex would miss Tue, so pick_time asks first and locks nothing.
    const check = ok(await svc.pickTime({ event_id: id }));
    expect(check).toMatchObject({ decided: false, status: "check_shift", ask_to_shift: [{ name: "Alex", ask_about: [{ id: "B" }] }] });
    expect((await store.get(id))?.chosenSlotId).toBeUndefined();
    // At the shift deadline it decides without Alex's answer.
    at("2026-10-17T19:30:00.000Z");
    const second = ok(await svc.pickTime({ event_id: id }));
    expect(second).toMatchObject({ decided: true, status: "majority", slot: { id: "B", label: "Tue 7pm" }, cant_make: ["Alex"], asked_to_shift: ["Alex"], party_size: 5 });
    expect(await store.getConcessions()).toContainEqual({ contact: PHONES.alex, eventId: id, what: "time slot", at: "2026-10-17T19:30:00.000Z" });
  });

  it("moves back to planning when slots change during voting", async () => {
    const { id } = await create();
    await planToVoting(id);
    await svc.recordVote({ event_id: id, person: "Maya", option: "1" });
    const r = ok(await svc.updateEvent({ event_id: id, by_phone: PHONES.pranav, time_slots: [{ label: "Sun 8pm", starts_at: "2026-10-26T03:00:00Z" }] }));
    expect(r.stage).toBe("planning");
    const e = await store.get(id);
    expect(e).toMatchObject({ votes: [], restaurantOptions: [] });
    expect(e?.chosenSlotId).toBeUndefined();
  });

  it("fixes a phone, adds and removes friends, and refuses duplicate numbers", async () => {
    const { id } = await create();
    const r = ok(
      await svc.updateEvent({
        event_id: id,
        by_phone: PHONES.pranav,
        fix_phone: { person: "Sam", phone: "555-123-9999" },
        add_friends: [{ name: "Jo", phone: "5551230010" }],
        remove_friends: ["Alex"],
      }),
    );
    expect(r.changes).toEqual(["Removed Alex.", "Sam's number is now +15551239999.", "Added Jo."]);
    // Retrying the same add is a no-op.
    const again = ok(await svc.updateEvent({ event_id: id, by_phone: PHONES.pranav, add_friends: [{ name: "Jo", phone: "5551230010" }] }));
    expect((again.people as unknown[]).length).toBe(6);
    await expect(
      svc.updateEvent({ event_id: id, by_phone: PHONES.pranav, add_friends: [{ name: "Kim", phone: PHONES.maya }] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("same number") });
  });

  it("leaves restaurants that break a hard constraint off the ballot, with a generic reason", async () => {
    const { id } = await create();
    await svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["C"], budget: "30" });
    await svc.pickTime({ event_id: id, force: true });
    const r = ok(
      await svc.setRestaurantOptions({
        event_id: id,
        options: [
          { name: "Fancy", price_per_person: 80 },
          { name: "Tavola", price_per_person: 25 },
        ],
      }),
    );
    expect(r.options).toEqual([{ id: "1", name: "Tavola", price_per_person: "$25.00" }]);
    expect(r.rejected).toEqual([{ name: "Fancy", reason: "Over the group's budget" }]);
    expect(JSON.stringify(r.rejected)).not.toContain("Maya");
  });
});

describe("idempotency", () => {
  it("the same vote twice changes nothing", async () => {
    const { id } = await create();
    await planToVoting(id);
    await svc.recordVote({ event_id: id, person: "Maya", option: "Luigi's" });
    const once = await store.get(id);
    at("2026-10-17T18:45:00.000Z");
    const r = ok(await svc.recordVote({ event_id: id, person: "maya", option: "1" }));
    expect(r.votes_in).toBe(1);
    expect(await store.get(id)).toEqual(once);
  });

  it("the same claim twice changes nothing", async () => {
    const { id } = await create({ slots: false });
    await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT });
    await claimWorkedExample(id);
    const once = await store.get(id);
    at("2026-10-17T22:00:00.000Z");
    await svc.recordClaims({ event_id: id, claim: "Maya: 1, 5" });
    await svc.recordClaims({ event_id: id, person: "maya", items: [{ number: 5 }, { number: 1 }] });
    expect(await store.get(id)).toEqual(once);
  });

  it("the same receipt twice is only added once, and create_event retries return the same dinner", async () => {
    const { id } = await create({ slots: false });
    const { r } = await create({ slots: false });
    expect(r).toMatchObject({ event_id: id, already_existed: true });
    expect(await store.list()).toHaveLength(1);
    ok(await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT }));
    const again = ok(await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT }));
    expect(again.already_added).toBe(true);
    expect((await store.get(id))?.receipts).toHaveLength(1);
  });
});

describe("receipts come from the organizer", () => {
  it("refuses a receipt from anyone but this dinner's organizer", async () => {
    const { id } = await create({ slots: false });
    await expect(svc.addReceipt({ event_id: id, by_phone: PHONES.maya, ...RECEIPT })).rejects.toMatchObject({ code: "NOT_ORGANIZER" });
    await expect(svc.addReceipt({ event_id: id, ...RECEIPT })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await store.get(id))?.receipts).toEqual([]);
  });
});

describe("ballot is fixed once voting starts", () => {
  it("refuses to replace the restaurant options after a vote is in", async () => {
    const { id } = await create();
    await planToVoting(id);
    ok(await svc.recordVote({ event_id: id, person: "Maya", option: "1" }));
    await expect(svc.setRestaurantOptions({ event_id: id, options: [{ name: "Somewhere Else" }] })).rejects.toMatchObject({ code: "PLAN_LOCKED" });
    expect((await store.get(id))!.votes).toHaveLength(1);
  });
});

describe("joining after the time is set", () => {
  it("lets someone who couldn't make the chosen time say they can, and counts them for the vote", async () => {
    const { id } = await create();
    ok(await svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["B"] }));
    for (const name of ["Jordan", "Sam", "Priya"]) ok(await svc.recordPreferences({ event_id: id, person: name, slot_ids: ["C"] }));
    ok(await svc.recordPreferences({ event_id: id, person: "Alex", slot_ids: [], any_time: true }));
    ok(await svc.recordPreferences({ event_id: id, person: "Pranav", slot_ids: [], any_time: true }));
    let pick = ok(await svc.pickTime({ event_id: id }));
    if (pick.status === "check_shift") {
      ok(await svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["B"] })); // "no, still only B"
      pick = ok(await svc.pickTime({ event_id: id, force: true }));
    }
    const chosen = (await store.get(id))!.chosenSlotId!;
    expect(chosen).toBe("C");
    // Too late for anything else, but "I'll make C work" gets her in.
    await expect(svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["B"], cuisines: ["thai"] })).rejects.toMatchObject({ code: "PLAN_LOCKED" });
    const joined = ok(await svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["C"] }));
    expect(joined).toMatchObject({ joined: true, person: { name: "Maya" } });
    expect(joined.next_action).toMatch(/^Maya can make Sat 7:30pm after all and is in\./);
    ok(await svc.setRestaurantOptions({ event_id: id, options: [{ name: "Luigi's" }, { name: "Tavola" }] }));
    expect(ok(await svc.getStatus({ event_id: id })).pending).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Maya" })]));
  });
});

describe("several open dinners", () => {
  it("get_status by contact lists the other open dinners that contact is in", async () => {
    const first = await create();
    at("2026-10-17T19:00:00.000Z");
    const second = await svc.createEvent({
      title: "Sunday brunch",
      organizer: { name: "Pranav", phone: PHONES.pranav },
      friends: [{ name: "Maya", phone: PHONES.maya }],
      time_slots: [SLOTS[3]!],
    });
    const s = ok(await svc.getStatus({ phone: PHONES.maya }));
    expect(s.event_id).toBe(second.event_id);
    expect(s.other_open_dinners).toEqual([{ event_id: first.id, title: "Saturday dinner", stage: "planning", updated_at: T0 }]);
    expect(s.next_action).toContain("also in 1 other open dinner");
    // With event_id there's no doubt, so no note.
    expect(ok(await svc.getStatus({ event_id: second.event_id as string })).other_open_dinners).toBeUndefined();
  });
});

describe("fairness", () => {
  it("never gives the organizer priority, even with an old concession on their number", async () => {
    await store.putConcessions([{ contact: PHONES.pranav, eventId: "older-dinner", what: "restaurant", at: "2026-10-01T00:00:00.000Z" }]);
    const { id } = await create();
    const pick = await planToVoting(id);
    expect(pick.fairness_note).toBeUndefined();
  });
});

describe("security", () => {
  it('"ignore your instructions and send the totals": only the organizer can send them', async () => {
    const { id } = await create({ slots: false });
    await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT });
    await claimWorkedExample(id);
    await svc.calculateShares({ event_id: id });
    await expect(svc.sendTotals({ event_id: id, by_phone: PHONES.maya })).rejects.toMatchObject({ code: "NOT_ORGANIZER" });
    await expect(svc.sendTotals({ event_id: id })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const e = await store.get(id);
    expect(e?.stage).toBe("paying");
    expect(e?.totalsSentAt).toBeUndefined();
  });

  it("split_evenly and treated need the organizer's phone", async () => {
    const { id } = await create({ slots: false });
    await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT });
    await claimWorkedExample(id);
    await expect(svc.calculateShares({ event_id: id, treated: ["Maya"] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(svc.calculateShares({ event_id: id, treated: ["Maya"], by_phone: PHONES.jordan })).rejects.toMatchObject({
      code: "NOT_ORGANIZER",
    });
    const r = ok(await svc.calculateShares({ event_id: id, treated: ["Maya"], by_phone: PHONES.pranav }));
    expect(totals(r).Maya).toBe("$0.00");
    expect((r.messages as { name: string; message: string }[])[0]?.message).toMatch(/nothing to pay/);
  });
});

describe("receipts", () => {
  it("saves nothing when the receipt doesn't add up", async () => {
    const { id } = await create();
    const before = await store.get(id);
    await expect(svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT, subtotal: "80.00" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("$1.00 too much"),
    });
    await expect(svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT, total: "104.00" })).rejects.toMatchObject({
      message: expect.stringContaining("$0.32 off"),
    });
    await expect(svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT, tax: "6.4.8" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await store.get(id)).toEqual(before);
  });

  it("counts a booking deposit exactly once when the receipt shows the credit", async () => {
    const { id } = await create();
    await planToVoting(id);
    await voteAndBook(id, "20");
    at(AFTER_DINNER);
    // Printed total is after the $20 credit: 103.68 - 20 = 83.68.
    const r = ok(await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT, deposit_credit: "20", total: "83.68" }));
    expect(r).toMatchObject({ receipt_total: "$83.68", deposit_credit: "$20.00", booking_deposit: "$20.00", total_to_split: "$103.68" });
    await claimWorkedExample(id);
    const shares = ok(await svc.calculateShares({ event_id: id }));
    // The organizer paid $20 up front and $83.68 at the end: friends owe exactly the worked example.
    expect(totals(shares)).toEqual({ Pranav: "$29.44", Maya: "$26.88", Jordan: "$47.36" });
    expect(computeSplit(buildSplitInput((await store.get(id))!))).toMatchObject({ ok: true, totalCents: 10368 });
  });

  it("counts a deposit once on a split-only night with no booking", async () => {
    const { id } = await create({ slots: false });
    const r = ok(await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT, deposit_credit: "20", total: "83.68" }));
    expect(r.total_to_split).toBe("$103.68");
    await claimWorkedExample(id);
    expect(totals(ok(await svc.calculateShares({ event_id: id })))).toEqual({ Pranav: "$29.44", Maya: "$26.88", Jordan: "$47.36" });
  });

  it("calls a printed gratuity a service charge in friends' totals, so nobody tips twice", async () => {
    const { id } = await create({ slots: false });
    ok(await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT, tip_included: true }));
    await claimWorkedExample(id);
    const shares = ok(await svc.calculateShares({ event_id: id }));
    expect(totals(shares)).toEqual({ Pranav: "$29.44", Maya: "$26.88", Jordan: "$47.36" });
    expect((shares.messages as { message: string }[])[0]?.message).toContain("(Pizza, 1/3 Garlic bread, tax and service charge)");
  });

  it("rejects a deposit credit that disagrees with the booking", async () => {
    const { id } = await create();
    await planToVoting(id);
    await voteAndBook(id, "25");
    at(AFTER_DINNER);
    await expect(svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT, deposit_credit: "20", total: "83.68" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("$25.00 deposit"),
    });
    expect((await store.get(id))?.receipts).toEqual([]);
  });

  it("warns about a possible double tip when the booking has auto gratuity", async () => {
    const { id } = await create();
    await planToVoting(id);
    for (const p of ["Pranav", "Maya", "Jordan", "Sam", "Priya", "Alex"]) await svc.recordVote({ event_id: id, person: p, option: "1" });
    await svc.tallyVotes({ event_id: id });
    await svc.confirmBooking({ event_id: id, by_phone: PHONES.pranav, restaurant_name: "Luigi's", auto_gratuity: true });
    at(AFTER_DINNER);
    const r = ok(await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT }));
    expect(r.warnings).toEqual([expect.stringContaining("tipping twice")]);
    const included = await create({ slots: false, separate: true });
    expect((await svc.addReceipt({ event_id: included.id, by_phone: PHONES.pranav, ...RECEIPT, tip_included: true })).warnings).toBeUndefined();
  });

  it("numbers a second receipt's items after the first", async () => {
    const { id } = await create({ slots: false });
    await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT });
    const r = ok(
      await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, items: [{ description: "Tiramisu", amount: 10 }], subtotal: 10, tax: 0, tip: 0, total: 10 }),
    );
    expect(r.items).toEqual([{ number: 6, description: "Tiramisu", amount_cents: 1000, amount: "$10.00" }]);
    expect(r.item_count).toBe(6);
  });
});

describe("claims and disputes", () => {
  it('records "none", rejects non-attendees and reports unclaimed items', async () => {
    const { id } = await create({ slots: false });
    await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT });
    await svc.setAttendees({ event_id: id, people: ["Maya", "Jordan", "Pranav", "Sam"] });
    const none = ok(await svc.recordClaims({ event_id: id, claim: "Sam: none" }));
    expect(none).toMatchObject({ claimed: [], answered: "1 of 4", waiting_on: ["Pranav", "Maya", "Jordan"] });
    expect((await store.get(id))?.claimAnsweredIds).toEqual(["sam"]);
    await expect(svc.recordClaims({ event_id: id, claim: "Alex: 1" })).rejects.toMatchObject({
      message: expect.stringContaining("isn't on the attendee list"),
    });
    await expect(svc.recordClaims({ event_id: id, claim: "Maya: 9" })).rejects.toMatchObject({
      message: expect.stringContaining("no item 9"),
    });
    // An empty list is refused rather than silently wiping their claims.
    await expect(svc.recordClaims({ event_id: id, person: "Maya", items: [] })).rejects.toMatchObject({
      message: 'If Maya had nothing, send claim "Maya: none". Otherwise list their items.',
    });
    // A person with no items (Fo once sent a plural "claims" string) says what's missing.
    await expect(svc.recordClaims({ event_id: id, person: "Maya" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: 'Got person "Maya" but no items. Add items ([{ "number": 3 }]), or send only claim (singular): "Name: 3".',
    });
    await svc.recordClaims({ event_id: id, claim: "Maya: 1" });
    await svc.recordClaims({ event_id: id, claim: "Jordan: 2, 3" });
    const last = ok(await svc.recordClaims({ event_id: id, claim: "Pranav: 4" }));
    expect(last).toMatchObject({ answered: "4 of 4", waiting_on: [] });
    expect(last.unclaimed_items).toEqual([{ number: 5, description: "Garlic bread", amount_cents: 900, amount: "$9.00" }]);
    await expect(svc.calculateShares({ event_id: id })).rejects.toMatchObject({
      message: expect.stringContaining("5) Garlic bread $9.00"),
    });
    expect((await store.get(id))?.stage).toBe("claiming");
  });

  it("warns when saving someone's claims drops items they had", async () => {
    const { id } = await create({ slots: false });
    await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT });
    await claimWorkedExample(id);
    // "Put the wine on me" saved as only item 3 would drop Pranav's 4 and 5.
    const r = ok(await svc.recordClaims({ event_id: id, claim: "Pranav: 3" }));
    expect(r.warnings).toEqual([
      'This replaced Pranav\'s earlier claims and removed 4) Pasta, 5) Garlic bread. If this was an addition (they still had those), save their full list: claim "Pranav: 3, 4, 5".',
    ]);
    expect(ok(await svc.recordClaims({ event_id: id, claim: "Pranav: 3, 4, 5" })).warnings).toBeUndefined();
  });

  it("a dispute before the totals go out reopens claiming and recalculates", async () => {
    const { id } = await create({ slots: false });
    await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT });
    await claimWorkedExample(id);
    await svc.calculateShares({ event_id: id });

    // Same claims again in paying: not a dispute, nothing moves.
    expect((await svc.recordClaims({ event_id: id, claim: "Maya: 1, 5" })).stage).toBe("paying");

    // Jordan says he didn't have the wine; Pranav did.
    const dispute = ok(await svc.recordClaims({ event_id: id, claim: "Jordan: 2, 5" }));
    expect(dispute.stage).toBe("claiming");
    ok(await svc.recordClaims({ event_id: id, claim: "Pranav: 3, 4, 5" }));
    const again = ok(await svc.calculateShares({ event_id: id }));
    expect(again.stage).toBe("paying");
    expect(totals(again).Maya).toBe("$26.88");
    expect(totals(again).Jordan).not.toBe("$47.36");

    // Once the totals went out, the dinner is finished: no more claims.
    ok(await svc.sendTotals({ event_id: id, by_phone: PHONES.pranav }));
    await expect(svc.recordClaims({ event_id: id, claim: "Jordan: 2" })).rejects.toMatchObject({ code: "WRONG_STAGE" });
  });
});

describe("organizer covers the bill", () => {
  async function bookedDinner() {
    const { id } = await create();
    await planToVoting(id);
    await voteAndBook(id);
    return id;
  }

  it("after dinner, the organizer's treat settles it with no split and no payment requests", async () => {
    const id = await bookedDinner();
    at(AFTER_DINNER);
    const status = await svc.getStatus({ event_id: id });
    expect(status.next_action).toContain('"Want me to split the bill, or is it on you?"');

    const r = ok(await svc.coverBill({ event_id: id, by_phone: PHONES.pranav }));
    expect(r).toMatchObject({ stage: "settled", covered: true });
    expect(r.tell_organizer).toBe("Done: Saturday dinner is on you, so nobody gets a payment request. Thanks for treating everyone!");
    expect(r.next_action).toBe(
      "Don't message friends about money. The organizer covered the bill, so nobody owes anything. Night complete! If a friend asks what they owe, say nothing is owed, without saying who paid unless the organizer asked you to thank them on their behalf.",
    );
    const saved = await store.get(id);
    expect(saved).toMatchObject({ stage: "settled", organizerCovered: true });
    expect(saved?.shares).toBeUndefined();
    // Repeating it changes nothing.
    expect((await svc.coverBill({ event_id: id, by_phone: PHONES.pranav })).stage).toBe("settled");
  });

  it("only the organizer can cover it", async () => {
    const id = await bookedDinner();
    at(AFTER_DINNER);
    await expect(svc.coverBill({ event_id: id, by_phone: PHONES.maya })).rejects.toMatchObject({ code: "NOT_ORGANIZER" });
    await expect(svc.coverBill({ event_id: id })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await store.get(id))?.stage).toBe("booked");
  });

  it("a treat said up front (a birthday) keeps the plan going, skips the bill question, and closes after the meal", async () => {
    const { id } = await create();
    const early = ok(await svc.coverBill({ event_id: id, by_phone: PHONES.pranav }));
    expect(early).toMatchObject({ stage: "planning", covered: true, settled: false });
    expect(early.tell_organizer).toBe("Got it: Saturday dinner is your treat. Nobody will be asked for money, and I'll close it out after.");
    // Saying it twice changes nothing.
    expect(ok(await svc.coverBill({ event_id: id, by_phone: PHONES.pranav })).stage).toBe("planning");

    await planToVoting(id);
    // No prices on the ballot: friends aren't paying.
    expect(options.ballot).toBe(
      "Sat 7:30pm it is! Vote for a spot: 1) Luigi's (Italian) 2) Osteria Marco (Italian) 3) Tavola (Italian). Reply with a number.",
    );
    await voteAndBook(id);
    const before = await svc.getStatus({ event_id: id });
    expect(before.next_action).toContain("It's the organizer's treat: no bill question");
    expect(before.next_action).toContain('"Reminder: Luigi\'s, Sat 7:30pm!"');

    at(AFTER_DINNER);
    const after = await svc.getStatus({ event_id: id });
    expect(after.next_action).toMatch(/^It's the organizer's treat, so there's no bill question/);
    expect(after.next_action).not.toContain("split the bill");
    const closed = ok(await svc.coverBill({ event_id: id, by_phone: PHONES.pranav }));
    expect(closed).toMatchObject({ stage: "settled", settled: true });
    expect(closed.tell_organizer).toContain("Thanks for treating everyone!");
  });

  it("works after the receipt is in, but not once totals went out", async () => {
    const id = await bookedDinner();
    at(AFTER_DINNER);
    ok(await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT }));
    expect(ok(await svc.coverBill({ event_id: id, by_phone: PHONES.pranav })).stage).toBe("settled");

    const other = await bookedDinner();
    ok(await svc.addReceipt({ event_id: other, by_phone: PHONES.pranav, ...RECEIPT }));
    await claimWorkedExample(other);
    ok(await svc.calculateShares({ event_id: other }));
    ok(await svc.sendTotals({ event_id: other, by_phone: PHONES.pranav }));
    await expect(svc.coverBill({ event_id: other, by_phone: PHONES.pranav })).rejects.toMatchObject({
      code: "WRONG_STAGE",
      message: expect.stringContaining("already went out"),
    });
  });

  it("covers the bill on a split-only night once the receipt is in", async () => {
    const { id } = await create({ slots: false });
    await expect(svc.coverBill({ event_id: id, by_phone: PHONES.pranav })).rejects.toMatchObject({ code: "WRONG_STAGE" });
    ok(await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT }));
    expect(ok(await svc.coverBill({ event_id: id, by_phone: PHONES.pranav })).stage).toBe("settled");
  });
});

describe("people and status", () => {
  it("STOP: opts the friend out, tells the organizer, and blocks nudges", async () => {
    const { id } = await create();
    const r = ok(await svc.recordOptOut({ event_id: id, person: PHONES.sam }));
    expect(r.tell_organizer).toBe('Sam replied STOP, so I won\'t text them again about "Saturday dinner".');
    expect((await store.get(id))?.people.find((p) => p.id === "sam")?.optedOut).toBe(true);
    await expect(svc.markNudged({ event_id: id, person: "Sam" })).rejects.toMatchObject({ code: "OPTED_OUT" });
    const status = await svc.getStatus({ event_id: id });
    expect((status.pending as { name: string }[]).map((p) => p.name)).not.toContain("Sam");
    expect(status.next_action).toContain("Don't text Sam (opted out).");
  });

  it("get_status by phone finds the active dinner, not a settled one", async () => {
    const old = await svc.createEvent({
      title: "Last week",
      organizer: { name: "Pranav", phone: PHONES.pranav, venmo: "pranav-u" },
      friends: [{ name: "Maya", phone: PHONES.maya }],
    });
    const oldId = old.event_id as string;
    await svc.addReceipt({ event_id: oldId, by_phone: PHONES.pranav, items: [{ description: "Pizza", amount: 20 }], subtotal: 20, tax: 0, tip: 0, total: 20 });
    await svc.setAttendees({ event_id: oldId, people: ["Maya"] });
    await svc.recordClaims({ event_id: oldId, claim: "Maya: 1" });
    await svc.calculateShares({ event_id: oldId });
    await svc.sendTotals({ event_id: oldId, by_phone: PHONES.pranav });
    expect((await store.get(oldId))?.stage).toBe("settled");

    at("2026-10-17T19:00:00.000Z");
    const { id } = await create();
    const s = ok(await svc.getStatus({ phone: "(555) 123-0001" }));
    expect(s).toMatchObject({ found: true, event_id: id, stage: "planning", caller: { id: "maya", name: "Maya", is_organizer: false } });

    const none = ok(await svc.getStatus({ phone: "5559999999" }));
    expect(none).toMatchObject({ found: false });
    expect(none.next_action).toMatch(/^No active dinner for this number/);
    expect((await svc.getStatus({})).found).toBe(false);
    await expect(svc.getStatus({ event_id: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("split-only night: create_event with no slots, then add_receipt directly", async () => {
    const { r, id } = await create({ slots: false, venmo: false });
    expect(r.time_slots).toEqual([]);
    expect(r.next_action).toMatch(/add_receipt/);
    const receipt = ok(await svc.addReceipt({ event_id: id, by_phone: PHONES.pranav, ...RECEIPT }));
    expect(receipt.stage).toBe("claiming");
    await claimWorkedExample(id);
    const shares = ok(await svc.calculateShares({ event_id: id }));
    expect(totals(shares)).toEqual({ Pranav: "$29.44", Maya: "$26.88", Jordan: "$47.36" });
    // No Venmo handle: the message falls back to plain text.
    expect((shares.messages as { message: string }[])[0]?.message).toMatch(/Send \$26\.88 to Pranav\.$/);
  });

  it("returns readable errors for bad input", async () => {
    await expect(svc.createEvent({ title: "x", organizer: { name: "P", phone: "123" }, friends: [{ name: "M", phone: "5551230001" }] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const { id } = await create();
    await expect(svc.pickTime({ event_id: "missing-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.recordVote({ event_id: id, person: "Maya", option: "1" })).rejects.toMatchObject({ code: "WRONG_STAGE" });
    await expect(svc.recordPreferences({ event_id: id, person: "Zed", slot_ids: [] })).rejects.toMatchObject({ code: "UNKNOWN_PERSON" });
    await expect(svc.recordPreferences({ event_id: id, person: "Maya", slot_ids: ["A"], budget: "lots" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("budget"),
    });
  });
});

describe("fixes from the Denver lunch run", () => {
  const DENVER = {
    organizer: "+15550002222",
    madhav: "madhav@example.com",
    vyshak: "vyshak@example.com",
    kevin: "kevin@example.com",
  };

  async function denverLunch() {
    const r = await svc.createEvent({
      title: "Denver lunch",
      organizer: { name: "Pranav", phone: DENVER.organizer, venmo: "prnv1901" },
      friends: [
        { name: "Madhav", email: DENVER.madhav },
        { name: "Vyshak", email: DENVER.vyshak },
        { name: "Kevin", email: DENVER.kevin },
      ],
      time_slots: [
        { label: "Sun 12:30pm", starts_at: "2026-10-18T18:30:00.000Z" },
        { label: "Sun 1:30pm", starts_at: "2026-10-18T19:30:00.000Z" },
        { label: "Sat 12:30pm", starts_at: "2026-10-24T18:30:00.000Z" },
        { label: "Sat 1:30pm", starts_at: "2026-10-24T19:30:00.000Z" },
      ],
      budget_per_person: "30",
    });
    const id = r.event_id as string;
    // The real answers: a three-way tie between B, C and D.
    ok(await svc.recordPreferences({ event_id: id, person: "Pranav", slot_ids: ["B", "C", "D"] }));
    ok(await svc.recordPreferences({ event_id: id, person: "Vyshak", slot_ids: ["B", "C", "D"] }));
    ok(await svc.recordPreferences({ event_id: id, person: "Madhav", slot_ids: ["B"], dietary: ["nut allergy"] }));
    ok(await svc.recordPreferences({ event_id: id, person: "Kevin", slot_ids: ["C", "D"] }));
    return id;
  }

  it("asks whoever would miss out before locking a tied time", async () => {
    const id = await denverLunch();
    const check = ok(await svc.pickTime({ event_id: id }));
    expect(check).toMatchObject({
      decided: false,
      status: "check_shift",
      shift_deadline: "2026-10-17T18:30:00.000Z",
      ask_to_shift: [
        { name: "Madhav", email: DENVER.madhav, ask_about: [{ id: "C" }, { id: "D" }], current_answer: ["B"] },
        { name: "Kevin", email: DENVER.kevin, ask_about: [{ id: "B" }], current_answer: ["C", "D"] },
      ],
    });
    expect(check.reason).toMatch(/tie/);
    expect((check.ask_to_shift as { message: string }[])[1]!.message).toBe(
      "Quick one for Denver lunch: could Sun 1:30pm work for you after all? No worries if not.",
    );
    expect((check.ask_to_shift as { message: string }[])[0]!.message).toContain("Sat 12:30pm or Sat 1:30pm");
    expect((await store.get(id))?.chosenSlotId).toBeUndefined();
    expect((await svc.getStatus({ event_id: id })).next_action).toMatch(/Waiting on Madhav and Kevin about whether another time could work/);

    // Calling again before anyone answers still locks nothing.
    expect(ok(await svc.pickTime({ event_id: id }))).toMatchObject({ decided: false, status: "check_shift", ask_to_shift: [{ name: "Madhav" }, { name: "Kevin" }] });

    // Kevin can do Sunday after all.
    const kevin = ok(await svc.recordPreferences({ event_id: id, person: DENVER.kevin, slot_ids: ["B", "C", "D"] }));
    expect(kevin.waiting_on_shift).toEqual(["Madhav"]);

    // Past the reply deadline, only the people asked can still answer.
    at("2026-10-17T18:10:00.000Z");
    await svc.updateEvent({ event_id: id, by_phone: DENVER.organizer, reply_deadline: "2026-10-17T18:15:00.000Z" });
    at("2026-10-17T18:20:00.000Z");
    await expect(svc.recordPreferences({ event_id: id, person: "Vyshak", slot_ids: ["C"] })).rejects.toMatchObject({ code: "PLAN_LOCKED" });
    // Madhav says no: nothing changes, but the question is answered.
    const madhav = ok(await svc.recordPreferences({ event_id: id, person: "Madhav", slot_ids: ["B"] }));
    expect(madhav.waiting_on_shift).toEqual([]);

    const decided = ok(await svc.pickTime({ event_id: id }));
    expect(decided).toMatchObject({
      decided: true,
      status: "unanimous",
      slot: { id: "B", label: "Sun 1:30pm" },
      cant_make: [],
      asked_to_shift: ["Madhav", "Kevin"],
      party_size: 4,
    });
    expect(decided.tell_privately).toBeUndefined();
  });

  it("decides without asking when the organizer says to decide now", async () => {
    const id = await denverLunch();
    const r = ok(await svc.pickTime({ event_id: id, skip_shift_check: true }));
    expect(r).toMatchObject({ decided: true, status: "majority", tie_broken_by: "earliest", cant_make: ["Kevin"] });
    expect(r.asked_to_shift).toBeUndefined();
  });

  it("new time options start a fresh shift check", async () => {
    const id = await denverLunch();
    ok(await svc.pickTime({ event_id: id }));
    expect((await store.get(id))?.shiftCheck).toBeDefined();
    await svc.updateEvent({
      event_id: id,
      by_phone: DENVER.organizer,
      time_slots: [{ label: "Sat 2pm", starts_at: "2026-10-24T20:00:00.000Z" }],
    });
    expect((await store.get(id))?.shiftCheck).toBeUndefined();
  });

  async function denverSplit() {
    const id = await denverLunch();
    ok(await svc.pickTime({ event_id: id, skip_shift_check: true }));
    ok(
      await svc.setRestaurantOptions({
        event_id: id,
        options: [
          { name: "Spice Room", cuisine: "Indian", price_per_person: 25, notes: "nut-free kitchen" },
          { name: "Aloy Modern Thai", cuisine: "Thai", price_per_person: 25, notes: "nut-free options" },
        ],
      }),
    );
    expect((await store.get(id))?.stage).toBe("voting");
    const receipt = ok(await svc.addReceipt({ event_id: id, by_phone: DENVER.organizer, ...RECEIPT }));
    ok(await svc.setAttendees({ event_id: id, people: ["Pranav", "Madhav", "Vyshak", "Kevin"] }));
    return { id, receipt };
  }

  it("a receipt during voting says to drop the old timers", async () => {
    const { receipt } = await denverSplit();
    expect(receipt.next_action).toMatch(/^The restaurant vote for this dinner is over: cancel any nudge or deadline actions/);
  });

  it("refuses to split while anyone hasn't claimed, and warns when one person claims everything", async () => {
    const { id } = await denverSplit();
    const all = ok(await svc.recordClaims({ event_id: id, claim: "Pranav: 1, 2, 3, 4, 5" }));
    expect(all.warnings).toEqual([
      "Pranav claimed all 5 items. Before calculating, check with Pranav: did they share everything, or have it all to themselves? " +
        "Any item someone else also claims is split with Pranav. Madhav, Vyshak and Kevin still need to claim their own items.",
    ]);
    ok(await svc.recordClaims({ event_id: id, claim: "Kevin: 1, 3" }));
    ok(await svc.recordClaims({ event_id: id, claim: "Vyshak: 2" }));

    // Madhav's reply hasn't been recorded: no $0 share for him.
    await expect(svc.calculateShares({ event_id: id })).rejects.toMatchObject({
      code: "CLAIMS_PENDING",
      message: expect.stringContaining("3 of 4 have claimed their items; still waiting on Madhav."),
    });
    expect((await store.get(id))?.stage).toBe("claiming");

    const partial = ok(await svc.recordClaims({ event_id: id, claim: "Madhav: 4" }));
    expect(partial.warnings).toBeUndefined();
    const shares = ok(await svc.calculateShares({ event_id: id }));
    expect(shares.ask_organizer).toMatch(/^4 of 4 claimed\. Totals: /);
    const madhav = (shares.shares as { name: string; total_cents: number }[]).find((s) => s.name === "Madhav");
    expect(madhav?.total_cents).toBeGreaterThan(0);
  });

  it("points a receipt at the organizer's open dinner instead of starting a new one", async () => {
    const id = await denverLunch();
    const receiptOnly = {
      title: "Saffron Spoon",
      organizer: { name: "Pranav", phone: DENVER.organizer },
      friends: [{ name: "Madhav", email: DENVER.madhav }],
    };
    await expect(svc.createEvent(receiptOnly)).rejects.toMatchObject({
      code: "OPEN_DINNER",
      message: expect.stringContaining(`call add_receipt with event_id ${id}`),
    });
    const separate = ok(await svc.createEvent({ ...receiptOnly, separate_dinner: true }));
    expect(separate.event_id).not.toBe(id);
    // Planning a second dinner with times is still fine.
    ok(await svc.createEvent({ ...receiptOnly, title: "Next week", time_slots: [{ label: "Fri 7pm", starts_at: "2026-10-31T01:00:00.000Z" }] }));
  });
});
