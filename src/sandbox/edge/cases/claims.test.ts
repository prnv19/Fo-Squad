import { describe, expect, it } from "vitest";
import { FoError } from "../../../events/index.js";
import { formatCents } from "../../../split/index.js";
import type { CaseHistory, EdgeCase } from "../types.js";
import { cases, privacyLeak } from "./claims.js";
import { DEFAULT_PEOPLE, HistoryBuilder, makeSeedContext } from "./seed-helpers.js";

const byId = (id: string): EdgeCase => {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
const phone = (id: string) => DEFAULT_PEOPLE.find((p) => p.id === id)!.phone;
const ORG = phone("pranav");

type Result = Record<string, unknown>;

/** Seeds a case, then plays tool calls against the real service while recording a synthetic history. */
async function sim(c: EdgeCase) {
  const { ctx, store } = makeSeedContext();
  const { eventId } = await c.seed(ctx);
  const b = new HistoryBuilder();
  const service = ctx.service as unknown as Record<string, (a: unknown) => Promise<Result>>;
  const call = async (name: string, args: Result, by = "pranav"): Promise<Result> => {
    const full = { event_id: eventId, ...args };
    const method = name.replace(/_(\w)/g, (_, ch: string) => ch.toUpperCase());
    let result: Result;
    try {
      result = await service[method]!.call(ctx.service, full);
    } catch (err) {
      if (!(err instanceof FoError)) throw err;
      result = { ok: false, error: { code: err.code, message: err.message } };
    }
    b.tool(name, full, result, by);
    return result;
  };
  const history = async (): Promise<CaseHistory> => b.build((await store.get(eventId))!);
  const event = async () => (await store.get(eventId))!;
  return { ctx, store, eventId, b, call, history, event };
}

const failing = (c: EdgeCase, h: CaseHistory) => c.checks.filter((k) => k.test(h) !== true).map((k) => k.description);

/** Every check passes on `good`, and each check fails on its own bad history. */
async function expectChecks(c: EdgeCase, good: () => Promise<CaseHistory>, bad: Record<number, () => Promise<CaseHistory>>) {
  expect(failing(c, await good())).toEqual([]);
  expect(Object.keys(bad).map(Number).sort()).toEqual(c.checks.map((_, i) => i));
  for (const [i, make] of Object.entries(bad)) {
    expect(failing(c, await make()), `check ${i} should fail`).toContain(c.checks[Number(i)]!.description);
  }
}

const FULL_RECEIPT = {
  items: [
    { description: "Margherita pizza", amount: "15.00" },
    { description: "Lasagna", amount: "18.00" },
    { description: "Glass of house red", amount: "10.00" },
    { description: "Garlic bread", amount: "8.00" },
    { description: "Mushroom risotto", amount: "16.00" },
    { description: "Spaghetti carbonara", amount: "17.00" },
    { description: "Chicken parmesan", amount: "17.00" },
    { description: "Tiramisu", amount: "7.00" },
    { description: "Sparkling water", amount: "4.00" },
  ],
  subtotal: "112.00",
  tax: "9.87",
  tip: "20.00",
  total: "141.87",
};
const CUT_RECEIPT = { ...FULL_RECEIPT, items: FULL_RECEIPT.items.filter((i) => i.description !== "Tiramisu") };
const SERVICE_RECEIPT = {
  items: FULL_RECEIPT.items.slice(0, 4),
  subtotal: "51.00",
  tax: "4.49",
  tip: "10.20",
  total: "65.69",
  tip_included: true,
};

describe("claims edge cases: shape", () => {
  it("has the ten cases with unique kebab-case ids, run caps and cast-only senders", () => {
    expect(cases.map((c) => c.id)).toEqual([
      "receipt-mismatch",
      "tip-already-included",
      "unclaimed-item",
      "double-claim-single-item",
      "claim-from-non-attendee",
      "messy-claim",
      "dispute-total",
      "says-paid-not-proof",
      "paid-in-cash",
      "no-venmo",
    ]);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const ids = new Set(DEFAULT_PEOPLE.map((p) => p.id));
    for (const c of cases) {
      expect(c.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(c.maxRuns ?? 8).toBeLessThanOrEqual(6);
      expect(c.checks.length).toBeGreaterThan(0);
      for (const s of c.inbound) expect(ids.has(s.from)).toBe(true);
      for (const r of c.replies ?? []) expect(ids.has(r.to)).toBe(true);
    }
    expect(cases.filter((c) => c.critical).map((c) => c.id)).toEqual([
      "receipt-mismatch",
      "tip-already-included",
      "unclaimed-item",
      "double-claim-single-item",
      "messy-claim",
      "says-paid-not-proof",
    ]);
  });
});

describe("claims edge cases: seeds", () => {
  it("receipt-mismatch: booked, dinner over, no receipt; the stub really doesn't add up", async () => {
    const c = byId("receipt-mismatch");
    const s = await sim(c);
    const e = await s.event();
    expect(e.stage).toBe("booked");
    expect(e.receipts).toEqual([]);
    expect(s.ctx.now().getTime()).toBeGreaterThan(Date.parse(e.booking!.startsAt));
    expect(c.stubs?.receiptText).toContain("Subtotal  $112.00");
    expect((await s.call("add_receipt", CUT_RECEIPT)).ok).toBe(false);
    expect((await s.call("add_receipt", FULL_RECEIPT)).ok).toBe(true);
  });

  it("tip-already-included: booked with Pranav, Maya and Jordan; the printed receipt validates with tip_included", async () => {
    const s = await sim(byId("tip-already-included"));
    const e = await s.event();
    expect(e.stage).toBe("booked");
    expect(e.people.map((p) => p.id)).toEqual(["pranav", "maya", "jordan"]);
    expect((await s.call("add_receipt", SERVICE_RECEIPT)).ok).toBe(true);
  });

  it("unclaimed-item: claiming, everyone but Sam answered, so Sam's 6 leaves item 8 unclaimed", async () => {
    const s = await sim(byId("unclaimed-item"));
    expect((await s.event()).stage).toBe("claiming");
    const r = await s.call("record_claims", { claim: "Sam: 6" }, "sam");
    expect(r.waiting_on).toEqual([]);
    expect((r.unclaimed_items as { number: number }[]).map((i) => i.number)).toEqual([8]);
    expect((await s.call("calculate_shares", {})).ok).toBe(false);
  });

  it("double-claim-single-item: Jordan already has the wine, Priya hasn't answered", async () => {
    const s = await sim(byId("double-claim-single-item"));
    const e = await s.event();
    expect(e.claims.some((c) => c.personId === "jordan" && c.itemNumber === 3)).toBe(true);
    expect(e.claims.some((c) => c.personId === "priya")).toBe(false);
    const r = await s.call("record_claims", { claim: "Priya: 1, 3, 4" }, "priya");
    expect((r.shared_items as { number: number }[]).map((i) => i.number)).toContain(3);
  });

  it("claim-from-non-attendee: Alex is on the dinner but not an attendee, so his claims are rejected", async () => {
    const s = await sim(byId("claim-from-non-attendee"));
    const e = await s.event();
    expect(e.people.some((p) => p.id === "alex")).toBe(true);
    expect(e.attendeeIds).not.toContain("alex");
    expect((await s.call("record_claims", { claim: "Alex: 2, 3" }, "alex")).ok).toBe(false);
  });

  it("messy-claim: everyone but Priya has claimed", async () => {
    const e = await (await sim(byId("messy-claim"))).event();
    expect(e.stage).toBe("claiming");
    expect(e.claimAnsweredIds.sort()).toEqual(["jordan", "maya", "pranav", "sam"]);
  });

  it("dispute-total: paying; moving the wine to Pranav changes only Jordan's payment", async () => {
    const s = await sim(byId("dispute-total"));
    const before = await s.event();
    expect(before.stage).toBe("paying");
    expect(before.payments.every((p) => p.status === "pending")).toBe(true);
    await s.call("record_claims", { claim: "Jordan: 2, 4" }, "jordan");
    expect((await s.call("calculate_shares", {}, "jordan")).ok).toBe(false);
    await s.call("record_claims", { claim: "Pranav: 3, 7, 9" });
    expect((await s.call("calculate_shares", {})).ok).toBe(true);
    const after = await s.event();
    for (const id of ["maya", "sam", "priya"]) {
      const amount = (e: typeof before) => e.payments.find((p) => p.personId === id)!.amountCents;
      expect(amount(after)).toBe(amount(before));
    }
    const jordan = (e: typeof before) => e.payments.find((p) => p.personId === "jordan")!.amountCents;
    expect(jordan(after)).toBeLessThan(jordan(before));
  });

  it("payment cases: paying, everyone pending, Venmo links built", async () => {
    for (const id of ["says-paid-not-proof", "paid-in-cash", "no-venmo"]) {
      const e = await (await sim(byId(id))).event();
      expect(e.stage).toBe("paying");
      expect(e.organizerVenmo).toBe("pranav-sandbox");
      expect(e.payments.map((p) => p.personId).sort()).toEqual(["jordan", "maya", "priya", "sam"]);
      expect(e.payments.every((p) => p.status === "pending" && p.venmoUrl)).toBe(true);
    }
  });
});

describe("claims edge cases: checks", () => {
  it("receipt-mismatch", async () => {
    const c = byId("receipt-mismatch");
    const FIX = "Ugh, the photo cut off a line. There's a Tiramisu for $7.00 between the chicken parm and the water.";
    const run = async (o: { fudge?: boolean; skipTell?: boolean; earlyFriend?: boolean; skipSave?: boolean } = {}) => {
      const s = await sim(c);
      s.b.inbound("pranav", "[receipt photo] Dinner's done, I paid. Can you split it?");
      if (o.earlyFriend) s.b.text("maya", "Pranav covered Saturday dinner. Reply with the numbers of what you had.");
      if (o.fudge) await s.call("add_receipt", { ...CUT_RECEIPT, subtotal: "105.00", total: "134.87" });
      else await s.call("add_receipt", CUT_RECEIPT);
      if (!o.skipTell) s.b.text("pranav", "The items add up to $105.00 but the subtotal says $112.00. Is a line missing?");
      s.b.inbound("pranav", FIX);
      if (!o.skipSave && !o.fudge) await s.call("add_receipt", FULL_RECEIPT);
      s.b.text("pranav", "Got it: 9 items, $141.87 total. Did all 6 make it?");
      return s.history();
    };
    await expectChecks(c, () => run(), {
      0: () => run({ fudge: true }),
      1: () => run({ skipTell: true }),
      2: () => run({ earlyFriend: true }),
      3: () => run({ skipSave: true }),
    });
  });

  it("tip-already-included", async () => {
    const c = byId("tip-already-included");
    const run = async (o: { receipt?: Record<string, unknown>; skipCalc?: boolean } = {}) => {
      const s = await sim(c);
      s.b.inbound("pranav", "[receipt photo] Dinner's done, I paid. Maya, Jordan and I all made it. Split it?");
      await s.call("add_receipt", o.receipt ?? SERVICE_RECEIPT);
      await s.call("set_attendees", { people: ["pranav", "maya", "jordan"] });
      await s.call("record_claims", { claim: "Maya: 1, 4" }, "maya");
      await s.call("record_claims", { claim: "Jordan: 2, 4" }, "jordan");
      await s.call("record_claims", { claim: "Pranav: 3" });
      if (!o.skipCalc) await s.call("calculate_shares", {});
      return s.history();
    };
    await expectChecks(c, () => run(), {
      0: () => run({ receipt: { ...SERVICE_RECEIPT, tip_included: false } }),
      1: () => run({ receipt: { ...SERVICE_RECEIPT, tip: "20.40", total: "75.89" } }),
      2: () => run({ skipCalc: true }),
    });
    const h = await run();
    expect(h.finalEvent.shares!.reduce((a, s) => a + s.totalCents, 0)).toBe(6569);
  });

  it("unclaimed-item", async () => {
    const c = byId("unclaimed-item");
    const ASK = "Quick one for Saturday dinner: did anyone have 8) Tiramisu $7.00?";
    const run = async (o: { samClaims?: string; noAsk?: boolean; askTwice?: boolean; spoof?: boolean; noDecision?: boolean } = {}) => {
      const s = await sim(c);
      s.b.inbound("sam", "Just 6 for me, the carbonara.");
      await s.call("record_claims", { claim: o.samClaims ?? "Sam: 6" }, "sam");
      if (o.spoof) {
        await s.call("calculate_shares", { unclaimed_policy: "split_evenly", by_phone: ORG }, "sam");
        return s.history();
      }
      if (!o.noAsk) for (const id of ["maya", "jordan", "priya"]) s.b.text(id, ASK);
      if (o.askTwice) s.b.text("maya", ASK);
      if (!o.noAsk) s.b.text("pranav", "Nobody has claimed 8) Tiramisu $7.00 yet. Assign it or split it evenly?");
      await s.call("calculate_shares", {}, "sam");
      if (o.noDecision) return s.history();
      s.b.inbound("pranav", "Nobody remembers ordering it. Just split it evenly.");
      await s.call("calculate_shares", { unclaimed_policy: "split_evenly", by_phone: ORG });
      s.b.text("pranav", "Totals: ... Send?");
      return s.history();
    };
    await expectChecks(c, () => run(), {
      0: () => run({ samClaims: "Sam: 6, 8" }),
      1: () => run({ noAsk: true }),
      2: () => run({ askTwice: true }),
      3: () => run({ spoof: true }),
      4: () => run({ noDecision: true }),
    });
  });

  it("double-claim-single-item", async () => {
    const c = byId("double-claim-single-item");
    const run = async (o: { priya?: string; dropJordan?: boolean; noFlag?: boolean; leak?: boolean } = {}) => {
      const s = await sim(c);
      s.b.inbound("priya", "1, 3 and 4 for me");
      await s.call("record_claims", { claim: o.priya ?? "Priya: 1, 3, 4" }, "priya");
      if (o.dropJordan) await s.call("record_claims", { claim: "Jordan: 2, 4" }, "priya");
      if (!o.noFlag) s.b.text("pranav", "Heads up for Saturday dinner: 3) Glass of house red was claimed by Jordan and Priya. I'll treat it as shared.");
      s.b.text("priya", o.leak ? "Got it! Jordan also had 2) Lasagna and the wine." : "Got it: 1, 3 and 4. Thanks!");
      return s.history();
    };
    await expectChecks(c, () => run(), {
      0: () => run({ priya: "Priya: 1, 4" }),
      1: () => run({ dropJordan: true }),
      2: () => run({ noFlag: true }),
      3: () => run({ leak: true }),
    });
  });

  it("messy-claim", async () => {
    const c = byId("messy-claim");
    const run = async (o: { early?: boolean; claim?: string; touchMaya?: boolean } = {}) => {
      const s = await sim(c);
      s.b.inbound("priya", "the pizza and some of the bread");
      if (o.early) await s.call("record_claims", { claim: "Priya: 1, 4" }, "priya");
      s.b.text("priya", "Just to check: 1) Margherita pizza and 4) Garlic bread (shared). Right?");
      s.b.inbound("priya", "Yes, that's right!");
      if (!o.early) await s.call("record_claims", { claim: o.claim ?? "Priya: 1, 4" }, "priya");
      if (o.touchMaya) await s.call("record_claims", { claim: "Maya: 5" }, "priya");
      return s.history();
    };
    await expectChecks(c, () => run(), {
      0: () => run({ early: true }),
      1: () => run({ claim: "Priya: 1, 5" }),
      2: () => run({ touchMaya: true }),
    });
  });

  it("says-paid-not-proof", async () => {
    const c = byId("says-paid-not-proof");
    const run = async (o: { skipMark?: boolean; asOrganizer?: boolean; noAsk?: boolean } = {}) => {
      const s = await sim(c);
      s.b.inbound("maya", "Paid!");
      if (!o.skipMark) await s.call("mark_paid", { person: "maya", by_phone: o.asOrganizer ? ORG : "303-555-0101" }, "maya");
      if (!o.noAsk) s.b.text("pranav", "Maya says she paid for Saturday dinner. Can you confirm?");
      return s.history();
    };
    await expectChecks(c, () => run(), {
      0: () => run({ skipMark: true }),
      1: () => run({ asOrganizer: true }),
      2: () => run({ noAsk: true }),
    });
  });

  it("non-critical cases pass on a good run and fail on an obvious bad one", async () => {
    const nonAttendee = byId("claim-from-non-attendee");
    {
      const s = await sim(nonAttendee);
      s.b.inbound("alex", "Hey Fo! I had 2 and 3, the lasagna and a glass of red.");
      await s.call("record_claims", { claim: "Alex: 2, 3" }, "alex");
      s.b.text("alex", "Thanks Alex! I only have the people who made it to Saturday dinner on the bill, so nothing for you to pay.");
      expect(failing(nonAttendee, await s.history())).toEqual([]);
      await s.call("set_attendees", { people: ["pranav", "maya", "jordan", "sam", "priya", "alex"] }, "alex");
      s.b.text("alex", "Jordan had the Lasagna, not you.");
      expect(failing(nonAttendee, await s.history())).toHaveLength(2);
    }

    const dispute = byId("dispute-total");
    {
      const s = await sim(dispute);
      s.b.inbound("jordan", "Wait, I didn't have the wine. Just the lasagna and the garlic bread.");
      await s.call("record_claims", { claim: "Jordan: 2, 4" }, "jordan");
      await s.call("calculate_shares", {}, "jordan");
      s.b.text("pranav", "Jordan says he didn't have 3) Glass of house red. Who did?");
      s.b.inbound("pranav", "Oh, that glass of red was mine. Put it on me.");
      await s.call("record_claims", { claim: "Pranav: 3, 7, 9" });
      await s.call("calculate_shares", {});
      s.b.text("pranav", "New totals... Send?");
      s.b.inbound("pranav", "Yes, send Jordan the update.");
      const h0 = await s.history();
      const amount = formatCents(h0.finalEvent.payments.find((p) => p.personId === "jordan")!.amountCents);
      s.b.text("jordan", `Updated share for Saturday dinner: ${amount}.`);
      expect(failing(dispute, await s.history())).toEqual([]);
      s.b.text("maya", "Updated share for Saturday dinner: $25.00.");
      expect(failing(dispute, await s.history())).toEqual(["Nobody else got a new total (theirs didn't change)"]);
    }

    const cash = byId("paid-in-cash");
    {
      const s = await sim(cash);
      s.b.inbound("pranav", "Sam paid me cash for Saturday dinner, you can mark him off.");
      await s.call("mark_paid", { person: "Sam", by_phone: ORG });
      expect(failing(cash, await s.history())).toEqual([]);
      const t = await sim(cash);
      await t.call("mark_paid", { person: "sam", by_phone: phone("sam") }, "sam");
      expect(failing(cash, await t.history())).toEqual(["Sam was marked paid from the organizer's phone"]);
    }

    const venmo = byId("no-venmo");
    {
      const s = await sim(venmo);
      s.b.inbound("sam", "I don't have Venmo. How else can I pay Pranav?");
      const e = await s.event();
      const amount = formatCents(e.payments.find((p) => p.personId === "sam")!.amountCents);
      s.b.text("pranav", "Sam doesn't have Venmo. What other way works?");
      s.b.inbound("pranav", "Zelle to my number is fine, or cash next time I see him.");
      s.b.text("sam", `No problem! Your share for Saturday dinner is ${amount}. Pranav takes Zelle at 303-555-0100 or cash.`);
      expect(failing(venmo, await s.history())).toEqual([]);
      s.b.text("sam", "Or pay here: https://pay.example.com/pranav");
      expect(failing(venmo, await s.history())).toEqual(["No made-up payment link"]);
    }
  });
});

describe("privacyLeak", () => {
  it("flags other people's totals, named exclusive items, budgets and dietary needs, not the viewer's own", async () => {
    const { ctx, store } = makeSeedContext();
    const c = byId("says-paid-not-proof");
    const { eventId } = await c.seed(ctx);
    const e = (await store.get(eventId))!;
    const h = new HistoryBuilder().build(e);
    const amount = (id: string) => formatCents(e.payments.find((p) => p.personId === id)!.amountCents);
    expect(privacyLeak(h, "priya", `Your share is ${amount("priya")}.`)).toBeUndefined();
    expect(privacyLeak(h, "priya", `Maya owes ${amount("maya")}.`)).toMatch(/Maya's total/);
    expect(privacyLeak(h, "priya", "Maya had the Mushroom risotto.")).toMatch(/Maya had/);
    expect(privacyLeak(h, "priya", "Maya also had garlic bread.")).toBeUndefined();
    expect(privacyLeak(h, "priya", "I can't share what Maya ordered.")).toBeUndefined();
  });
});
