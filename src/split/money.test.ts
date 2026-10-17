import { describe, expect, it } from "vitest";
import { allocateLargestRemainder, centsToDecimalString, formatCents, parseDollars } from "./money.js";

describe("parseDollars", () => {
  it.each([
    ["26.88", 2688],
    ["$26.88", 2688],
    ["$1,026.5", 102650],
    ["1,234,567.89", 123456789],
    ["12", 1200],
    ["12.", 1200],
    [".5", 50],
    ["0.07", 7],
    [" $ 9.10 ", 910],
    ["-5.00", -500],
    ["-$5", -500],
    ["$-5.25", -525],
    ["-0.00", 0],
    [50, 5000],
    [12.3, 1230],
    [0.29, 29],
    [1.005e2, 10050],
    [-3.5, -350],
  ] as const)("parses %j as %i cents", (input, expected) => {
    expect(parseDollars(input)).toBe(expected);
  });

  it("never drifts on classic float traps", () => {
    expect(parseDollars(1.15)).toBe(115); // 1.15 * 100 === 114.99999999999999
    expect(parseDollars(4.35)).toBe(435);
    expect(parseDollars("19.99")).toBe(1999);
  });

  it.each([
    ["", /not a dollar amount/],
    ["abc", /not a dollar amount/],
    ["12.345", /more than 2 decimal/],
    ["1,02.00", /not a dollar amount/],
    ["$", /no digits/],
    [".", /no digits/],
    ["--5", /two minus signs/],
    ["-$-5", /two minus signs/],
    ["5 dollars", /not a dollar amount/],
    ["1e3", /not a dollar amount/],
  ])("rejects %j", (input, message) => {
    expect(() => parseDollars(input)).toThrow(message);
  });

  it("rejects non-finite and imprecise numbers", () => {
    expect(() => parseDollars(Number.NaN)).toThrow(/real number/);
    expect(() => parseDollars(Infinity)).toThrow(/real number/);
    expect(() => parseDollars(0.1 + 0.2)).toThrow(/more than 2 decimal/);
    expect(() => parseDollars(1e21)).toThrow(/out of range/);
  });
});

describe("formatCents", () => {
  it.each([
    [2688, "$26.88"],
    [-500, "-$5.00"],
    [102650, "$1,026.50"],
    [0, "$0.00"],
    [7, "$0.07"],
    [123456789, "$1,234,567.89"],
    [-1, "-$0.01"],
  ])("formats %i as %s", (cents, expected) => {
    expect(formatCents(cents)).toBe(expected);
  });

  it("rejects fractional cents", () => {
    expect(() => formatCents(1.5)).toThrow();
  });

  it("round-trips with parseDollars", () => {
    for (const c of [0, 1, 99, 100, 2688, 102650, -500]) {
      expect(parseDollars(formatCents(c))).toBe(c);
    }
  });

  it("has a plain decimal form for URLs", () => {
    expect(centsToDecimalString(2688)).toBe("26.88");
    expect(centsToDecimalString(102650)).toBe("1026.50");
    expect(centsToDecimalString(5)).toBe("0.05");
  });
});

describe("allocateLargestRemainder", () => {
  it("splits proportionally and sums exactly", () => {
    expect(allocateLargestRemainder(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocateLargestRemainder(2268, [2100, 3700, 2300])).toEqual([588, 1036, 644]);
    expect(allocateLargestRemainder(100, [1, 2])).toEqual([33, 67]);
  });

  it("gives leftover pennies to the largest remainders, ties to the lower index", () => {
    // 10 over [1,1,1,1]: 2.5 each, remainders tie, first two get the extra.
    expect(allocateLargestRemainder(10, [1, 1, 1, 1])).toEqual([3, 3, 2, 2]);
    // 10 over [3, 1, 2]: exact 5, 1.667, 3.333 -> 5, 2, 3.
    expect(allocateLargestRemainder(10, [3, 1, 2])).toEqual([5, 2, 3]);
  });

  it("mirrors negative totals", () => {
    expect(allocateLargestRemainder(-1000, [1, 1, 1])).toEqual([-334, -333, -333]);
    expect(allocateLargestRemainder(-100, [1, 2])).toEqual([-33, -67]);
  });

  it("falls back to an even split when all weights are zero", () => {
    expect(allocateLargestRemainder(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  it("gives nothing to zero-weight parts", () => {
    expect(allocateLargestRemainder(101, [0, 1, 1])).toEqual([0, 51, 50]);
  });

  it("handles zero totals and empty weights", () => {
    expect(allocateLargestRemainder(0, [1, 2])).toEqual([0, 0]);
    expect(allocateLargestRemainder(0, [])).toEqual([]);
    expect(() => allocateLargestRemainder(5, [])).toThrow();
  });

  it("rejects bad weights and fractional totals", () => {
    expect(() => allocateLargestRemainder(10, [-1, 2])).toThrow(/non-negative/);
    expect(() => allocateLargestRemainder(10, [1.5, 2])).toThrow(/whole/);
    expect(() => allocateLargestRemainder(10.5, [1])).toThrow(/whole cents/);
  });
});
