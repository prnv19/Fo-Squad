import { describe, expect, it } from "vitest";
import type { Claim, LineItem, SplitInput } from "../types.js";
import { allocateLargestRemainder } from "./money.js";
import { computeSplit } from "./engine.js";

// The "trust but verify" receipt from docs/pivot-plan.md: shared items, an
// uneven 2/3 split, a $9.99 item four ways, and proportional tax and tip. We
// gave Fo the same receipt on 2026-10-17; its answer is pinned below.

const item = (number: number, description: string, amountCents: number): LineItem => ({
  number,
  description,
  amountCents,
});
const claim = (personId: string, itemNumber: number, weight = 1): Claim => ({
  personId,
  itemNumber,
  weight,
});

const people = ["alex", "bea", "cam", "dev"];

function trickyReceipt(): SplitInput {
  return {
    items: [
      item(1, "Burrata", 1400),
      item(2, "Margherita pizza", 2200),
      item(3, "Cacio e pepe", 1950),
      item(4, "Ribeye", 3475),
      item(5, "Kale salad", 1125),
      item(6, "Bottle of Chianti", 4200),
      item(7, "Tiramisu", 999),
    ],
    extras: [
      { label: "tax", amountCents: 1362, mode: "proportional" },
      { label: "tip", amountCents: 3070, mode: "proportional" },
    ],
    claims: [
      claim("alex", 1),
      claim("bea", 1),
      claim("cam", 1),
      claim("alex", 2, 2),
      claim("dev", 2, 1),
      claim("bea", 3),
      claim("cam", 4),
      claim("dev", 5),
      claim("alex", 6),
      claim("bea", 6),
      claim("cam", 6),
      claim("alex", 7),
      claim("bea", 7),
      claim("cam", 7),
      claim("dev", 7),
    ],
    attendeeIds: people,
    expectedTotalCents: 19781,
    unclaimedPolicy: "block",
  };
}

/** Fo's reply: exact proportional totals, then one largest-remainder pass. */
const foTotals: Record<string, number> = { alex: 4618, bea: 5240, cam: 7206, dev: 2717 };

/**
 * Reference split with no per-item rounding: the grand total allocated once by
 * each person's exact subtotal. Shares here are in thirds and quarters of a
 * cent, so subtotals times 12 are whole numbers.
 */
function exactReferenceTotals(input: SplitInput): Record<string, number> {
  const subtotal = input.items.reduce((sum, i) => sum + i.amountCents, 0);
  const extras = input.extras.reduce((sum, e) => sum + e.amountCents, 0);
  const exactSubtotals = people.map((id) =>
    input.items.reduce((sum, i) => {
      const onItem = input.claims.filter((c) => c.itemNumber === i.number);
      const total = onItem.reduce((w, c) => w + c.weight, 0);
      const mine = onItem.filter((c) => c.personId === id).reduce((w, c) => w + c.weight, 0);
      return sum + (i.amountCents * mine) / total;
    }, 0),
  );
  const totals = allocateLargestRemainder(
    subtotal + extras,
    exactSubtotals.map((s) => Math.round(s * 12)),
  );
  return Object.fromEntries(people.map((id, i) => [id, totals[i]]));
}

describe("Fo benchmark receipt", () => {
  it("the engine balances to the receipt total", () => {
    const result = computeSplit(trickyReceipt());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const totals = Object.fromEntries(result.shares.map((s) => [s.personId, s.totalCents]));
    expect(totals).toEqual({ alex: 4619, bea: 5241, cam: 7205, dev: 2716 });
    expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(19781);
  });

  it("Fo's answer is the penny-exact proportional split", () => {
    expect(exactReferenceTotals(trickyReceipt())).toEqual(foTotals);
  });

  it("the engine is within a cent of Fo for every person", () => {
    // The engine rounds each item's shares before adding them up, so the
    // per-item pennies can pile onto one person. Here everyone is off by one.
    const result = computeSplit(trickyReceipt());
    if (!result.ok) throw new Error("split failed");
    for (const share of result.shares) {
      expect(Math.abs(share.totalCents - foTotals[share.personId]!)).toBeLessThanOrEqual(1);
    }
  });
});
