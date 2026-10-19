import type { Cents, DinnerEvent, Person, PickFirmness, TimeSlot } from "../types.js";
import { FoError } from "./errors.js";
import { generateEventId, isValidEventId } from "./ids.js";
import { assertUniqueContacts, contactsOf, normalizeEmail, normalizePhone, slugId } from "./people.js";
import { toIso, toMs } from "./util.js";

/** Already parsed input for create_event. Money is integer cents. */
export interface CreateEventInput {
  title: string;
  /** Each person needs a phone, an email or both. */
  organizer: { name: string; phone?: string; email?: string; venmo?: string };
  friends: { name: string; phone?: string; email?: string }[];
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

/** Normalized phone and/or email; at least one is required. Empty strings count as missing. */
export function contactFor(
  name: string,
  raw: { phone?: string | undefined; email?: string | undefined },
  defaultCountry = "1",
): { phone?: string; email?: string } {
  const out: { phone?: string; email?: string } = {};
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
  if (raw.phone?.trim()) {
    try {
      out.phone = normalizePhone(raw.phone, defaultCountry);
    } catch (err) {
      throw invalid(`${name}'s number: ${why(err)}`);
    }
  }
  if (raw.email?.trim()) {
    try {
      out.email = normalizeEmail(raw.email);
    } catch (err) {
      throw invalid(`${name}'s email: ${why(err)}`);
    }
  }
  if (!out.phone && !out.email) throw invalid(`${name} needs a phone number or an email address.`);
  return out;
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
    ...contactFor(organizerName, input.organizer, country),
    isOrganizer: true,
  };
  taken.add(organizer.id);
  const organizerContacts = contactsOf(organizer);

  const friends: Person[] = input.friends.map((f, i) => {
    const name = cleanName(f?.name, `Friend #${i + 1}`);
    const contact = contactFor(name, f, country);
    const clash = contactsOf(contact).find((c) => organizerContacts.includes(c));
    if (clash) {
      const what = clash.includes("@") ? "email" : "number";
      throw invalid(`${name}'s ${what} (${clash}) is the organizer's own ${what}. Please double check it with the organizer.`);
    }
    const person: Person = { id: slugId(name, taken), name, ...contact, isOrganizer: false };
    taken.add(person.id);
    return person;
  });
  const people = [organizer, ...friends];
  assertUniqueContacts(people);

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
  };
  if (organizerVenmo !== undefined) event.organizerVenmo = organizerVenmo;
  if (budget !== undefined) event.budgetPerPersonCents = budget;
  if (cuisineHint !== undefined) event.cuisineHint = cuisineHint;
  if (organizerPick !== undefined) event.organizerPick = organizerPick;
  return event;
}
