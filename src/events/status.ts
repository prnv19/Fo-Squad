import type { DinnerEvent, Person, Stage } from "../types.js";
import { stageNumber } from "./stage.js";
import { formatCents, joinNames, toIso, toMs } from "./util.js";

export interface PendingPerson {
  id: string;
  name: string;
}

export interface EventStatus {
  eventId: string;
  title: string;
  stage: Stage;
  stageNumber: number;
  /** People Fo is waiting on in this stage. Never includes opted-out people. */
  pending: PendingPerson[];
  /** The single most useful thing for Fo to do next. */
  nextAction: string;
  details: Record<string, unknown>;
}

interface StageResult {
  pending: Person[];
  nextAction: string;
  details: Record<string, unknown>;
}

const brief = (p: Person): PendingPerson => ({ id: p.id, name: p.name });
const names = (people: Person[]) => joinNames(people.map((p) => p.name));

function slotLabel(event: DinnerEvent, slotId: string | undefined): string | undefined {
  if (!slotId) return undefined;
  return event.timeSlots.find((s) => s.id === slotId)?.label ?? slotId;
}

/** Splits people into those Fo may text and those who opted out. */
function splitOptedOut(people: Person[]): { active: Person[]; optedOut: Person[] } {
  return {
    active: people.filter((p) => !p.optedOut),
    optedOut: people.filter((p) => p.optedOut),
  };
}

/** People who can make the chosen slot, or whose availability is unknown. */
function canMakeChosenSlot(event: DinnerEvent, person: Person): boolean {
  if (!event.chosenSlotId || person.id === event.organizerId) return true;
  const pref = event.preferences.find((p) => p.personId === person.id);
  if (!pref || pref.slotsStale) return true;
  return pref.anyTime || pref.slotIds.includes(event.chosenSlotId);
}

function planningStatus(event: DinnerEvent, nowMs: number): StageResult {
  const friends = event.people.filter((p) => p.id !== event.organizerId);
  // A reply whose slot answers were cleared by new time options still needs answering.
  const answered = new Set(event.preferences.filter((p) => !p.slotsStale).map((p) => p.personId));
  const { active, optedOut } = splitOptedOut(friends);
  const pending = active.filter((p) => !answered.has(p.id));

  const deadlineMs = event.replyDeadline ? Date.parse(event.replyDeadline) : undefined;
  const createdMs = Date.parse(event.createdAt);
  const deadlinePassed = deadlineMs !== undefined && nowMs >= deadlineMs;
  const nudgeAtMs =
    deadlineMs !== undefined ? createdMs + Math.max(0, deadlineMs - createdMs) / 2 : undefined;
  const pastHalfWindow = nudgeAtMs !== undefined && nowMs >= nudgeAtMs;

  const details: Record<string, unknown> = {
    replyDeadline: event.replyDeadline,
    deadlinePassed,
    nudgeAfter: nudgeAtMs !== undefined ? new Date(nudgeAtMs).toISOString() : undefined,
    answered: event.people.filter((p) => answered.has(p.id)).map((p) => p.name),
    nudged: event.people.filter((p) => event.nudgedIds.includes(p.id)).map((p) => p.name),
    timeSlots: event.timeSlots.map((s) => `${s.id}) ${s.label}`),
    chosenSlot: slotLabel(event, event.chosenSlotId),
    organizerPick: event.organizerPick,
  };

  const pick = event.organizerPick;
  if (event.chosenSlotId) {
    const slot = slotLabel(event, event.chosenSlotId);
    if (pick?.firmness === "locked") {
      return {
        pending: [],
        details,
        nextAction: `Book ${pick.restaurantName} for ${slot} after the organizer approves, then call confirm_booking.`,
      };
    }
    const going = event.people.filter((p) => canMakeChosenSlot(event, p));
    const dietary = [
      ...new Set(
        event.preferences
          .filter((pref) => going.some((p) => p.id === pref.personId))
          .flatMap((pref) => pref.dietary),
      ),
    ];
    // The tightest private budget wins silently; Fo must not say whose it is.
    const budgets = [
      event.budgetPerPersonCents,
      ...event.preferences
        .filter((pref) => going.some((p) => p.id === pref.personId))
        .map((pref) => pref.budgetCents),
    ].filter((b): b is number => typeof b === "number");
    const maxBudget = budgets.length ? Math.min(...budgets) : undefined;
    const cuisine = event.chosenCuisine;
    const fits = cuisine ? [] : ["the winning cuisine from pick_time"];
    if (dietary.length) fits.push(`every dietary need (${dietary.join(", ")})`);
    if (maxBudget !== undefined) fits.push(`about ${formatCents(maxBudget)} per person or less`);
    details.dietary = dietary;
    details.maxBudgetCents = maxBudget;
    details.chosenCuisine = cuisine;
    const suggested = pick ? ` Include the organizer's suggestion, ${pick.restaurantName}, if it fits.` : "";
    const kind = cuisine ? `${cuisine[0]!.toUpperCase()}${cuisine.slice(1)} restaurants` : "restaurants";
    const fitClause = fits.length ? ` that fit ${joinNames(fits)}` : "";
    return {
      pending: [],
      details,
      nextAction: `Find three ${kind} with a table open at ${slot}${fitClause}, then call set_restaurant_options.${suggested}`,
    };
  }

  if (event.timeSlots.length === 0) {
    return {
      pending: [],
      details,
      nextAction:
        "There are no time options yet. Ask the organizer for three or four times, or if dinner already happened, ask for the receipt photo and call add_receipt.",
    };
  }

  if (active.length === 0 && optedOut.length > 0) {
    return {
      pending,
      details,
      nextAction: "Every friend on this dinner opted out of texts. Let the organizer know.",
    };
  }

  if (pending.length === 0) {
    return { pending, details, nextAction: "Everyone answered. Call pick_time." };
  }

  if (deadlinePassed) {
    if (event.preferences.length === 0) {
      return {
        pending,
        details,
        nextAction:
          "Nobody answered by the reply deadline. Ask the organizer whether to wait longer or just pick a time.",
      };
    }
    return {
      pending,
      details,
      nextAction: `The reply deadline passed without ${names(pending)}. Call pick_time to decide with whoever answered.`,
    };
  }

  const lockedNote = pick?.firmness === "locked" ? ` Tell them dinner is at ${pick.restaurantName}.` : "";
  if (event.preferences.length === 0 && event.nudgedIds.length === 0 && !pastHalfWindow) {
    return {
      pending,
      details,
      nextAction: `Text each friend the time options and ask about food and dietary needs (and plus-ones).${lockedNote}`,
    };
  }

  const toNudge = pending.filter((p) => !event.nudgedIds.includes(p.id));
  if (pastHalfWindow && toNudge.length > 0) {
    return { pending, details, nextAction: `Nudge ${names(toNudge)} once.` };
  }

  const deadline = event.replyDeadline ? ` (${event.replyDeadline})` : "";
  return {
    pending,
    details,
    nextAction: `Waiting on ${names(pending)}. Call pick_time once the reply deadline passes${deadline}, or earlier with force if the organizer wants to decide now.`,
  };
}

