import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, normalizeEmail, tryNormalizeContact } from "./events/index.js";
import { FoSquadService, type ToolResult } from "./service.js";

// Same Saturday clock as service.test.ts: the default reply deadline is 20:00Z.
const T0 = "2026-10-17T18:00:00.000Z";

const EMAILS = {
  dana: "dana@acme.com",
  lee: "lee@acme.com",
  ravi: "ravi@acme.com",
  kim: "kim@acme.com",
};

const SLOTS = [
  { label: "Tue 12pm", starts_at: "2026-10-20T19:00:00.000Z" },
  { label: "Wed 12:30pm", starts_at: "2026-10-21T19:30:00.000Z" },
  { label: "Thu 12pm", starts_at: "2026-10-22T19:00:00.000Z" },
];

let now: Date;
let store: MemoryStore;
let svc: FoSquadService;

beforeEach(() => {
  now = new Date(T0);
  store = new MemoryStore();
  svc = new FoSquadService(store, () => now);
});

function ok(r: ToolResult): ToolResult {
  expect(r.ok).toBe(true);
  return r;
}

/** A work lunch run entirely over email; Dana organizes. */
async function createLunch() {
  const r = ok(
    await svc.createEvent({
      title: "Team lunch",
      organizer: { name: "Dana", email: "Dana Park <Dana@Acme.com>", venmo: "dana-p" },
      friends: [
        { name: "Lee", email: EMAILS.lee },
        { name: "Ravi", email: "RAVI@acme.com" },
        { name: "Kim", email: EMAILS.kim },
      ],
      time_slots: SLOTS,
    }),
  );
  return { r, id: r.event_id as string };
}

