import type { Claim, LineItem } from "../types.js";

export type ParsedClaimReply =
  | { ok: true; name: string; items: { number: number; weight: number }[] }
  | { ok: false; message: string };

const NONE_WORDS = new Set(["none", "nothing", "no items", "-"]);
const FORMAT_HINT = 'Use the format "Maya: 1, 4" (or "Maya: 1, 4x2" for two portions of item 4).';

/**
 * Parse the fixed claim format Fo sends to record_claims:
 *   "Maya: 1, 4" | "Maya: 1 and 4" | "maya:1,4x2" | "Maya: none"
 * Fo/Claude normalizes messy replies into this format first, so anything else
 * is rejected with a message Fo can act on rather than guessed at.
 */
export function parseClaimReply(text: string): ParsedClaimReply {
  const colon = text.indexOf(":");
  if (colon === -1) {
    return { ok: false, message: `Missing "name:" before the item numbers. ${FORMAT_HINT}` };
  }
  const name = text.slice(0, colon).trim();
  if (!name) {
    return { ok: false, message: `Missing the person's name. ${FORMAT_HINT}` };
  }

  const body = text.slice(colon + 1).trim();
  if (NONE_WORDS.has(body.toLowerCase())) {
    return { ok: true, name, items: [] };
  }
  if (!body) {
    return {
      ok: false,
      message: `No items listed for ${name}. Send "${name}: none" if they had nothing.`,
    };
  }

  // Glue "4 x 2" into "4x2" so whitespace can act as a separator below.
  const normalized = body.replace(/(\d)\s*[x×*]\s*(\d)/gi, "$1x$2");
  const tokens = normalized
    .split(/\s*(?:,|;|&|\+|\band\b|\s)\s*/i)
    .map((t) => t.trim())
    .filter((t) => t !== "");

  const items: { number: number; weight: number }[] = [];
  const seen = new Set<number>();
  for (const token of tokens) {
    if (/^-\d/.test(token)) {
      return { ok: false, message: `Item numbers can't be negative ("${token}").` };
    }
    const match = /^#?(\d+)(?:x(\d+))?$/i.exec(token);
    if (!match) {
      return { ok: false, message: `Couldn't read "${token}" as an item number. ${FORMAT_HINT}` };
    }
    const number = Number(match[1]);
    const weight = match[2] === undefined ? 1 : Number(match[2]);
    if (number === 0) {
      return { ok: false, message: "Item numbers start at 1; there is no item 0." };
    }
    if (weight === 0) {
      return {
        ok: false,
        message: `Item ${number} has a portion of 0. Leave it out instead, or use 1 or more.`,
      };
    }
    if (!Number.isSafeInteger(number) || !Number.isSafeInteger(weight)) {
      return { ok: false, message: `"${token}" is too large.` };
    }
    if (seen.has(number)) {
      return {
        ok: false,
        message: `Item ${number} is listed twice. For a bigger portion use "${number}x2".`,
      };
    }
    seen.add(number);
    items.push({ number, weight });
  }

  return { ok: true, name, items };
}

export interface ClaimAnalysis {
  /** Items no attendee has claimed yet. */
  unclaimedItemNumbers: number[];
  /** Items with more than one claimant, to flag to the organizer (may be a double claim). */
  sharedItems: { itemNumber: number; claimantIds: string[] }[];
  /** Claimed item numbers that aren't on any receipt. */
  unknownItemNumbers: number[];
  /** Claimants who aren't confirmed attendees. */
  nonAttendeeIds: string[];
  /** Attendees who haven't answered yet. */
  pendingAttendeeIds: string[];
}

/**
 * Status of the claiming round, for get_status and record_claims responses.
 *
 * Someone who replied "none" has no claim rows, so claims alone can't tell
 * them apart from someone who hasn't replied. Pass `answeredIds` (tracked by
 * the service layer) to count them as answered.
 *
 * Unclaimed and shared items only count claims that computeSplit would accept
 * (known item, confirmed attendee), so the flags match what the split will do.
 */
export function analyzeClaims(
  items: LineItem[],
  claims: Claim[],
  attendeeIds: string[],
  answeredIds: string[] = [],
): ClaimAnalysis {
  const itemNumbers = new Set(items.map((i) => i.number));
  const attendees = new Set(attendeeIds);

  const unknown = new Set<number>();
  const nonAttendees = new Set<string>();
  const claimantsByItem = new Map<number, string[]>();
  const claimed = new Set<string>();

  for (const claim of claims) {
    const knownItem = itemNumbers.has(claim.itemNumber);
    const isAttendee = attendees.has(claim.personId);
    if (!knownItem) unknown.add(claim.itemNumber);
    if (!isAttendee) nonAttendees.add(claim.personId);
    if (isAttendee) claimed.add(claim.personId);
    if (knownItem && isAttendee) {
      const list = claimantsByItem.get(claim.itemNumber) ?? [];
      if (!list.includes(claim.personId)) list.push(claim.personId);
      claimantsByItem.set(claim.itemNumber, list);
    }
  }

  const answered = new Set(answeredIds);
  return {
    unclaimedItemNumbers: items
      .map((i) => i.number)
      .filter((n) => !claimantsByItem.has(n)),
    sharedItems: items
      .filter((i) => (claimantsByItem.get(i.number)?.length ?? 0) > 1)
      .map((i) => ({ itemNumber: i.number, claimantIds: claimantsByItem.get(i.number) ?? [] })),
    unknownItemNumbers: [...unknown].sort((a, b) => a - b),
    nonAttendeeIds: [...nonAttendees],
    pendingAttendeeIds: attendeeIds.filter((id) => !claimed.has(id) && !answered.has(id)),
  };
}
