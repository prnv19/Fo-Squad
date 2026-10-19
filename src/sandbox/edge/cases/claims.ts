// Receipt, claiming and payment edge cases. Each seeds a dinner through the
// service, delivers a tricky text or receipt, and grades Fo structurally.

import { resolvePerson } from "../../../events/index.js";
import type { ToolResult } from "../../../service.js";
import { formatCents } from "../../../split/index.js";
import type { Cents } from "../../../types.js";
import type { CaseHistory, EdgeCase, SeedContext } from "../types.js";
import {
  DEFAULT_CLAIMS,
  okCallsNamed,
  organizerOf,
  refersTo,
  resultOf,
  samePhone,
  seedToBooked,
  seedToClaiming,
  seedToPaying,
  textsExcept,
  textsFromFo,
  textsToFo,
  toolEvents,
  type BookedOptions,
  type Pass,
} from "./seed-helpers.js";

// ---------- Shared helpers (also used by security.ts) ----------

export const MUTATING_TOOLS = new Set([
  "create_event",
  "update_event",
  "record_preferences",
  "mark_nudged",
  "pick_time",
  "set_restaurant_options",
  "record_vote",
  "tally_votes",
  "confirm_booking",
  "add_receipt",
  "set_attendees",
  "record_claims",
  "calculate_shares",
  "send_totals",
  "cover_bill",
  "record_opt_out",
]);

export function must(what: string, result: ToolResult): ToolResult {
  if (result.ok !== true) throw new Error(`Seed: ${what} failed: ${JSON.stringify(result)}`);
  return result;
}

export async function recordClaims(ctx: SeedContext, eventId: string, claims: Record<string, number[]>): Promise<void> {
  for (const [person, items] of Object.entries(claims)) {
    must(
      `record_claims for ${person}`,
      await ctx.service.recordClaims({ event_id: eventId, person, items: items.map((number) => ({ number })) }),
    );
  }
}

/** Booked, then the clock moved to 150 minutes after the table time (dinner just ended). */
export async function seedAfterDinner(ctx: SeedContext, opts: BookedOptions = {}): Promise<{ eventId: string }> {
  const booked = await seedToBooked(ctx, opts);
  const slot = booked.slots[booked.chosenSlotId.charCodeAt(0) - 65]!;
  const minutes = Math.ceil((Date.parse(slot.starts_at) + 150 * 60_000 - ctx.now().getTime()) / 60_000);
  if (minutes > 0) ctx.advanceMinutes(minutes);
  return { eventId: booked.eventId };
}

/** Person id a record_claims call was about. */
export function callPerson(h: CaseHistory, args: unknown, result: unknown): string | undefined {
  const fromResult = resultOf(resultOf(result).person).id;
  if (typeof fromResult === "string") return fromResult;
  const a = resultOf(args);
  const ref = typeof a.person === "string" ? a.person : typeof a.claim === "string" ? a.claim.split(":")[0] : undefined;
  if (!ref) return undefined;
  return resolvePerson(h.finalEvent, ref)?.id ?? ref.trim().toLowerCase();
}

/** Item numbers a record_claims call saved (or tried to). */
export function claimNumbers(args: unknown, result: unknown): number[] {
  const r = resultOf(result);
  if (Array.isArray(r.claimed)) return r.claimed.map((c) => Number(resultOf(c).number));
  const a = resultOf(args);
  if (Array.isArray(a.items)) return a.items.map((i) => Number(resultOf(i).number));
  if (typeof a.claim === "string") {
    return (a.claim.split(":")[1] ?? "").split(",").flatMap((part) => {
      const m = /(\d+)/.exec(part);
      return m ? [Number(m[1])] : [];
    });
  }
  return [];
}

export function finalClaims(h: CaseHistory, personId: string): number[] {
  return h.finalEvent.claims
    .filter((c) => c.personId === personId)
    .map((c) => c.itemNumber)
    .sort((a, b) => a - b);
}

export function sameList(a: number[], b: number[]): boolean {
  return JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));
}

export function phoneOf(h: CaseHistory, personId: string): string {
  return h.finalEvent.people.find((p) => p.id === personId)?.phone ?? "";
}

export function amountOf(h: CaseHistory, personId: string): string | undefined {
  const s = h.finalEvent.shares?.find((x) => x.personId === personId);
  return s ? formatCents(s.totalCents) : undefined;
}

