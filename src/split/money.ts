import type { Cents } from "../types.js";

// "$1,026.50", "-$5", "$-5.00", ".5", "12". Commas must be proper thousands groups.
const DOLLAR_PATTERN = /^(-)?\$?(-)?(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d*))?$/;

/**
 * Parse a dollar amount to integer cents using string arithmetic only, so
 * 0.1 + 0.2 style float drift can never leak into a bill. Numbers are read
 * through their shortest round-trip string, which means 12.3 parses as 1230
 * but 0.30000000000000004 is rejected for having too many decimals.
 */
export function parseDollars(input: string | number): Cents {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new Error(`Amount must be a real number, got ${String(input)}.`);
    }
    // Exponent notation (1e21, 1e-7) is never a sensible dinner amount.
    const asString = String(input);
    if (/e/i.test(asString)) {
      throw new Error(`Amount ${asString} is out of range.`);
    }
    return parseDollars(asString);
  }
  if (typeof input !== "string") {
    throw new Error(`Amount must be a string or number, got ${typeof input}.`);
  }

  const raw = input.trim().replace(/\s+/g, "");
  const match = DOLLAR_PATTERN.exec(raw);
  if (raw === "" || !match) {
    throw new Error(`"${input}" is not a dollar amount. Use a format like 26.88 or $1,026.50.`);
  }
  const [, signBefore, signAfter, wholePart, fractionPart] = match;
  if (signBefore && signAfter) {
    throw new Error(`"${input}" has two minus signs.`);
  }
  if (wholePart === undefined && (fractionPart === undefined || fractionPart === "")) {
    throw new Error(`"${input}" has no digits.`);
  }
  if (fractionPart !== undefined && fractionPart.length > 2) {
    throw new Error(`"${input}" has more than 2 decimal places. Amounts must be whole cents.`);
  }

  const dollars = BigInt((wholePart ?? "0").replace(/,/g, ""));
  const cents = BigInt((fractionPart ?? "").padEnd(2, "0"));
  const magnitude = dollars * 100n + cents;
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`"${input}" is too large.`);
  }
  const value = Number(magnitude);
  // Avoid returning -0 for "-0.00".
  return signBefore || signAfter ? (value === 0 ? 0 : -value) : value;
}

/** "$26.88", "-$5.00", "$1,026.50". */
export function formatCents(c: Cents): string {
  assertSafeInteger(c, "formatCents");
  const negative = c < 0;
  const abs = Math.abs(c);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (abs % 100).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${cents}`;
}

/** "26.88" with no symbol or grouping, for URLs and machine-readable fields. */
export function centsToDecimalString(c: Cents): string {
  assertSafeInteger(c, "centsToDecimalString");
  const abs = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(abs / 100)}.${(abs % 100).toString().padStart(2, "0")}`;
}

/**
 * Split an integer total into parts proportional to `weights` that sum exactly
 * to the total (Hamilton / largest remainder method).
 *
 * Each part starts at floor(total * w / sum), computed in BigInt so there is no
 * float rounding. The leftover units go one each to the largest remainders,
 * ties to the lower index, so the result is fully deterministic.
 *
 * Negative totals (discounts) are allocated as the mirror image of the positive
 * case, so -$10 over three people is -334/-333/-333. All-zero weights fall back
 * to an even split. Weights must be non-negative safe integers.
 */
export function allocateLargestRemainder(totalCents: number, weights: number[]): number[] {
  assertSafeInteger(totalCents, "allocateLargestRemainder total");
  if (weights.length === 0) {
    if (totalCents === 0) return [];
    throw new Error("Cannot allocate a non-zero amount across zero parts.");
  }
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) {
      throw new Error(`Weights must be non-negative whole numbers, got ${w}.`);
    }
  }

  if (totalCents < 0) {
    return allocateLargestRemainder(-totalCents, weights).map((p) => (p === 0 ? 0 : -p));
  }

  const effective = weights.every((w) => w === 0) ? weights.map(() => 1) : weights;
  const total = BigInt(totalCents);
  const sum = effective.reduce((acc, w) => acc + BigInt(w), 0n);

  const parts: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;
  effective.forEach((w, index) => {
    const product = total * BigInt(w);
    const part = product / sum;
    parts.push(part);
    remainders.push({ index, remainder: product % sum });
    allocated += part;
  });

  let leftover = Number(total - allocated);
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (leftover === 0) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
    leftover -= 1;
  }

  return parts.map((p) => Number(p));
}

/** Even split with the same deterministic penny rule. */
export function splitEvenly(totalCents: number, count: number): number[] {
  return allocateLargestRemainder(totalCents, new Array<number>(count).fill(1));
}

function assertSafeInteger(value: number, where: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${where}: expected whole cents, got ${value}.`);
  }
}
