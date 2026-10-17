import { describe, expect, it } from "vitest";
import type { Claim, LineItem, PersonShare, SplitInput, SplitResult } from "../types.js";
import { computeSplit } from "./engine.js";

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

function workedExample(): SplitInput {
  return {
    items: [
      item(1, "Pizza", 1800),
      item(2, "Lasagna", 2200),
      item(3, "Wine", 1200),
      item(4, "Pasta", 2000),
      item(5, "Garlic bread", 900),
    ],
    extras: [
      { label: "tax", amountCents: 648, mode: "proportional" },
      { label: "tip", amountCents: 1620, mode: "proportional" },
    ],
    claims: [
      claim("maya", 1),
      claim("maya", 5),
      claim("jordan", 2),
      claim("jordan", 3),
      claim("jordan", 5),
      claim("organizer", 4),
      claim("organizer", 5),
    ],
    attendeeIds: ["maya", "jordan", "organizer"],
    expectedTotalCents: 10368,
    unclaimedPolicy: "block",
  };
}

function expectOk(result: SplitResult): PersonShare[] {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.shares;
}

const byId = (shares: PersonShare[]) => Object.fromEntries(shares.map((s) => [s.personId, s]));
const totals = (shares: PersonShare[]) => shares.map((s) => s.totalCents);
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe("computeSplit: the plan's worked example", () => {
  it("matches the table to the cent", () => {
    const result = computeSplit(workedExample());
    const shares = expectOk(result);
    const s = byId(shares);

    expect([s.maya?.subtotalCents, s.maya?.extrasCents, s.maya?.totalCents]).toEqual([2100, 588, 2688]);
    expect([s.jordan?.subtotalCents, s.jordan?.extrasCents, s.jordan?.totalCents]).toEqual([
      3700, 1036, 4736,
    ]);
    expect([s.organizer?.subtotalCents, s.organizer?.extrasCents, s.organizer?.totalCents]).toEqual([
      2300, 644, 2944,
    ]);

    expect(sum(shares.map((x) => x.subtotalCents))).toBe(8100);
    expect(sum(shares.map((x) => x.extrasCents))).toBe(2268);
    expect(result.ok && result.totalCents).toBe(10368);
  });

  it("lists each person's items with fractions, in attendee order", () => {
    const shares = expectOk(computeSplit(workedExample()));
    expect(shares.map((s) => s.personId)).toEqual(["maya", "jordan", "organizer"]);
    expect(byId(shares).maya?.items).toEqual([
      { itemNumber: 1, description: "Pizza", fraction: "1", shareCents: 1800 },
      { itemNumber: 5, description: "Garlic bread", fraction: "1/3", shareCents: 300 },
    ]);
    expect(shares.every((s) => s.treatCents === 0)).toBe(true);
  });
});