function votingStatus(event: DinnerEvent): StageResult {
  const voted = new Set(event.votes.map((v) => v.personId));
  const { active } = splitOptedOut(event.people.filter((p) => canMakeChosenSlot(event, p)));
  const pending = active.filter((p) => !voted.has(p.id));
  const winner = event.restaurantOptions.find((o) => o.id === event.winningRestaurantId);
  const slot = slotLabel(event, event.chosenSlotId);
  const details: Record<string, unknown> = {
    chosenSlot: slot,
    options: event.restaurantOptions.map((o) => `${o.id}) ${o.name}`),
    votesIn: voted.size,
    winner: winner?.name,
  };

  if (winner) {
    const at = slot ? ` for ${slot}` : "";
    return {
      pending: [],
      details,
      nextAction: `Ask the organizer to approve booking ${winner.name}${at}, then call confirm_booking.`,
    };
  }
  if (pending.length > 0) {
    return {
      pending,
      details,
      nextAction: `Waiting on votes from ${names(pending)}. Nudge anyone quiet once, or call tally_votes with force to decide with the votes in.`,
    };
  }
  return {
    pending,
    details,
    nextAction: "Everyone voted. Call tally_votes, then ask the organizer to approve booking the winner.",
  };
}

function bookedStatus(event: DinnerEvent, nowMs: number): StageResult {
  const booking = event.booking;
  const details: Record<string, unknown> = { booking };
  if (!booking) {
    return {
      pending: [],
      details,
      nextAction: "No booking details saved. Once the organizer approves, call confirm_booking.",
    };
  }
  const when = slotLabel(event, booking.slotId) ?? booking.startsAt;
  const startsMs = Date.parse(booking.startsAt);
  if (Number.isNaN(startsMs) || nowMs < startsMs) {
    return {
      pending: [],
      details,
      nextAction: `Send everyone a reminder the afternoon of ${when} (${booking.startsAt}) for ${booking.restaurantName}.`,
    };
  }
  return {
    pending: [],
    details,
    nextAction:
      'After dinner, ask the organizer: "Want me to split the bill, or is it on you?" Split: ask for the receipt photo, then call add_receipt. Their treat: call cover_bill (by_phone or by_email = the organizer\'s) and send nobody a payment request.',
  };
}