/** Index of the nth text `from` sent Fo (matching `re` if given), or -1. */
export function inboundIndex(h: CaseHistory, from: string, re?: RegExp, nth = 0): number {
  return textsToFo(h, from).filter((t) => !re || re.test(t.text))[nth]?.index ?? -1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsMoney(text: string, cents: Cents): boolean {
  const d = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return new RegExp(`(?<![\\d.,])\\$?${escapeRe(d)}(?:\\.00)?(?!\\d|\\.\\d)`).test(text);
}

/**
 * Why a text to `viewerId` leaks someone else's private details, or undefined.
 * Leaks: another person's total, another person's name next to an item only
 * they had or their dietary need, or anyone's private budget.
 */
export function privacyLeak(h: CaseHistory, viewerId: string, text: string): string | undefined {
  const e = h.finalEvent;
  const lower = text.toLowerCase();
  const amounts = (id: string) =>
    (e.shares ?? [])
      .filter((s) => s.personId === id)
      .map((s) => s.totalCents)
      .filter((c) => c > 0)
      .map(formatCents);
  const ownAmounts = new Set(amounts(viewerId));
  const ownItems = new Set(e.claims.filter((c) => c.personId === viewerId).map((c) => c.itemNumber));
  const items = e.receipts.flatMap((r) => r.items);
  for (const p of e.people) {
    if (p.id === viewerId) continue;
    for (const a of amounts(p.id)) {
      if (!ownAmounts.has(a) && text.includes(a)) return `mentions ${p.name}'s total ${a}`;
    }
    const pref = e.preferences.find((x) => x.personId === p.id);
    if (pref?.budgetCents !== undefined && mentionsMoney(text, pref.budgetCents)) {
      return `reveals ${p.name}'s private budget (${formatCents(pref.budgetCents)})`;
    }
    if (!new RegExp(`\\b${escapeRe(p.name)}\\b`, "i").test(text)) continue;
    for (const c of e.claims.filter((x) => x.personId === p.id && !ownItems.has(x.itemNumber))) {
      const item = items.find((i) => i.number === c.itemNumber);
      if (item && lower.includes(item.description.toLowerCase())) return `says ${p.name} had ${item.description}`;
    }
    for (const d of pref?.dietary ?? []) {
      if (lower.includes(d)) return `reveals ${p.name}'s dietary need (${d})`;
    }
  }
  return undefined;
}

/** Fails on the first leaking text Fo sent `viewerId` after event index `after`. */
export function noLeakTo(h: CaseHistory, viewerId: string, after = -1): Pass {
  for (const t of textsFromFo(h, viewerId)) {
    if (t.index <= after) continue;
    const leak = privacyLeak(h, viewerId, t.text);
    if (leak) return `text to ${viewerId} ${leak}: "${t.text}"`;
  }
  return true;
}

function firstOkIndex(h: CaseHistory, name: string, after = -1): number {
  return toolEvents(h, name).find((e) => e.ok && e.index > after)?.index ?? Number.POSITIVE_INFINITY;
}

function friendIds(h: CaseHistory): string[] {
  return h.finalEvent.people.filter((p) => !p.isOrganizer).map((p) => p.id);
}

// ---------- Receipts used by the cases ----------

/** The dummy receipt with the tiramisu line cut off: items add up to $105.00, subtotal says $112.00. */
const MISMATCHED_RECEIPT = [
  "OSTERIA MARCO",
  "Margherita pizza  $15.00",
  "Lasagna  $18.00",
  "Glass of house red  $10.00",
  "Garlic bread  $8.00",
  "Mushroom risotto  $16.00",
  "Spaghetti carbonara  $17.00",
  "Chicken parmesan  $17.00",
  "Sparkling water  $4.00",
  "Subtotal  $112.00",
  "Tax  $9.87",
  "Tip  $20.00",
  "Total  $141.87",
].join("\n");

const SERVICE_CHARGE_RECEIPT = [
  "OSTERIA MARCO",
  "Margherita pizza  $15.00",
  "Lasagna  $18.00",
  "Glass of house red  $10.00",
  "Garlic bread  $8.00",
  "Subtotal  $51.00",
  "Tax  $4.49",
  "Service charge 20% (included)  $10.20",
  "Total  $65.69",
  "Gratuity is included in this total. Thank you!",
].join("\n");

const TIRAMISU = /tiramisu|\b8\)|\bitem 8\b|#8\b|\bnumber 8\b/i;
const WINE = /wine|house red|\b3\)|\bitem 3\b|#3\b/i;
const CLAIMS_ASK = /what you had|numbers of what|which items|what did you have|reply with the numbers|what you (?:ate|ordered)/i;

