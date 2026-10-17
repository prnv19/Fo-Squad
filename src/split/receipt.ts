import type { Cents, DinnerEvent, Receipt, SplitExtra, SplitInput } from "../types.js";
import { formatCents } from "./money.js";

export type ReceiptValidation =
  | { ok: true }
  | {
      ok: false;
      code: "ITEMS_SUBTOTAL_MISMATCH" | "TOTAL_MISMATCH";
      message: string;
      expectedCents: Cents;
      actualCents: Cents;
    }
  | { ok: false; code: "INVALID_INPUT"; message: string };

/**
 * Check a receipt before anyone gets a text: items must add up to the printed
 * subtotal, and subtotal + tax + tip + fees - discount must equal the total.
 * Messages are written for the organizer, since Fo relays them verbatim.
 */
export function validateReceipt(r: Omit<Receipt, "id">): ReceiptValidation {
  const invalid = (message: string): ReceiptValidation => ({
    ok: false,
    code: "INVALID_INPUT",
    message,
  });

  if (!Array.isArray(r.items) || r.items.length === 0) {
    return invalid("The receipt has no line items. Send the items so friends can claim them.");
  }

  const seenNumbers = new Set<number>();
  for (const item of r.items) {
    const label = item.description?.trim() || `item ${item.number}`;
    if (!Number.isSafeInteger(item.number) || item.number < 1) {
      return invalid(`"${label}" needs a positive whole item number.`);
    }
    if (seenNumbers.has(item.number)) {
      return invalid(`Item number ${item.number} is used twice.`);
    }
    seenNumbers.add(item.number);
    if (!Number.isSafeInteger(item.amountCents)) {
      return invalid(`"${label}" has an amount that isn't whole cents.`);
    }
  }

  const fields = {
    subtotal: r.subtotalCents,
    tax: r.taxCents,
    tip: r.tipCents,
    fees: r.feesCents,
    discount: r.discountCents,
    total: r.totalCents,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (!Number.isSafeInteger(value)) {
      return invalid(`The receipt ${name} isn't a whole number of cents.`);
    }
  }
  for (const name of ["tax", "tip", "fees", "discount"] as const) {
    if (fields[name] < 0) {
      return invalid(
        name === "discount"
          ? "Enter the discount as a positive amount; it is subtracted from the total."
          : `The receipt ${name} can't be negative.`,
      );
    }
  }

  const itemsSum = r.items.reduce((acc, item) => acc + item.amountCents, 0);
  if (itemsSum !== r.subtotalCents) {
    const diff = Math.abs(r.subtotalCents - itemsSum);
    const hint =
      itemsSum < r.subtotalCents
        ? `(${formatCents(diff)} missing). Check for a missed item.`
        : `(${formatCents(diff)} too much). Check for a duplicated or misread item.`;
    return {
      ok: false,
      code: "ITEMS_SUBTOTAL_MISMATCH",
      message: `Line items add up to ${formatCents(itemsSum)} but the receipt subtotal is ${formatCents(r.subtotalCents)} ${hint}`,
      expectedCents: r.subtotalCents,
      actualCents: itemsSum,
    };
  }

  const computedTotal = r.subtotalCents + r.taxCents + r.tipCents + r.feesCents - r.discountCents;
  if (computedTotal !== r.totalCents) {
    const parts = [`subtotal ${formatCents(r.subtotalCents)}`, `tax ${formatCents(r.taxCents)}`];
    parts.push(`${r.tipIncluded ? "included tip" : "tip"} ${formatCents(r.tipCents)}`);
    if (r.feesCents) parts.push(`fees ${formatCents(r.feesCents)}`);
    let formula = parts.join(" + ");
    if (r.discountCents) formula += ` - discount ${formatCents(r.discountCents)}`;
    const diff = formatCents(Math.abs(computedTotal - r.totalCents));
    return {
      ok: false,
      code: "TOTAL_MISMATCH",
      message: `The receipt total is ${formatCents(r.totalCents)} but ${formula} = ${formatCents(computedTotal)} (${diff} off). Check the tax, tip, fees and total.`,
      expectedCents: r.totalCents,
      actualCents: computedTotal,
    };
  }

  return { ok: true };
}

/** Next item number so a second receipt continues where the first left off. */
export function nextItemNumber(receipts: Receipt[]): number {
  let max = 0;
  for (const receipt of receipts) {
    for (const item of receipt.items) max = Math.max(max, item.number);
  }
  return max + 1;
}

/**
 * Flatten an event's receipts, booking and claims into one SplitInput.
 *
 * Tips: the tip is whatever is on the receipt(s). When `tipIncluded` or the
 * booking has auto gratuity, that line already is the tip, so nothing extra is
 * ever invented here.
 *
 * Deposit assumption: `booking.depositCents` was paid by the organizer up front,
 * and the restaurant credited it, so the receipt total is already net of the
 * deposit (Fo enters the credit as part of `discountCents`, or the printed
 * total simply excludes it). The real cost of dinner is receipt total + deposit,
 * and the organizer is out of pocket for all of it. We add the deposit back as
 * a positive proportional extra so everyone shares the full cost fairly and the
 * organizer is repaid for the deposit too.
 */
export function buildSplitInput(event: DinnerEvent): SplitInput {
  const items = event.receipts.flatMap((r) => r.items);
  const sum = (pick: (r: Receipt) => Cents) =>
    event.receipts.reduce((acc, r) => acc + pick(r), 0);

  const tax = sum((r) => r.taxCents);
  const tip = sum((r) => r.tipCents);
  const fees = sum((r) => r.feesCents);
  const discount = sum((r) => r.discountCents);
  const deposit = event.booking?.depositCents ?? 0;

  const extras: SplitExtra[] = [];
  if (tax) extras.push({ label: "tax", amountCents: tax, mode: "proportional" });
  if (tip) extras.push({ label: "tip", amountCents: tip, mode: "proportional" });
  if (fees) {
    extras.push({
      label: "fees",
      amountCents: fees,
      mode: event.feesSplitEvenly ? "even" : "proportional",
    });
  }
  if (discount) extras.push({ label: "discount", amountCents: -discount, mode: "proportional" });
  if (deposit) extras.push({ label: "deposit", amountCents: deposit, mode: "proportional" });

  const input: SplitInput = {
    items,
    extras,
    claims: event.claims,
    attendeeIds: event.attendeeIds ?? event.people.map((p) => p.id),
    expectedTotalCents: sum((r) => r.totalCents) + deposit,
    unclaimedPolicy: event.unclaimedPolicy,
  };
  if (event.treatedIds.length > 0) input.treatedIds = event.treatedIds;
  return input;
}