function claimingStatus(event: DinnerEvent): StageResult {
  const itemNumbers = event.receipts.flatMap((r) => r.items.map((i) => i.number));
  const claimedItems = new Set(event.claims.map((c) => c.itemNumber));
  const unclaimed = itemNumbers.filter((n) => !claimedItems.has(n));
  const details: Record<string, unknown> = {
    receipts: event.receipts.length,
    items: itemNumbers.length,
    unclaimedItems: unclaimed,
    unclaimedPolicy: event.unclaimedPolicy,
  };

  if (event.receipts.length === 0) {
    return {
      pending: [],
      details,
      nextAction: "Ask the organizer for the receipt photo, then call add_receipt.",
    };
  }
  if (!event.attendeeIds) {
    return {
      pending: [],
      details,
      nextAction: "Confirm who actually came, then call set_attendees.",
    };
  }

  const attendees = event.people.filter((p) => event.attendeeIds?.includes(p.id));
  details.attendees = attendees.map((p) => p.name);
  // claimAnsweredIds covers "I had nothing" replies, which leave no claim rows.
  const answered = new Set([...(event.claimAnsweredIds ?? []), ...event.claims.map((c) => c.personId)]);
  const unanswered = attendees.filter((p) => !answered.has(p.id));
  const { active: pending, optedOut } = splitOptedOut(unanswered);

  if (pending.length > 0) {
    return { pending, details, nextAction: `Waiting on claims from ${names(pending)}.` };
  }
  if (optedOut.length > 0) {
    return {
      pending,
      details,
      nextAction: `Ask the organizer which items ${names(optedOut)} had, then call record_claims for them.`,
    };
  }
  if (unclaimed.length > 0 && event.unclaimedPolicy === "block") {
    return {
      pending,
      details,
      nextAction: `Everyone answered but item${unclaimed.length > 1 ? "s" : ""} ${unclaimed.join(", ")} ${unclaimed.length > 1 ? "are" : "is"} unclaimed. Ask the organizer who had ${unclaimed.length > 1 ? "them" : "it"}, or call calculate_shares with unclaimed_policy "split_evenly".`,
    };
  }
  return {
    pending,
    details,
    nextAction: "Call calculate_shares and show the organizer the totals before sending.",
  };
}

function payingStatus(event: DinnerEvent): StageResult {
  const owing = new Map<string, { amountCents: number; status: string }>();
  for (const share of event.shares ?? []) {
    owing.set(share.personId, { amountCents: share.totalCents, status: "pending" });
  }
  for (const pay of event.payments) {
    owing.set(pay.personId, { amountCents: pay.amountCents, status: pay.status });
  }
  // The organizer paid the restaurant, and a $0 share (birthday treat) owes nothing.
  const due = event.people.filter((p) => {
    const o = owing.get(p.id);
    return p.id !== event.organizerId && o !== undefined && o.amountCents > 0;
  });
  const unpaid = due.filter((p) => owing.get(p.id)?.status !== "paid");
  const { active: pending, optedOut } = splitOptedOut(unpaid);
  const saysPaid = pending.filter((p) => owing.get(p.id)?.status === "says_paid");
  const notYet = pending.filter((p) => owing.get(p.id)?.status !== "says_paid");

  const details: Record<string, unknown> = {
    paid: due.filter((p) => owing.get(p.id)?.status === "paid").map((p) => p.name),
    saysPaid: saysPaid.map((p) => p.name),
    unpaid: notYet.map((p) => ({ name: p.name, amount: formatCents(owing.get(p.id)?.amountCents ?? 0) })),
  };

  if (owing.size === 0) {
    return {
      pending: [],
      details,
      nextAction: "No totals yet. Call calculate_shares and show the organizer the totals before sending.",
    };
  }

  const parts: string[] = [];
  if (saysPaid.length > 0) {
    const possessive = saysPaid.map((p) => `${p.name}'s`);
    parts.push(
      `Ask the organizer to confirm ${joinNames(possessive)} payment${saysPaid.length > 1 ? "s" : ""}.`,
    );
  }
  if (notYet.length > 0) {
    parts.push(
      `Waiting on payment from ${names(notYet)}. Send one spaced-out reminder at most, then hand it back to the organizer.`,
    );
  }
  if (optedOut.length > 0) {
    parts.push(`Ask the organizer to collect from ${names(optedOut)} directly.`);
  }
  if (parts.length === 0) {
    parts.push("Everyone's marked paid. Ask the organizer to confirm the last payment with mark_paid.");
  }
  return { pending, details, nextAction: parts.join(" ") };
}

/** Where the event stands and what Fo should do next. Pure: depends only on the event and `now`. */
export function getStatus(event: DinnerEvent, now: Date | string): EventStatus {
  const nowMs = toMs(toIso(now));
  let result: StageResult;
  switch (event.stage) {
    case "planning":
      result = planningStatus(event, nowMs);
      break;
    case "voting":
      result = votingStatus(event);
      break;
    case "booked":
      result = bookedStatus(event, nowMs);
      break;
    case "claiming":
      result = claimingStatus(event);
      break;
    case "paying":
      result = payingStatus(event);
      break;
    case "settled":
      result = event.organizerCovered
        ? { pending: [], details: { organizerCovered: true }, nextAction: "The organizer covered the bill, so nobody owes anything. Night complete!" }
        : { pending: [], details: {}, nextAction: "Everyone's paid. Night complete!" };
      break;
  }

  const optedOut = event.people.filter((p) => p.optedOut);
  let nextAction = result.nextAction;
  if (optedOut.length > 0 && event.stage !== "settled") {
    result.details.optedOut = optedOut.map((p) => p.name);
    nextAction += ` Don't text ${names(optedOut)} (opted out).`;
  }

  return {
    eventId: event.id,
    title: event.title,
    stage: event.stage,
    stageNumber: stageNumber(event.stage),
    pending: result.pending.map(brief),
    nextAction,
    details: result.details,
  };
}