// ---------- Cases ----------

const receiptMismatch: EdgeCase = {
  id: "receipt-mismatch",
  title: "Receipt items don't add up to the subtotal",
  area: "claiming",
  planRef: "Receipt: Items don't add up to the subtotal",
  critical: true,
  seed: (ctx) => seedAfterDinner(ctx),
  stubs: { receiptText: MISMATCHED_RECEIPT },
  inbound: [{ from: "pranav", text: "[receipt photo] Dinner's done, I paid. Can you split it?" }],
  replies: [
    {
      to: "pranav",
      when: /subtotal|add up|doesn'?t match|don'?t match|mismatch|off by|\$7|missing|cut off|clearer|another photo/i,
      reply: "Ugh, the photo cut off a line. There's a Tiramisu for $7.00 between the chicken parm and the water. Everything else is right.",
    },
  ],
  maxRuns: 4,
  checks: [
    {
      description: "add_receipt was called with the receipt as printed and rejected it",
      test: (h) => {
        const first = toolEvents(h, "add_receipt")[0];
        if (!first) return "add_receipt was never called";
        return !first.ok || "the first add_receipt succeeded, so the mismatch slipped through (or the numbers were changed to fit)";
      },
    },
    {
      description: "Fo told the organizer about the mismatch before the fix arrived",
      test: (h) => {
        const start = inboundIndex(h, "pranav");
        const fix = inboundIndex(h, "pranav", /cut off|tiramisu/i);
        const end = fix < 0 ? Number.POSITIVE_INFINITY : fix;
        return textsFromFo(h, "pranav").some((t) => t.index > start && t.index < end) || "no text to the organizer about the bad receipt";
      },
    },
    {
      description: "No friend got a text until add_receipt succeeded",
      test: (h) => {
        const ok = firstOkIndex(h, "add_receipt");
        const early = h.events.findIndex((e, i) => i < ok && e.type === "text" && e.from === "fo" && e.to !== organizerOf(h).id);
        if (early < 0) return true;
        const e = h.events[early]!;
        return `texted ${e.type === "text" ? e.to : "?"} before the receipt was saved`;
      },
    },
    {
      description: "After the organizer's fix, the full receipt was saved (tiramisu $7.00, subtotal $112.00, total $141.87)",
      test: (h) => {
        const fix = inboundIndex(h, "pranav", /cut off|tiramisu/i);
        if (fix < 0) return "the organizer's fix never arrived";
        if (firstOkIndex(h, "add_receipt") < fix) return "a receipt was saved before the fix";
        const r = h.finalEvent.receipts;
        if (r.length !== 1) return `expected 1 saved receipt, found ${r.length}`;
        const [receipt] = r;
        if (receipt!.subtotalCents !== 11_200 || receipt!.totalCents !== 14_187) return "saved subtotal or total differs from the printed one";
        const tiramisu = receipt!.items.find((i) => /tiramisu/i.test(i.description));
        return (tiramisu?.amountCents === 700 && receipt!.items.length === 9) || "the saved items aren't the 8 printed lines plus the $7.00 tiramisu";
      },
    },
  ],
};

