import type { Cents, DinnerEvent, Person, PickFirmness, TimeSlot } from "../types.js";
import { FoError } from "./errors.js";
import { generateEventId, isValidEventId } from "./ids.js";
import { assertUniquePhones, normalizePhone, slugId } from "./people.js";
import { toIso, toMs } from "./util.js";

/** Already parsed input for create_event. Money is integer cents. */
export interface CreateEventInput {
  title: string;
  organizer: { name: string; phone: string; venmo?: string };
  friends: { name: string; phone: string }[];
  timeSlots: { label: string; startsAt: string }[];
  budgetPerPersonCents?: Cents;
  cuisineHint?: string;
  replyDeadline?: string;
  organizerPick?: { restaurantName: string; firmness: PickFirmness };
}

export interface CreateEventOptions {
  now: Date | string;
  /** Injected id for tests or after a collision check. Generated from the title otherwise. */
  id?: string;
  /** Calling code for numbers typed without "+". Defaults to "1". */
  defaultCountry?: string;
}

export const DEFAULT_REPLY_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_SLOTS = 26;

function invalid(message: string): FoError {
  return new FoError("INVALID_INPUT", message);
}

function cleanName(name: unknown, what: string): string {
  const cleaned = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!cleaned) throw invalid(`${what} needs a name.`);
  return cleaned;
}

function phoneFor(name: string, raw: string, defaultCountry: string): string {
  try {
    return normalizePhone(raw, defaultCountry);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw invalid(`${name}'s number: ${why}`);
  }
}

function cleanVenmo(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const handle = raw.trim().replace(/^@+/, "");
  if (!handle) return undefined;
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(handle)) {
    throw invalid(`"${raw}" doesn't look like a Venmo username.`);
  }
  return handle;
}

export function createEvent(input: CreateEventInput, opts: CreateEventOptions): DinnerEvent {
  const nowIso = toIso(opts.now);
  const nowMs = toMs(nowIso);
  const country = opts.defaultCountry ?? "1";

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw invalid("The dinner needs a title.");

  const id = opts.id ?? generateEventId(title);
  if (!isValidEventId(id)) throw invalid(`"${id}" isn't a valid event id.`);

  if (!input.organizer) throw invalid("The dinner needs an organizer.");
  if (!Array.isArray(input.friends) || input.friends.length === 0) {
    throw invalid("Add at least one friend to invite.");
  }

  const taken = new Set<string>();
  const organizerName = cleanName(input.organizer.name, "The organizer");
  const organizer: Person = {
    id: slugId(organizerName, taken),
    name: organizerName,
    phone: phoneFor(organizerName, input.organizer.phone, country),
    isOrganizer: true,
  };
  taken.add(organizer.id);

  const friends: Person[] = input.friends.map((f, i) => {
    const name = cleanName(f?.name, `Friend #${i + 1}`);
    const phone = phoneFor(name, f.phone, country);
    if (phone === organizer.phone) {
      throw invalid(
        `${name}'s number (${phone}) is the organizer's own number. Please double check it with the organizer.`,
      );
    }
    const person: Person = { id: slugId(name, taken), name, phone, isOrganizer: false };
    taken.add(person.id);
    return person;
  });
  const people = [organizer, ...friends];
  assertUniquePhones(people);

  const slotsIn = Array.isArray(input.timeSlots) ? input.timeSlots : [];
  if (slotsIn.length > MAX_SLOTS) throw invalid(`At most ${MAX_SLOTS} time options, please.`);
  const timeSlots: TimeSlot[] = slotsIn.map((s, i) => {
    const slotId = String.fromCharCode(65 + i);
    const label = typeof s?.label === "string" ? s.label.trim() : "";
    if (!label) throw invalid(`Time option ${slotId} needs a label like "Sat 7:30pm".`);
    if (typeof s.startsAt !== "string" || Number.isNaN(Date.parse(s.startsAt))) {
      throw invalid(`Time option ${slotId} (${label}) needs a valid start time.`);
    }
    return { id: slotId, label, startsAt: s.startsAt };
  });

  const budget = input.budgetPerPersonCents;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) {
    throw invalid("The budget per person must be a positive amount.");
  }

  let replyDeadline: string;
  if (input.replyDeadline !== undefined) {
    const ms = Date.parse(input.replyDeadline);
    if (Number.isNaN(ms)) throw invalid(`"${input.replyDeadline}" isn't a valid reply deadline.`);
    if (ms <= nowMs) throw invalid("The reply deadline has to be in the future.");
    replyDeadline = new Date(ms).toISOString();
  } else {
    replyDeadline = new Date(nowMs + DEFAULT_REPLY_WINDOW_MS).toISOString();
  }

  let organizerPick: DinnerEvent["organizerPick"];
  if (input.organizerPick) {
    const restaurantName = input.organizerPick.restaurantName?.trim();
    if (!restaurantName) throw invalid("The organizer's pick needs a restaurant name.");
    const firmness = input.organizerPick.firmness;
    if (firmness !== "locked" && firmness !== "suggested") {
      throw invalid(`The organizer's pick must be "locked" or "suggested".`);
    }
    organizerPick = { restaurantName, firmness };
  }

  const cuisineHint = input.cuisineHint?.trim() || undefined;
  const organizerVenmo = cleanVenmo(input.organizer.venmo);

  const event: DinnerEvent = {
    id,
    title,
    createdAt: nowIso,
    updatedAt: nowIso,
    stage: "planning",
    organizerId: organizer.id,
    people,
    timeSlots,
    replyDeadline,
    nudgedIds: [],
    preferences: [],
    restaurantOptions: [],
    votes: [],
    receipts: [],
    claims: [],
    claimAnsweredIds: [],
    treatedIds: [],
    unclaimedPolicy: "block",
    feesSplitEvenly: false,
    payments: [],
  };
  if (organizerVenmo !== undefined) event.organizerVenmo = organizerVenmo;
  if (budget !== undefined) event.budgetPerPersonCents = budget;
  if (cuisineHint !== undefined) event.cuisineHint = cuisineHint;
  if (organizerPick !== undefined) event.organizerPick = organizerPick;
  return event;
}
