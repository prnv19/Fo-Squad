import { describe, expect, it } from "vitest";
import type { DinnerEvent, Receipt } from "../types.js";
import { computeSplit } from "./engine.js";
import { buildSplitInput, nextItemNumber, validateReceipt } from "./receipt.js";

const luigis: Receipt = {
  id: "r1",
  items: [
    { number: 1, description: "Pizza", amountCents: 1800 },
    { number: 2, description: "Lasagna", amountCents: 2200 },
    { number: 3, description: "Wine", amountCents: 1200 },
    { number: 4, description: "Pasta", amountCents: 2000 },
    { number: 5, description: "Garlic bread", amountCents: 900 },
  ],
  subtotalCents: 8100,
  taxCents: 648,
  tipCents: 1620,
  feesCents: 0,
  discountCents: 0,
  totalCents: 10368,
  tipIncluded: false,
};

function event(overrides: Partial<DinnerEvent> = {}): DinnerEvent {
  return {
    id: "evt",
    title: "Luigi's",
    createdAt: "2026-10-17T00:00:00Z",
    updatedAt: "2026-10-17T00:00:00Z",
    stage: "claiming",
    organizerId: "pranav",
    people: [
      { id: "maya", name: "Maya", phone: "+15550000001", isOrganizer: false },
      { id: "jordan", name: "Jordan", phone: "+15550000002", isOrganizer: false },
      { id: "pranav", name: "Pranav", phone: "+15550000000", isOrganizer: true },
    ],
    timeSlots: [],
    nudgedIds: [],
    preferences: [],
    restaurantOptions: [],
    votes: [],
    receipts: [luigis],
    claims: [
      { personId: "maya", itemNumber: 1, weight: 1 },
      { personId: "maya", itemNumber: 5, weight: 1 },
      { personId: "jordan", itemNumber: 2, weight: 1 },
      { personId: "jordan", itemNumber: 3, weight: 1 },
      { personId: "jordan", itemNumber: 5, weight: 1 },
      { personId: "pranav", itemNumber: 4, weight: 1 },
      { personId: "pranav", itemNumber: 5, weight: 1 },
    ],
    treatedIds: [],
    unclaimedPolicy: "block",
    feesSplitEvenly: false,
    payments: [],
    ...overrides,
  };
}

const { id: _id, ...luigisNoId } = luigis;