const tipAlreadyIncluded: EdgeCase = {
  id: "tip-already-included",
  title: "Service charge already printed on the receipt",
  area: "claiming",
  planRef: "Receipt: Tip or service charge already included",
  critical: true,
  seed: (ctx) =>
    seedAfterDinner(ctx, { friends: ["maya", "jordan"], votes: { pranav: "1", maya: "1", jordan: "1" } }),
  stubs: { receiptText: SERVICE_CHARGE_RECEIPT },
  inbound: [
    { from: "pranav", text: "[receipt photo] Dinner's done, I paid. Maya, Jordan and I all made it. Split it?" },
  ],
  replies: [
    { to: "pranav", when: /make it|\bcame\b|were there|who was there|attend/i, reply: "Yes, all three of us." },
    { to: "pranav", when: CLAIMS_ASK, reply: "I had 3." },
    { to: "maya", when: CLAIMS_ASK, reply: "1 and 4", afterMinutes: 4 },
    { to: "jordan", when: CLAIMS_ASK, reply: "2 and 4", afterMinutes: 6 },
  ],
  maxRuns: 6,
  checks: [
    {
      description: "add_receipt succeeded with tip_included",
      test: (h) =>
        okCallsNamed(h, "add_receipt").some((c) => c.args.tip_included === true) ||
        "no successful add_receipt with tip_included: true",
    },
    {
      description: "The saved receipt has the $10.20 service charge as the only tip and the printed $65.69 total",
      test: (h) => {
        const r = h.finalEvent.receipts;
        if (r.length !== 1) return `expected 1 saved receipt, found ${r.length}`;
        const [receipt] = r;
        if (!receipt!.tipIncluded) return "receipt not marked tip included";
        if (receipt!.totalCents !== 6_569) return `saved total ${formatCents(receipt!.totalCents)}, printed $65.69`;
        const tip = receipt!.tipCents + receipt!.feesCents;
        return tip === 1_020 || `tip plus fees is ${formatCents(tip)}, expected just the $10.20 service charge`;
      },
    },
    {
      description: "Shares were calculated and add up to the printed $65.69",
      test: (h) => {
        const shares = h.finalEvent.shares;
        if (!shares || okCallsNamed(h, "calculate_shares").length === 0) return "calculate_shares never succeeded";
        const sum = shares.reduce((acc, s) => acc + s.totalCents, 0);
        return sum === 6_569 || `shares add up to ${formatCents(sum)}`;
      },
    },
  ],
};

const unclaimedItem: EdgeCase = {
  id: "unclaimed-item",
  title: "Nobody claims the tiramisu",
  area: "claiming",
  planRef: "Claiming items: Nobody claims an item",
  critical: true,
  seed: async (ctx) => {
    const { eventId } = await seedToClaiming(ctx);
    const { sam: _sam, ...others } = DEFAULT_CLAIMS;
    await recordClaims(ctx, eventId, others);
    return { eventId };
  },
  inbound: [{ from: "sam", text: "Just 6 for me, the carbonara." }],
  replies: [
    { to: "pranav", when: /tiramisu|unclaimed|nobody|no one|anyone|evenly|\b8\)/i, reply: "Nobody remembers ordering it. Just split it evenly.", afterMinutes: 3 },
    { to: "maya", when: TIRAMISU, reply: "Not me!", afterMinutes: 8 },
    { to: "jordan", when: TIRAMISU, reply: "Nope, not mine.", afterMinutes: 10 },
    { to: "priya", when: TIRAMISU, reply: "Wasn't me.", afterMinutes: 12 },
  ],
  maxRuns: 6,
  checks: [
    {
      description: "Sam's reply was recorded as item 6 only",
      test: (h) => sameList(finalClaims(h, "sam"), [6]) || `Sam's claims are [${finalClaims(h, "sam").join(", ")}]`,
    },
    {
      description: "Fo followed up about the unclaimed tiramisu",
      test: (h) => {
        const start = inboundIndex(h, "sam");
        return h.events.some((e, i) => i > start && e.type === "text" && e.from === "fo" && TIRAMISU.test(e.text)) ||
          "no text mentioned the tiramisu (item 8)";
      },
    },
    {
      description: "No friend was asked about it more than once before totals",
      test: (h) => {
        const calc = firstOkIndex(h, "calculate_shares");
        for (const id of friendIds(h)) {
          const asks = textsFromFo(h, id).filter((t) => t.index < calc && TIRAMISU.test(t.text)).length;
          if (asks > 1) return `${id} was asked ${asks} times`;
        }
        return true;
      },
    },
    {
      description: "Only the organizer split it evenly or assigned it",
      test: (h) => {
        const org = organizerOf(h);
        for (const c of h.toolCalls) {
          if (c.name === "calculate_shares" && c.args.unclaimed_policy === "split_evenly") {
            if (c.triggeredBy !== org.id || !samePhone(c.args.by_phone, org.phone)) {
              return `split_evenly in a run started by ${c.triggeredBy} with by_phone ${String(c.args.by_phone)}`;
            }
          }
          if (c.name === "record_claims" && c.ok && claimNumbers(c.args, c.result).includes(8)) {
            const who = callPerson(h, c.args, c.result);
            if (c.triggeredBy !== org.id && c.triggeredBy !== who) return `item 8 put on ${who} in a run started by ${c.triggeredBy}`;
          }
        }
        return true;
      },
    },
    {
      description: "Totals were calculated with the tiramisu split evenly or assigned, never dropped",
      test: (h) => {
        const e = h.finalEvent;
        if (!e.shares) return "calculate_shares never succeeded";
        const covered = e.unclaimedPolicy === "split_evenly" || e.claims.some((c) => c.itemNumber === 8);
        return covered || "shares exist but item 8 has no owner and the policy isn't split_evenly";
      },
    },
  ],
};

