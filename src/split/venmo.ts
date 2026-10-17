import type { Cents, PersonShare } from "../types.js";
import { centsToDecimalString, formatCents } from "./money.js";

// The plan says to verify the current Venmo link format on a real phone before
// the demo. Both formats live here so a fix is a one-line change.
// {handle}, {amount} ("26.88") and {note} are substituted already URL-encoded.
export const VENMO_WEB_URL_TEMPLATE = "https://venmo.com/{handle}?txn=pay&amount={amount}&note={note}";
export const VENMO_APP_URL_TEMPLATE =
  "venmo://paycharge?txn=pay&recipients={handle}&amount={amount}&note={note}";

export interface VenmoLink {
  webUrl: string;
  appUrl: string;
}

export function buildVenmoLink(args: { handle: string; amountCents: Cents; note: string }): VenmoLink {
  const handle = args.handle.trim().replace(/^@/, "");
  if (!handle) throw new Error("A Venmo handle is required to build a pay link.");
  if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0) {
    throw new Error(`A Venmo pay link needs a positive amount, got ${args.amountCents} cents.`);
  }

  // encodeURIComponent rather than URLSearchParams: "+" only means a space in
  // form encoding and can show up literally in the note, while %20 is universal.
  const fill = (template: string) =>
    template
      .replace("{handle}", encodeURIComponent(handle))
      .replace("{amount}", centsToDecimalString(args.amountCents))
      .replace("{note}", encodeURIComponent(args.note));

  return { webUrl: fill(VENMO_WEB_URL_TEMPLATE), appUrl: fill(VENMO_APP_URL_TEMPLATE) };
}

/**
 * The private text Fo sends one person. Privacy: it only mentions this
 * person's own items and total, never anyone else's, and never names who is
 * being treated.
 */
export function buildShareMessage(args: {
  eventTitle: string;
  organizerName: string;
  share: PersonShare;
  link?: string;
  organizerHandle?: string;
  /** How to describe the extras line. Default "tax and tip". */
  extrasLabel?: string;
}): string {
  const { eventTitle, organizerName, share, link } = args;
  const amount = formatCents(share.totalCents);

  const parts = share.items.map((i) =>
    i.fraction === "1" ? i.description : `${i.fraction} ${i.description}`,
  );
  if (share.extrasCents !== 0) parts.push(args.extrasLabel ?? "tax and tip");
  if (share.treatCents > 0) parts.push("your part of tonight's treat");
  const breakdown = parts.length > 0 ? ` (${parts.join(", ")})` : "";

  if (share.totalCents === 0) {
    return `You're all set for ${eventTitle}: nothing to pay. Thanks for coming!`;
  }
  if (share.totalCents < 0) {
    return `For ${eventTitle}, ${organizerName} owes you ${formatCents(-share.totalCents)}${breakdown}.`;
  }

  const lead = `Your share for ${eventTitle} is ${amount}${breakdown}.`;
  if (link) return `${lead} Pay ${organizerName} here: ${link}`;
  const handle = args.organizerHandle?.trim().replace(/^@/, "");
  if (handle) return `${lead} Send ${amount} to ${organizerName} on Venmo (@${handle}).`;
  return `${lead} Send ${amount} to ${organizerName}.`;
}
