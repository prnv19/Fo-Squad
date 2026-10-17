import type {
  Cents,
  ItemShare,
  PersonShare,
  SplitError,
  SplitInput,
  SplitResult,
} from "../types.js";
import { allocateLargestRemainder, splitEvenly } from "./money.js";

/**
 * The split, per the plan:
 *  1. Integer cents only.
 *  2. Each item is split among its claimants by weight (largest remainder).
 *  3. Subtotal per person.
 *  4. Proportional extras (tax, tip, discount, deposit, fees) by subtotal;
 *     "even" extras (fees, when chosen) evenly.
 *  5. Treated people's totals move evenly onto everyone else.
 *  6. Shares must sum to the expected total, or we stop and flag it.
 *
 * Extras of the same mode are summed first and allocated once. Every person
 * then lands within one cent of their exact proportional share of the combined
 * extras; allocating tax and tip separately can push someone two cents off and
 * produce totals that differ from what a calculator gives. In the plan's worked
 * example both methods happen to agree ($22.68 of tax and tip is $5.88 /
 * $10.36 / $6.44), and the test suite pins those numbers.
 */
export function computeSplit(input: SplitInput): SplitResult {
  const fail = (error: SplitError): SplitResult => ({ ok: false, error });
  const invalid = (message: string) => fail({ code: "INVALID_INPUT", message });

  const { items, extras, claims, attendeeIds, expectedTotalCents } = input;

  if (attendeeIds.length === 0) return fail({ code: "NO_ATTENDEES" });
  if (new Set(attendeeIds).size !== attendeeIds.length) {
    return invalid("The attendee list has someone twice.");
  }
  if (items.length === 0) return invalid("There are no receipt items to split.");

  const itemByNumber = new Map<number, (typeof items)[number]>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.amountCents)) {
      return invalid(`Item ${item.number} has an amount that isn't whole cents.`);
    }
    if (itemByNumber.has(item.number)) {
      return invalid(`Item number ${item.number} appears on more than one line.`);
    }
    itemByNumber.set(item.number, item);
  }
  for (const extra of extras) {
    if (!Number.isSafeInteger(extra.amountCents)) {
      return invalid(`The ${extra.label} amount isn't whole cents.`);
    }
  }
  if (!Number.isSafeInteger(expectedTotalCents)) {
    return invalid("The expected total isn't whole cents.");
  }

  const attendeeIndex = new Map(attendeeIds.map((id, i) => [id, i]));

  const unknownItems = uniqueSorted(
    claims.filter((c) => !itemByNumber.has(c.itemNumber)).map((c) => c.itemNumber),
  );
  if (unknownItems.length > 0) return fail({ code: "UNKNOWN_ITEM", itemNumbers: unknownItems });

  const outsiders = [
    ...new Set(claims.filter((c) => !attendeeIndex.has(c.personId)).map((c) => c.personId)),
  ];
  if (outsiders.length > 0) return fail({ code: "NON_ATTENDEE_CLAIM", personIds: outsiders });

  // Weight per (item, person). Duplicate rows are rejected rather than summed:
  // record_claims replaces a person's claims, so a duplicate means a bug
  // upstream and silently doubling someone's portion would overcharge them.
  const weightsByItem = new Map<number, Map<string, number>>();
  for (const claim of claims) {
    if (!Number.isSafeInteger(claim.weight) || claim.weight < 1) {
      return invalid(
        `${claim.personId}'s portion of item ${claim.itemNumber} must be a whole number of 1 or more.`,
      );
    }
    const perPerson = weightsByItem.get(claim.itemNumber) ?? new Map<string, number>();
    if (perPerson.has(claim.personId)) {
      return invalid(`${claim.personId} has claimed item ${claim.itemNumber} twice.`);
    }
    perPerson.set(claim.personId, claim.weight);
    weightsByItem.set(claim.itemNumber, perPerson);
  }

  const unclaimed = items.filter((i) => !weightsByItem.has(i.number)).map((i) => i.number);
  if (unclaimed.length > 0) {
    if (input.unclaimedPolicy === "block") {
      return fail({ code: "UNCLAIMED_ITEMS", itemNumbers: unclaimed });
    }
    for (const n of unclaimed) {
      weightsByItem.set(n, new Map(attendeeIds.map((id) => [id, 1])));
    }
  }

  const treated = new Set(input.treatedIds ?? []);
  for (const id of treated) {
    if (!attendeeIndex.has(id)) {
      return invalid(`${id} is being treated but isn't on the attendee list.`);
    }
  }
  if (treated.size > 0 && treated.size === attendeeIds.length) {
    return invalid("Everyone is being treated, so nobody is left to pay.");
  }

  const shares: PersonShare[] = attendeeIds.map((personId) => ({
    personId,
    items: [],
    subtotalCents: 0,
    extrasCents: 0,
    treatCents: 0,
    totalCents: 0,
  }));
  const shareOf = (id: string): PersonShare => shares[attendeeIndex.get(id) as number] as PersonShare;

  // Items in receipt order; claimants in attendee order so penny ties always
  // favor the same people regardless of the order claims arrived in.
  for (const item of items) {
    const perPerson = weightsByItem.get(item.number) as Map<string, number>;
    const claimants = [...perPerson.keys()].sort(
      (a, b) => (attendeeIndex.get(a) as number) - (attendeeIndex.get(b) as number),
    );
    const weights = claimants.map((id) => perPerson.get(id) as number);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const parts = allocateLargestRemainder(item.amountCents, weights);

    claimants.forEach((id, i) => {
      const share = shareOf(id);
      const itemShare: ItemShare = {
        itemNumber: item.number,
        description: item.description,
        fraction: fraction(weights[i] as number, totalWeight),
        shareCents: parts[i] as number,
      };
      share.items.push(itemShare);
      share.subtotalCents += itemShare.shareCents;
    });
  }

  // A negative subtotal (someone claimed only a comped item) can't carry a
  // negative weight, so it simply attracts no proportional extras.
  const subtotals = shares.map((s) => Math.max(0, s.subtotalCents));
  const proportionalTotal = sumBy(extras.filter((e) => e.mode === "proportional"), (e) => e.amountCents);
  const evenTotal = sumBy(extras.filter((e) => e.mode === "even"), (e) => e.amountCents);
  const proportionalParts = allocateLargestRemainder(proportionalTotal, subtotals);
  const evenParts = splitEvenly(evenTotal, shares.length);

  shares.forEach((s, i) => {
    s.extrasCents = (proportionalParts[i] as number) + (evenParts[i] as number);
    s.totalCents = s.subtotalCents + s.extrasCents;
  });

  if (treated.size > 0) {
    const payers = shares.filter((s) => !treated.has(s.personId));
    let moved = 0;
    for (const s of shares) {
      if (!treated.has(s.personId)) continue;
      moved += s.totalCents;
      s.treatCents = -s.totalCents;
      s.totalCents = 0;
    }
    splitEvenly(moved, payers.length).forEach((part, i) => {
      const payer = payers[i] as PersonShare;
      payer.treatCents = part;
      payer.totalCents += part;
    });
  }

  const actual = sumBy(shares, (s) => s.totalCents);
  if (actual !== expectedTotalCents) {
    return fail({ code: "TOTAL_MISMATCH", expectedCents: expectedTotalCents, actualCents: actual });
  }

  return { ok: true, shares, totalCents: actual };
}

function fraction(weight: number, totalWeight: number): string {
  if (weight === totalWeight) return "1";
  const d = gcd(weight, totalWeight);
  return `${weight / d}/${totalWeight / d}`;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function sumBy<T>(list: T[], pick: (t: T) => Cents): Cents {
  return list.reduce((acc, t) => acc + pick(t), 0);
}

function uniqueSorted(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}