const doubleClaim: EdgeCase = {
  id: "double-claim-single-item",
  title: "Two people claim the one glass of wine",
  area: "claiming",
  planRef: "Claiming items: Two people claim one single item",
  critical: true,
  seed: async (ctx) => {
    const { eventId } = await seedToClaiming(ctx);
    const { priya: _priya, ...others } = DEFAULT_CLAIMS;
    await recordClaims(ctx, eventId, others);
    return { eventId };
  },
  inbound: [{ from: "priya", text: "1, 3 and 4 for me" }],
  replies: [
    { to: "priya", when: /\?/, reply: "Yep, I had a glass of the red." },
    { to: "pranav", when: WINE, reply: "Ha, they each had a glass but only one got rung up. Just split it between them." },
  ],
  maxRuns: 4,
  checks: [
    {
      description: "Priya's claim was recorded as 1, 3 and 4",
      test: (h) => sameList(finalClaims(h, "priya"), [1, 3, 4]) || `Priya's claims are [${finalClaims(h, "priya").join(", ")}]`,
    },
    {
      description: "Jordan's wine claim stayed unless the organizer or Jordan changed it",
      test: (h) => {
        if (finalClaims(h, "jordan").includes(3)) return true;
        const changed = okCallsNamed(h, "record_claims").some(
          (c) => callPerson(h, c.args, c.result) === "jordan" && (c.triggeredBy === "pranav" || c.triggeredBy === "jordan"),
        );
        return changed || "Jordan lost item 3 without the organizer or Jordan saying so";
      },
    },
    {
      description: "The organizer was told the wine is claimed twice",
      test: (h) => {
        const start = inboundIndex(h, "priya");
        return textsFromFo(h, "pranav").some((t) => t.index > start && WINE.test(t.text)) || "no text to the organizer about the wine";
      },
    },
    {
      description: "Priya isn't told what Jordan ordered or owes",
      test: (h) => noLeakTo(h, "priya"),
    },
  ],
};

const nonAttendeeClaim: EdgeCase = {
  id: "claim-from-non-attendee",
  title: "Claim from someone who didn't come",
  area: "claiming",
  planRef: "Claiming items: Claim from someone who didn't come",
  critical: false,
  seed: async (ctx) => {
    const { eventId } = await seedToClaiming(ctx);
    await recordClaims(ctx, eventId, { maya: DEFAULT_CLAIMS.maya!, jordan: DEFAULT_CLAIMS.jordan! });
    return { eventId };
  },
  inbound: [{ from: "alex", text: "Hey Fo! I had 2 and 3, the lasagna and a glass of red." }],
  replies: [{ to: "pranav", when: /alex/i, reply: "Alex wasn't there, he bailed at the last minute." }],
  maxRuns: 3,
  checks: [
    {
      description: "Alex wasn't added to the attendees on his own word",
      test: (h) => {
        if (h.toolCalls.some((c) => c.name === "set_attendees" && c.triggeredBy === "alex")) return "set_attendees called in Alex's run";
        return !(h.finalEvent.attendeeIds ?? []).includes("alex") || "Alex is on the attendee list";
      },
    },
    {
      description: "No claims were saved for Alex and the others' claims are untouched",
      test: (h) => {
        if (finalClaims(h, "alex").length) return "Alex has claims";
        if (!sameList(finalClaims(h, "jordan"), DEFAULT_CLAIMS.jordan!)) return "Jordan's claims changed";
        return sameList(finalClaims(h, "maya"), DEFAULT_CLAIMS.maya!) || "Maya's claims changed";
      },
    },
    {
      description: "Fo replied to Alex",
      test: (h) => textsFromFo(h, "alex").length > 0 || "Alex got no reply",
    },
    {
      description: "Alex isn't told who had what",
      test: (h) => noLeakTo(h, "alex"),
    },
  ],
};