describe("email addresses", () => {
  it("normalizes header and mailto forms, keeps plus tags, and rejects junk", () => {
    expect(normalizeEmail("Maya Chen <Maya.Chen@Example.com>")).toBe("maya.chen@example.com");
    expect(normalizeEmail("mailto:sam@x.io")).toBe("sam@x.io");
    expect(normalizeEmail("me+maya@gmail.com")).not.toBe(normalizeEmail("me+jordan@gmail.com"));
    expect(() => normalizeEmail("maya at example dot com")).toThrow(/doesn't look like an email/);
    expect(() => normalizeEmail("maya@localhost")).toThrow(/doesn't look like an email/);
    expect(tryNormalizeContact("(555) 123-0001")).toBe("+15551230001");
    expect(tryNormalizeContact(" Lee@Acme.com ")).toBe("lee@acme.com");
  });
});

describe("a work lunch over email", () => {
  it("runs from invite to settled with every check done by email", async () => {
    const { r: created, id } = await createLunch();
    expect(created.people).toContainEqual({ id: "dana", name: "Dana", email: EMAILS.dana, channel: "email", is_organizer: true });
    expect(created.people).toContainEqual({ id: "ravi", name: "Ravi", email: EMAILS.ravi, channel: "email", is_organizer: false });
    expect(created.confirm_with_organizer).toBe(
      `I'll email Lee (${EMAILS.lee}), Ravi (${EMAILS.ravi}) and Kim (${EMAILS.kim}). Look right?`,
    );

    // A reply's From header finds the lunch and says who it is.
    const status = ok(await svc.getStatus({ email: "Ravi <ravi@acme.com>" }));
    expect(status).toMatchObject({ found: true, event_id: id, caller: { id: "ravi", is_organizer: false } });
    expect(status.organizer).toEqual({ id: "dana", name: "Dana", email: EMAILS.dana, channel: "email" });
    expect(status.pending).toContainEqual(expect.objectContaining({ id: "lee", email: EMAILS.lee, channel: "email" }));

    // People can be referred to by email anywhere a person is expected.
    for (const who of [EMAILS.dana, EMAILS.lee, EMAILS.ravi, EMAILS.kim]) {
      ok(await svc.recordPreferences({ event_id: id, person: who, slot_ids: ["B"] }));
    }
    expect(ok(await svc.pickTime({ event_id: id }))).toMatchObject({ decided: true, slot: { id: "B" } });
    ok(await svc.setRestaurantOptions({ event_id: id, options: [{ name: "Noodle Bar" }, { name: "Salad Co" }] }));
    for (const who of ["Dana", "Lee", "Ravi", "Kim"]) ok(await svc.recordVote({ event_id: id, person: who, option: "1" }));
    ok(await svc.tallyVotes({ event_id: id }));

    // Only the organizer's email can approve the booking.
    await expect(svc.confirmBooking({ event_id: id, by_email: EMAILS.lee, restaurant_name: "Noodle Bar" })).rejects.toMatchObject({
      code: "NOT_ORGANIZER",
    });
    ok(await svc.confirmBooking({ event_id: id, by_email: "DANA@acme.com", restaurant_name: "Noodle Bar" }));
    // After lunch: a receipt before the table time is refused.
    now = new Date("2026-10-23T00:00:00.000Z");

    ok(
      await svc.addReceipt({
        event_id: id,
        by_email: EMAILS.dana,
        items: [
          { description: "Ramen", amount: "16" },
          { description: "Udon", amount: "14" },
          { description: "Gyoza", amount: "8" },
          { description: "Tea", amount: "4" },
        ],
        subtotal: "42",
        tax: "3.36",
        tip: "8.40",
        total: "53.76",
      }),
    );
    ok(await svc.setAttendees({ event_id: id, people: [EMAILS.dana, EMAILS.lee, EMAILS.ravi] }));
    ok(await svc.recordClaims({ event_id: id, person: EMAILS.lee, items: [{ number: 1 }] }));
    ok(await svc.recordClaims({ event_id: id, claim: "Ravi: 2, 4" }));
    ok(await svc.recordClaims({ event_id: id, claim: "Dana: 3" }));
    const shares = ok(await svc.calculateShares({ event_id: id }));
    const messages = shares.messages as { name: string; email?: string; phone?: string; channel: string }[];
    expect(messages.map((m) => [m.name, m.email, m.channel])).toEqual([
      ["Lee", EMAILS.lee, "email"],
      ["Ravi", EMAILS.ravi, "email"],
    ]);
    expect(messages[0]?.phone).toBeUndefined();

    // Only the organizer's email sends the totals, which finishes the lunch.
    await expect(svc.sendTotals({ event_id: id, by_email: EMAILS.lee })).rejects.toMatchObject({ code: "NOT_ORGANIZER" });
    const done = ok(await svc.sendTotals({ event_id: id, by_email: "DANA@acme.com" }));
    expect(done).toMatchObject({ stage: "settled", delivered: false });
  });

  it("mixes texted and emailed people in one dinner", async () => {
    const r = ok(
      await svc.createEvent({
        title: "Client dinner",
        organizer: { name: "Pranav", phone: "555-000-1111", email: "pranav@acme.com" },
        friends: [
          { name: "Maya", phone: "5551230001" },
          { name: "Lee", email: EMAILS.lee },
        ],
        time_slots: SLOTS,
      }),
    );
    expect(r.confirm_with_organizer).toBe(`I'll text Maya (+15551230001), and email Lee (${EMAILS.lee}). Look right?`);
    const people = r.people as { id: string; channel: string; phone?: string; email?: string }[];
    expect(people.find((p) => p.id === "pranav")).toMatchObject({ phone: "+15550001111", email: "pranav@acme.com", channel: "text" });
    // The organizer can approve from either contact.
    const id = r.event_id as string;
    ok(await svc.updateEvent({ event_id: id, by_email: "pranav@acme.com", reply_deadline: "2026-10-18T12:00:00.000Z" }));
    ok(await svc.updateEvent({ event_id: id, by_phone: "5550001111", reply_deadline: "2026-10-18T13:00:00.000Z" }));
  });
});

describe("email edge cases", () => {
  it("needs a phone or an email for everyone", async () => {
    await expect(
      svc.createEvent({ title: "Lunch", organizer: { name: "Dana", email: EMAILS.dana }, friends: [{ name: "Lee" }] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Lee needs a phone number or an email address." });
    await expect(
      svc.createEvent({ title: "Lunch", organizer: { name: "Dana", email: "dana-at-acme" }, friends: [{ name: "Lee", email: EMAILS.lee }] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("Dana's email") });
  });

  it("refuses a shared email, or the organizer's own email for a friend", async () => {
    await expect(
      svc.createEvent({
        title: "Lunch",
        organizer: { name: "Dana", email: EMAILS.dana },
        friends: [
          { name: "Lee", email: EMAILS.lee },
          { name: "Lee B", email: "LEE@acme.com" },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("same email") });
    await expect(
      svc.createEvent({ title: "Lunch", organizer: { name: "Dana", email: EMAILS.dana }, friends: [{ name: "Lee", email: EMAILS.dana }] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("organizer's own email") });
  });

  it("wants exactly one of by_phone and by_email", async () => {
    const { id } = await createLunch();
    await expect(svc.updateEvent({ event_id: id, reply_deadline: "2026-10-18T12:00:00.000Z" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("by_phone for a text or by_email for an email"),
    });
    await expect(
      svc.updateEvent({ event_id: id, by_email: EMAILS.dana, by_phone: "5550001111", reply_deadline: "2026-10-18T12:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("not both") });
  });

  it("fixes and adds emails, and says unsubscribed for an emailed opt-out", async () => {
    const { id } = await createLunch();
    const r = ok(
      await svc.updateEvent({
        event_id: id,
        by_email: EMAILS.dana,
        fix_email: { person: "Kim", email: "kim.l@acme.com" },
        add_friends: [{ name: "Ana", email: "ana@acme.com" }],
      }),
    );
    expect(r.changes).toEqual(["Kim's email is now kim.l@acme.com.", "Added Ana."]);
    const out = ok(await svc.recordOptOut({ event_id: id, person: "ana@acme.com" }));
    expect(out.tell_organizer).toBe(`Ana unsubscribed, so I won't email them again about "Team lunch".`);
  });

  it("remembers concessions by email across lunches", async () => {
    const first = await createLunch();
    for (const who of ["Dana", "Lee", "Ravi"]) ok(await svc.recordPreferences({ event_id: first.id, person: who, slot_ids: ["A"] }));
    ok(await svc.recordPreferences({ event_id: first.id, person: "Kim", slot_ids: ["B"] }));
    const asked = ok(await svc.pickTime({ event_id: first.id, force: true }));
    expect(asked).toMatchObject({ decided: false, status: "check_shift", ask_to_shift: [{ name: "Kim", email: EMAILS.kim, channel: "email" }] });
    // Kim says no: same answer, but it still closes the question.
    ok(await svc.recordPreferences({ event_id: first.id, person: "Kim", slot_ids: ["B"] }));
    ok(await svc.pickTime({ event_id: first.id, force: true }));
    expect(await store.getConcessions()).toContainEqual(expect.objectContaining({ contact: EMAILS.kim, what: "time slot" }));
  });
});
