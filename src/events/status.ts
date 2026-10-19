import type { DinnerEvent, Person, Stage } from "../types.js";
import { stageNumber } from "./stage.js";
import { formatCents, joinNames, toIso, toMs } from "./util.js";
import { billQuestionAt, dayOfReminderAt, DEFAULT_TIME_ZONE, localClockLabel } from "./zone.js";

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

/**
 * Ids of people pick_time asked about shifting who haven't answered yet. Empty
 * once its deadline passes, since pick_time then decides without them.
 */
export function shiftWaiting(event: DinnerEvent, now: string | number): string[] {
  const check = event.shiftCheck;
  if (!check || event.chosenSlotId) return [];
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  if (nowMs >= Date.parse(check.deadline)) return [];
  const active = new Set(event.people.filter((p) => !p.optedOut).map((p) => p.id));
  return check.asks.map((a) => a.personId).filter((id) => active.has(id) && !check.answeredIds.includes(id));
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

  if (event.shiftCheck) {
    const waiting = shiftWaiting(event, nowMs);
    details.shiftCheck = {
      asked: event.people.filter((p) => event.shiftCheck!.asks.some((a) => a.personId === p.id)).map((p) => p.name),
      waitingOn: event.people.filter((p) => waiting.includes(p.id)).map((p) => p.name),
      deadline: event.shiftCheck.deadline,
    };
    if (waiting.length > 0) {
      const who = names(event.people.filter((p) => waiting.includes(p.id)));
      return {
        pending,
        details,
        nextAction: `Waiting on ${who} about whether another time could work (pick_time sent the question). Record each answer with record_preferences, then call pick_time; or call it at ${event.shiftCheck.deadline}.`,
      };
    }
    return { pending, details, nextAction: "Everyone asked about shifting has answered, or their time is up. Call pick_time." };
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

// A friend can raise an allergy after booking; the other ballot choices give Fo a real
// place to name to the organizer instead of only offering to call the restaurant.
function bookedStatus(event: DinnerEvent, nowMs: number, timeZone: string): StageResult {
  const result = bookedSchedule(event, nowMs, timeZone);
  const backups = event.restaurantOptions.filter((o) => o.name !== event.booking?.restaurantName);
  if (backups.length === 0) return result;
  return {
    ...result,
    details: { ...result.details, backupOptions: backups.map((o) => ({ name: o.name, cuisine: o.cuisine, notes: o.notes })) },
    nextAction: `${result.nextAction} If a friend raises an allergy or other hard constraint, tell the organizer privately and name a place from backupOptions that works for everyone.`,
  };
}

function bookedSchedule(event: DinnerEvent, nowMs: number, timeZone: string): StageResult {
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
  if (Number.isNaN(startsMs)) {
    return {
      pending: [],
      details,
      nextAction: `Send everyone a reminder on the day of ${when} for ${booking.restaurantName}, before it starts.`,
    };
  }
  const remind = dayOfReminderAt(new Date(startsMs), timeZone);
  const bill = billQuestionAt(new Date(startsMs));
  details.dayOfReminderAt = remind.toISOString();
  details.billQuestionAt = bill.toISOString();
  // The slot's own label, so a misconfigured zone can only move when the reminder goes out, not what it says.
  const reminder = `"Reminder: ${booking.restaurantName}, ${when}!"`;
  const after = event.organizerCovered
    ? "It's the organizer's treat: no bill question, and nobody gets asked for money."
    : `Ask the organizer about the bill at ${bill.toISOString()}.`;
  if (nowMs < remind.getTime()) {
    return {
      pending: [],
      details,
      nextAction: `Send each attendee the day-of reminder ${reminder} at ${remind.toISOString()} (${localClockLabel(remind, timeZone)} ${timeZone}, before the ${when} start). ${after}`,
    };
  }
  if (nowMs < startsMs) {
    return {
      pending: [],
      details,
      nextAction: `Send each attendee the day-of reminder now if it hasn't gone out: ${reminder} ${after}`,
    };
  }
  if (event.organizerCovered) {
    return {
      pending: [],
      details,
      nextAction: "It's the organizer's treat, so there's no bill question and nobody pays. Call cover_bill (by_phone or by_email = the organizer's) to close it out.",
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
  // A friend may reply hours later in a fresh turn ("the pizza and some bread"), so the
  // numbered list has to be here for Fo to match words to item numbers.
  if (event.receipts.length > 0) {
    details.itemList = event.receipts
      .flatMap((r) => r.items)
      .map((i) => `${i.number}) ${i.description} ${formatCents(i.amountCents)}`)
      .join("  ");
  }

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
  const shares = event.shares ?? [];
  if (shares.length === 0) {
    return { pending: [], details: {}, nextAction: "No totals yet. Call calculate_shares and show the organizer the totals before sending." };
  }
  const details: Record<string, unknown> = {
    totals: shares.map((s) => ({ name: event.people.find((p) => p.id === s.personId)?.name ?? s.personId, total: formatCents(s.totalCents) })),
  };
  return {
    pending: [],
    details,
    nextAction:
      "Show the organizer the totals from calculate_shares and wait for their yes. Then call send_totals (by_phone or by_email = the organizer's) and send each person their own message with their Venmo link; that finishes the dinner. A friend disputing their items before then: record_claims with their full list, then calculate_shares again.",
  };
}

/**
 * Where the event stands and what Fo should do next. Pure: depends only on the
 * event, `now` and the time zone used to place the day-of reminder.
 */
export function getStatus(event: DinnerEvent, now: Date | string, timeZone: string = DEFAULT_TIME_ZONE): EventStatus {
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
      result = bookedStatus(event, nowMs, timeZone);
      break;
    case "claiming":
      result = claimingStatus(event);
      break;
    case "paying":
      result = payingStatus(event);
      break;
    case "settled":
      result = event.organizerCovered
        ? {
            pending: [],
            details: { organizerCovered: true },
            nextAction:
              "The organizer covered the bill, so nobody owes anything. Night complete! If a friend asks what they owe, say nothing is owed, without saying who paid unless the organizer asked you to thank them on their behalf.",
          }
        : {
            pending: [],
            details: event.totalsSentAt ? { totalsSentAt: event.totalsSentAt } : {},
            nextAction:
              "Totals are approved and each friend's message has their Venmo link. Night complete once those are sent! Payments are between each friend and the organizer: don't track or chase them.",
          };
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