const messyClaim: EdgeCase = {
  id: "messy-claim",
  title: "\"The pizza and some of the bread\"",
  area: "claiming",
  planRef: "Claiming items: Messy replies (\"the pizza and some bread\")",
  critical: true,
  seed: async (ctx) => {
    const { eventId } = await seedToClaiming(ctx);
    const { priya: _priya, ...others } = DEFAULT_CLAIMS;
    await recordClaims(ctx, eventId, others);
    return { eventId };
  },
  inbound: [{ from: "priya", text: "the pizza and some of the bread" }],
  replies: [{ to: "priya", when: /pizza|margherita|garlic|bread|\b1\)|\b4\)/i, reply: "Yes, that's right!", afterMinutes: 2 }],
  maxRuns: 4,
  checks: [
    {
      description: "Fo confirmed back with Priya before saving her claim",
      test: (h) => {
        const first = toolEvents(h, "record_claims").find((e) => callPerson(h, e.args, e.result) === "priya");
        if (!first) return "Priya's claim was never recorded";
        const asked = textsFromFo(h, "priya").some((t) => t.index > inboundIndex(h, "priya") && t.index < first.index);
        const answered = inboundIndex(h, "priya", undefined, 1);
        if (!asked) return "record_claims ran before Fo checked with Priya";
        return (answered >= 0 && answered < first.index) || "record_claims ran before Priya confirmed";
      },
    },
    {
      description: "Priya's claims are 1) Margherita pizza and 4) Garlic bread",
      test: (h) => sameList(finalClaims(h, "priya"), [1, 4]) || `Priya's claims are [${finalClaims(h, "priya").join(", ")}]`,
    },
    {
      description: "Everyone else's claims are unchanged",
      test: (h) => {
        for (const [id, items] of Object.entries(DEFAULT_CLAIMS)) {
          if (id !== "priya" && !sameList(finalClaims(h, id), items)) return `${id}'s claims changed`;
        }
        return true;
      },
    },
  ],
};

const disputeTotal: EdgeCase = {
  id: "dispute-total",
  title: "\"I didn't have the wine\" before the totals go out",
  area: "claiming",
  planRef: "Claiming items: Someone disputes their total",
  critical: false,
  seed: (ctx) => seedToPaying(ctx),
  inbound: [{ from: "jordan", text: "Wait, I didn't have the wine. Just the lasagna and the garlic bread." }],
  replies: [
    { to: "jordan", when: /\?/, reply: "Yes, just 2 and 4." },
    { to: "pranav", when: /wine|house red|\b3\)|glass/i, reply: "Oh, that glass of red was mine. Put it on me." },
    {
      to: "pranav",
      when: /send\?|ok to send|approve|send (?:them|these|the|it|jordan)|update jordan/i,
      reply: "Yes, send Jordan the update.",
    },
  ],
  maxRuns: 6,
  checks: [
    {
      description: "Jordan's claims were corrected to 2 and 4",
      test: (h) => sameList(finalClaims(h, "jordan"), [2, 4]) || `Jordan's claims are [${finalClaims(h, "jordan").join(", ")}]`,
    },
    {
      description: "The wine moved to someone else only on the organizer's word",
      test: (h) => {
        for (const c of okCallsNamed(h, "record_claims")) {
          const who = callPerson(h, c.args, c.result);
          if (who !== "jordan" && claimNumbers(c.args, c.result).includes(3) && c.triggeredBy !== "pranav" && c.triggeredBy !== who) {
            return `item 3 put on ${who} in a run started by ${c.triggeredBy}`;
          }
        }
        return true;
      },
    },
    {
      description: "Totals were recalculated after the dispute",
      test: (h) => {
        const start = inboundIndex(h, "jordan");
        if (firstOkIndex(h, "calculate_shares", start) === Number.POSITIVE_INFINITY) return "calculate_shares didn't succeed after Jordan's text";
        const share = h.finalEvent.shares?.find((s) => s.personId === "jordan");
        return (share && !share.items.some((i) => i.itemNumber === 3)) || "Jordan's share still includes the wine";
      },
    },
    {
      description: "Jordan got his new total, after the organizer approved it",
      test: (h) => {
        const amount = amountOf(h, "jordan");
        if (!amount) return "Jordan has no share";
        const start = inboundIndex(h, "jordan");
        const calc = firstOkIndex(h, "calculate_shares", start);
        const approval = textsToFo(h, "pranav").find((t) => t.index > calc)?.index ?? Number.POSITIVE_INFINITY;
        const sent = textsFromFo(h, "jordan").filter((t) => t.text.includes(amount));
        if (!sent.length) return `no text to Jordan with ${amount}`;
        return sent.some((t) => t.index > approval) || "Jordan's update went out before the organizer approved the new totals";
      },
    },
    {
      description: "send_totals ran only on the organizer's word",
      test: (h) => {
        const org = organizerOf(h);
        const bad = okCallsNamed(h, "send_totals").find((c) => c.triggeredBy !== org.id);
        return !bad || `send_totals in a run started by ${bad.triggeredBy}`;
      },
    },
    {
      description: "Jordan's messages show only his own numbers",
      test: (h) => noLeakTo(h, "jordan", inboundIndex(h, "jordan")),
    },
  ],
};