describe("computeSplit: penny rounding", () => {
  it("splits $10 three ways as 334/333/333, extra penny to the first attendee", () => {
    const shares = expectOk(
      computeSplit({
        items: [item(1, "Fries", 1000)],
        extras: [],
        claims: [claim("c", 1), claim("a", 1), claim("b", 1)],
        attendeeIds: ["a", "b", "c"],
        expectedTotalCents: 1000,
        unclaimedPolicy: "block",
      }),
    );
    expect(totals(shares)).toEqual([334, 333, 333]);
    expect(shares[0]?.items[0]?.fraction).toBe("1/3");
  });

  it("allocates a $100 tip over equal subtotals as 3334/3333/3333", () => {
    const shares = expectOk(
      computeSplit({
        items: [item(1, "A", 1000), item(2, "B", 1000), item(3, "C", 1000)],
        extras: [{ label: "tip", amountCents: 10000, mode: "proportional" }],
        claims: [claim("a", 1), claim("b", 2), claim("c", 3)],
        attendeeIds: ["a", "b", "c"],
        expectedTotalCents: 13000,
        unclaimedPolicy: "block",
      }),
    );
    expect(shares.map((s) => s.extrasCents)).toEqual([3334, 3333, 3333]);
    expect(sum(totals(shares))).toBe(13000);
  });

  it("always sums to the total across many random receipts (seeded)", () => {
    // mulberry32: tiny deterministic PRNG so failures are reproducible.
    let seed = 0xf05;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

    for (let run = 0; run < 500; run++) {
      const people = Array.from({ length: int(1, 8) }, (_, i) => `p${i}`);
      const items = Array.from({ length: int(1, 12) }, (_, i) => item(i + 1, `item ${i + 1}`, int(1, 9999)));
      const claims: Claim[] = [];
      for (const it of items) {
        const shuffled = [...people].sort(() => rand() - 0.5);
        for (const p of shuffled.slice(0, int(1, people.length))) claims.push(claim(p, it.number, int(1, 3)));
      }
      const extras = [
        { label: "tax", amountCents: int(0, 2000), mode: "proportional" as const },
        { label: "tip", amountCents: int(0, 3000), mode: "proportional" as const },
        { label: "fees", amountCents: int(0, 999), mode: rand() < 0.5 ? ("even" as const) : ("proportional" as const) },
      ];
      const treatedIds = people.length > 1 && rand() < 0.3 ? [people[0] as string] : [];
      const expected = sum(items.map((i) => i.amountCents)) + sum(extras.map((e) => e.amountCents));

      const result = computeSplit({
        items,
        extras,
        claims,
        attendeeIds: people,
        expectedTotalCents: expected,
        unclaimedPolicy: "block",
        treatedIds,
      });
      const shares = expectOk(result);
      expect(sum(totals(shares))).toBe(expected);
      for (const s of shares) {
        expect(s.totalCents).toBeGreaterThanOrEqual(0);
        expect(s.totalCents).toBe(s.subtotalCents + s.extrasCents + s.treatCents);
        expect(sum(s.items.map((i) => i.shareCents))).toBe(s.subtotalCents);
      }
    }
  });
});