describe("validateReceipt", () => {
  it("accepts the worked example", () => {
    expect(validateReceipt(luigisNoId)).toEqual({ ok: true });
  });

  it("flags items that don't add up to the subtotal, saying by how much", () => {
    const result = validateReceipt({ ...luigisNoId, items: luigis.items.slice(0, 4), subtotalCents: 7400 });
    expect(result).toEqual({
      ok: false,
      code: "ITEMS_SUBTOTAL_MISMATCH",
      message:
        "Line items add up to $72.00 but the receipt subtotal is $74.00 ($2.00 missing). Check for a missed item.",
      expectedCents: 7400,
      actualCents: 7200,
    });
  });

  it("explains an items overage differently from a shortfall", () => {
    const result = validateReceipt({ ...luigisNoId, subtotalCents: 8000, totalCents: 10268 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toBe(
      "Line items add up to $81.00 but the receipt subtotal is $80.00 ($1.00 too much). Check for a duplicated or misread item.",
    );
  });

  it("flags a total that doesn't match subtotal + tax + tip + fees - discount", () => {
    const result = validateReceipt({ ...luigisNoId, feesCents: 300, discountCents: 500, totalCents: 10368 });
    expect(result).toMatchObject({
      ok: false,
      code: "TOTAL_MISMATCH",
      expectedCents: 10368,
      actualCents: 10168,
    });
    expect(!result.ok && result.message).toBe(
      "The receipt total is $103.68 but subtotal $81.00 + tax $6.48 + tip $16.20 + fees $3.00 - discount $5.00 = $101.68 ($2.00 off). Check the tax, tip, fees and total.",
    );
  });

  it("rejects empty receipts, fractional cents and negative tax as INVALID_INPUT", () => {
    expect(validateReceipt({ ...luigisNoId, items: [] })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(validateReceipt({ ...luigisNoId, taxCents: 648.5 })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(
      validateReceipt({
        ...luigisNoId,
        items: [{ number: 1, description: "Pizza", amountCents: 0.5 }],
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(validateReceipt({ ...luigisNoId, taxCents: -1 })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(validateReceipt({ ...luigisNoId, discountCents: -1 })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("accepts comped items as negative lines", () => {
    const items = [...luigis.items, { number: 6, description: "Comped dessert", amountCents: -800 }];
    expect(validateReceipt({ ...luigisNoId, items, subtotalCents: 7300, totalCents: 9568 })).toEqual({ ok: true });
  });
});

describe("nextItemNumber", () => {
  it("continues numbering across receipts", () => {
    expect(nextItemNumber([])).toBe(1);
    expect(nextItemNumber([luigis])).toBe(6);
  });
});

describe("buildSplitInput", () => {
  it("turns the worked example event into the expected split", () => {
    const input = buildSplitInput(event());
    expect(input.extras).toEqual([
      { label: "tax", amountCents: 648, mode: "proportional" },
      { label: "tip", amountCents: 1620, mode: "proportional" },
    ]);
    expect(input.attendeeIds).toEqual(["maya", "jordan", "pranav"]);
    expect(input.expectedTotalCents).toBe(10368);
    const result = computeSplit(input);
    expect(result.ok && result.shares.map((s) => s.totalCents)).toEqual([2688, 4736, 2944]);
  });

  it("uses confirmed attendees and carries treats and policy", () => {
    const input = buildSplitInput(
      event({ attendeeIds: ["maya", "pranav"], treatedIds: ["maya"], unclaimedPolicy: "split_evenly" }),
    );
    expect(input.attendeeIds).toEqual(["maya", "pranav"]);
    expect(input.treatedIds).toEqual(["maya"]);
    expect(input.unclaimedPolicy).toBe("split_evenly");
  });

  it("credits a deposit back so the organizer is repaid and the split matches the full bill", () => {
    // $20 deposit paid at booking; the restaurant credited it on the receipt.
    const credited: Receipt = { ...luigis, discountCents: 2000, totalCents: 8368 };
    const e = event({
      receipts: [credited],
      booking: {
        restaurantName: "Luigi's",
        slotId: "C",
        startsAt: "2026-10-17T19:30:00-06:00",
        partySize: 3,
        depositCents: 2000,
      },
    });
    const input = buildSplitInput(e);
    expect(input.extras).toContainEqual({ label: "deposit", amountCents: 2000, mode: "proportional" });
    expect(input.extras).toContainEqual({ label: "discount", amountCents: -2000, mode: "proportional" });
    expect(input.expectedTotalCents).toBe(10368);
    const result = computeSplit(input);
    expect(result.ok && result.shares.map((s) => s.totalCents)).toEqual([2688, 4736, 2944]);
  });

  it("does not invent a second tip when the tip is already included", () => {
    const included: Receipt = { ...luigis, tipIncluded: true, tipCents: 1620 };
    const input = buildSplitInput(
      event({
        receipts: [included],
        booking: {
          restaurantName: "Luigi's",
          slotId: "C",
          startsAt: "2026-10-17T19:30:00-06:00",
          partySize: 12,
          autoGratuity: true,
        },
      }),
    );
    expect(input.extras.filter((e) => e.label === "tip")).toEqual([
      { label: "tip", amountCents: 1620, mode: "proportional" },
    ]);
    expect(input.expectedTotalCents).toBe(10368);
  });

  it("combines several receipts with continuous item numbers", () => {
    const second: Receipt = {
      id: "r2",
      items: [
        { number: 6, description: "Tiramisu", amountCents: 1000 },
        { number: 7, description: "Espresso", amountCents: 500 },
      ],
      subtotalCents: 1500,
      taxCents: 120,
      tipCents: 300,
      feesCents: 0,
      discountCents: 0,
      totalCents: 1920,
      tipIncluded: false,
    };
    const e = event({
      receipts: [luigis, second],
      claims: [
        ...event().claims,
        { personId: "maya", itemNumber: 6, weight: 1 },
        { personId: "pranav", itemNumber: 7, weight: 1 },
      ],
    });
    const input = buildSplitInput(e);
    expect(input.items.map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(input.extras).toEqual([
      { label: "tax", amountCents: 768, mode: "proportional" },
      { label: "tip", amountCents: 1920, mode: "proportional" },
    ]);
    expect(input.expectedTotalCents).toBe(12288);
    const result = computeSplit(input);
    expect(result.ok).toBe(true);
    expect(result.ok && result.shares.reduce((a, s) => a + s.totalCents, 0)).toBe(12288);
    expect(result.ok && result.shares.map((s) => s.subtotalCents)).toEqual([3100, 3700, 2800]);
  });

  it("splits fees evenly when the event says so", () => {
    const withFees: Receipt = { ...luigis, feesCents: 600, totalCents: 10968 };
    const input = buildSplitInput(event({ receipts: [withFees], feesSplitEvenly: true }));
    expect(input.extras).toContainEqual({ label: "fees", amountCents: 600, mode: "even" });
    const result = computeSplit(input);
    expect(result.ok && result.shares.map((s) => s.extrasCents)).toEqual([788, 1236, 844]);
  });
});