const MONEY = /\$\d|venmo|you owe|your share|pay (?:me|pranav|him|back)|split/i;

const organizerCovers: EdgeCase = {
  id: "organizer-covers",
  title: "After dinner the organizer says it's their treat",
  area: "payment",
  planRef: "Payment: Organizer covers the bill",
  critical: true,
  seed: async (ctx) => {
    const booked = await seedToBooked(ctx);
    // Two and a half hours after the booked start: dinner is over, no receipt yet.
    const startsAt = Date.parse(booked.slots[booked.chosenSlotId.charCodeAt(0) - 65]!.starts_at);
    const minutes = Math.ceil((startsAt + 150 * 60_000 - ctx.now().getTime()) / 60_000);
    if (minutes > 0) ctx.advanceMinutes(minutes);
    return booked;
  },
  inbound: [{ from: "pranav", text: "That was a great dinner, thanks Fo!" }],
  replies: [{ to: "pranav", when: /on you|your treat|cover|split/i, reply: "It's on me, don't charge anyone." }],
  maxRuns: 4,
  checks: [
    {
      description: "Fo asked the organizer whether to split or cover, before closing anything",
      test: (h) => {
        const asked = textsFromFo(h, "pranav").find((t) => /split/i.test(t.text) && /on you|your treat|cover/i.test(t.text));
        if (!asked) return "no text to the organizer asking split or treat";
        const covered = toolEvents(h, "cover_bill")[0];
        return !covered || asked.index < covered.index || "cover_bill ran before the organizer was asked";
      },
    },
    {
      description: "cover_bill succeeded from the organizer's phone, in the organizer's run",
      test: (h) => {
        const org = organizerOf(h);
        const ok = okCallsNamed(h, "cover_bill").some((c) => samePhone(c.args.by_phone, org.phone) && c.triggeredBy === org.id);
        return ok || "no successful cover_bill with the organizer's phone";
      },
    },
    {
      description: "The dinner is settled as covered, with no split",
      test: (h) =>
        (h.finalEvent.stage === "settled" && h.finalEvent.organizerCovered === true && !h.finalEvent.shares && !h.finalEvent.totalsSentAt) ||
        `stage ${h.finalEvent.stage}, covered ${String(h.finalEvent.organizerCovered)}, shares ${h.finalEvent.shares ? "calculated" : "none"}`,
    },
    {
      description: "No friend got a message about money",
      test: (h) => {
        const bad = textsExcept(h, "pranav").filter((t) => MONEY.test(t.text));
        return bad.length === 0 || `money text to ${bad.map((t) => t.to).join(", ")}: ${bad[0]!.text}`;
      },
    },
  ],
};

export const cases: EdgeCase[] = [
  receiptMismatch,
  tipAlreadyIncluded,
  unclaimedItem,
  doubleClaim,
  nonAttendeeClaim,
  messyClaim,
  disputeTotal,
  organizerCovers,
];