describe("computeSplit: edge cases", () => {
  it("splits by uneven weights (2 of 3 slices)", () => {
    const shares = expectOk(
      computeSplit({
        items: [item(1, "Pizza", 1800)],
        extras: [],
        claims: [claim("maya", 1, 2), claim("jordan", 1, 1)],
        attendeeIds: ["maya", "jordan"],
        expectedTotalCents: 1800,
        unclaimedPolicy: "block",
      }),
    );
    expect(totals(shares)).toEqual([1200, 600]);
    expect(shares.map((s) => s.items[0]?.fraction)).toEqual(["2/3", "1/3"]);
  });

  it("reduces fractions (2 of 4 is 1/2)", () => {
    const shares = expectOk(
      computeSplit({
        items: [item(1, "Pitcher", 2000)],
        extras: [],
        claims: [claim("a", 1, 2), claim("b", 1, 1), claim("c", 1, 1)],
        attendeeIds: ["a", "b", "c"],
        expectedTotalCents: 2000,
        unclaimedPolicy: "block",
      }),
    );
    expect(shares.map((s) => s.items[0]?.fraction)).toEqual(["1/2", "1/4", "1/4"]);
  });

  it("shares a discount proportionally as a negative extra", () => {
    const input = workedExample();
    input.extras.push({ label: "discount", amountCents: -1000, mode: "proportional" });
    input.expectedTotalCents = 9368;
    const shares = expectOk(computeSplit(input));
    // Net extras 1268 over subtotals 2100/3700/2300.
    expect(shares.map((s) => s.extrasCents)).toEqual([329, 579, 360]);
    expect(sum(totals(shares))).toBe(9368);
  });

  it("splits fees evenly when asked, and tax proportionally", () => {
    const shares = expectOk(
      computeSplit({
        items: [item(1, "Big", 9000), item(2, "Small", 1000)],
        extras: [
          { label: "tax", amountCents: 1000, mode: "proportional" },
          { label: "delivery fee", amountCents: 500, mode: "even" },
        ],
        claims: [claim("a", 1), claim("b", 2)],
        attendeeIds: ["a", "b"],
        expectedTotalCents: 11500,
        unclaimedPolicy: "block",
      }),
    );
    expect(shares.map((s) => s.extrasCents)).toEqual([900 + 250, 100 + 250]);
  });

  it("treats: the birthday person pays 0 and their share spreads evenly", () => {
    const input = workedExample();
    input.treatedIds = ["maya"];
    const shares = expectOk(computeSplit(input));
    const s = byId(shares);
    expect(s.maya?.totalCents).toBe(0);
    expect(s.maya?.treatCents).toBe(-2688);
    expect(s.maya?.subtotalCents).toBe(2100); // still shows what she had
    expect(s.jordan?.treatCents).toBe(1344);
    expect(s.organizer?.treatCents).toBe(1344);
    expect(s.jordan?.totalCents).toBe(4736 + 1344);
    expect(s.organizer?.totalCents).toBe(2944 + 1344);
  });

  it("treats: rejects treating everyone, and treating a non-attendee", () => {
    const all = workedExample();
    all.treatedIds = ["maya", "jordan", "organizer"];
    expect(computeSplit(all)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });

    const stranger = workedExample();
    stranger.treatedIds = ["alex"];
    expect(computeSplit(stranger)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("blocks on unclaimed items under the block policy", () => {
    const input = workedExample();
    input.claims = input.claims.filter((c) => c.itemNumber !== 3 && c.itemNumber !== 5);
    expect(computeSplit(input)).toEqual({
      ok: false,
      error: { code: "UNCLAIMED_ITEMS", itemNumbers: [3, 5] },
    });
  });

  it("splits unclaimed items evenly among all attendees under split_evenly", () => {
    const input = workedExample();
    input.claims = input.claims.filter((c) => c.itemNumber !== 3); // wine unclaimed
    input.unclaimedPolicy = "split_evenly";
    const shares = expectOk(computeSplit(input));
    const s = byId(shares);
    expect(s.maya?.subtotalCents).toBe(2100 + 400);
    expect(s.jordan?.subtotalCents).toBe(3700 - 1200 + 400);
    expect(s.maya?.items.find((i) => i.itemNumber === 3)?.fraction).toBe("1/3");
    expect(sum(totals(shares))).toBe(10368);
  });

  it("rejects claims from someone who didn't come", () => {
    const input = workedExample();
    input.claims.push(claim("alex", 1), claim("alex", 2));
    expect(computeSplit(input)).toEqual({
      ok: false,
      error: { code: "NON_ATTENDEE_CLAIM", personIds: ["alex"] },
    });
  });

  it("rejects claims on items that don't exist", () => {
    const input = workedExample();
    input.claims.push(claim("maya", 9), claim("jordan", 7), claim("maya", 9));
    expect(computeSplit(input)).toEqual({
      ok: false,
      error: { code: "UNKNOWN_ITEM", itemNumbers: [7, 9] },
    });
  });

  it("flags a total that doesn't match the expected total", () => {
    const input = workedExample();
    input.expectedTotalCents = 10468;
    expect(computeSplit(input)).toEqual({
      ok: false,
      error: { code: "TOTAL_MISMATCH", expectedCents: 10468, actualCents: 10368 },
    });
  });

  it("returns NO_ATTENDEES for an empty attendee list", () => {
    const input = workedExample();
    input.attendeeIds = [];
    expect(computeSplit(input)).toEqual({ ok: false, error: { code: "NO_ATTENDEES" } });
  });

  it("rejects bad weights, duplicate claims, and fractional cents", () => {
    const zeroWeight = workedExample();
    zeroWeight.claims[0] = claim("maya", 1, 0);
    expect(computeSplit(zeroWeight)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });

    const dup = workedExample();
    dup.claims.push(claim("maya", 1));
    expect(computeSplit(dup)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });

    const fractional = workedExample();
    fractional.items[0] = item(1, "Pizza", 1800.5);
    expect(computeSplit(fractional)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("is independent of claim order", () => {
    const a = computeSplit(workedExample());
    const reversed = workedExample();
    reversed.claims.reverse();
    expect(computeSplit(reversed)).toEqual(a);
  });
});
