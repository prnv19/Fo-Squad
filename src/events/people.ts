import type { DinnerEvent, Person } from "../types.js";
import { FoError } from "./errors.js";

const ALLOWED_PHONE_CHARS = /^[\d\s()+.\- ]+$/;

/**
 * Normalizes a phone number to E.164 ("+15551234567").
 *
 * Numbers starting with "+" or "00" are treated as international and kept as is.
 * Anything else is a national number in `defaultCountry` (a calling code, "1" = US/Canada).
 */
export function normalizePhone(raw: string, defaultCountry = "1"): string {
  const input = (raw ?? "").trim();
  const bad = (why: string) =>
    new FoError("INVALID_INPUT", `"${input}" doesn't look like a phone number (${why}).`);

  if (!input) throw new FoError("INVALID_INPUT", "Phone number is empty.");
  if (!ALLOWED_PHONE_CHARS.test(input)) throw bad("unexpected characters");
  if (input.lastIndexOf("+") > 0) throw bad("misplaced +");

  let digits = input.replace(/\D/g, "");
  let international = input.startsWith("+");
  if (!international && digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }

  if (!international) {
    if (!/^[1-9]\d{0,2}$/.test(defaultCountry)) {
      throw new Error(`Invalid default country calling code: ${defaultCountry}`);
    }
    if (defaultCountry === "1") {
      if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
      if (digits.length !== 10) throw bad("US numbers need 10 digits");
      digits = `1${digits}`;
    } else {
      // Most non-NANP countries dial a trunk "0" nationally that E.164 drops.
      digits = defaultCountry + digits.replace(/^0/, "");
    }
  }

  if (digits.length < 8 || digits.length > 15) throw bad("wrong number of digits");
  if (digits.startsWith("0")) throw bad("country code can't start with 0");
  if (digits.startsWith("1") && digits.length !== 11) throw bad("US numbers need 10 digits");
  // NANP area codes never start with 0 or 1, so this catches most dropped or extra digits.
  if (digits.startsWith("1") && /^[01]/.test(digits.slice(1))) throw bad("invalid area code");

  return `+${digits}`;
}

/** Like normalizePhone but returns undefined instead of throwing. */
export function tryNormalizePhone(raw: string, defaultCountry = "1"): string | undefined {
  try {
    return normalizePhone(raw, defaultCountry);
  } catch {
    return undefined;
  }
}

/**
 * Lowercase slug of a name, suffixed "-2", "-3"... when already in `taken`.
 * Does not add the result to `taken`; the caller owns that set.
 */
export function slugId(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "") || "friend";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Finds a person by id, then case-insensitive name, then phone number. */
export function resolvePerson(event: DinnerEvent, ref: string): Person | undefined {
  const trimmed = (ref ?? "").trim();
  if (!trimmed) return undefined;

  const byId = event.people.find((p) => p.id === trimmed || p.id === trimmed.toLowerCase());
  if (byId) return byId;

  const name = normalizeName(trimmed);
  const byName = event.people.filter((p) => normalizeName(p.name) === name);
  if (byName.length === 1) return byName[0];

  const phone = tryNormalizePhone(trimmed);
  if (phone) return event.people.find((p) => p.phone === phone);
  return undefined;
}

/** resolvePerson that throws UNKNOWN_PERSON with a message Fo can relay. */
export function requirePerson(event: DinnerEvent, ref: string): Person {
  const person = resolvePerson(event, ref);
  if (!person) {
    const names = event.people.map((p) => p.name).join(", ");
    throw new FoError(
      "UNKNOWN_PERSON",
      `I don't know who "${ref}" is for "${event.title}". People on this dinner: ${names}.`,
    );
  }
  return person;
}

export function getOrganizer(event: DinnerEvent): Person | undefined {
  return event.people.find((p) => p.id === event.organizerId);
}

export function isOrganizerPhone(event: DinnerEvent, phone: string): boolean {
  const normalized = tryNormalizePhone(phone);
  const organizer = getOrganizer(event);
  return !!normalized && !!organizer && organizer.phone === normalized;
}

/** Only the organizer's number can approve bookings, confirm payments or change totals. */
export function assertOrganizer(event: DinnerEvent, phone: string, action: string): void {
  if (!isOrganizerPhone(event, phone)) {
    throw new FoError(
      "NOT_ORGANIZER",
      `Only the organizer can ${action}. That request didn't come from the organizer's number.`,
    );
  }
}

/** Fo must never text someone who replied STOP. */
export function assertCanText(person: Person): void {
  if (person.optedOut) {
    throw new FoError("OPTED_OUT", `${person.name} opted out of texts. Don't message them again.`);
  }
}

/**
 * Two people sharing a number is almost always a typo, and texting the wrong
 * number leaks the plan to a stranger, so refuse before anything is sent.
 */
export function assertUniquePhones(people: Pick<Person, "name" | "phone">[]): void {
  const seen = new Map<string, string>();
  for (const p of people) {
    const other = seen.get(p.phone);
    if (other !== undefined) {
      throw new FoError(
        "INVALID_INPUT",
        `${other} and ${p.name} have the same number (${p.phone}). Please double check the numbers with the organizer.`,
      );
    }
    seen.set(p.phone, p.name);
  }
}
