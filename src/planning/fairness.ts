import { contactsOf, hasContact, primaryContact } from "../events/people.js";
import type { Concession, Person } from "../types.js";
import { joinNames } from "./text.js";

/** Contacts in this group with an unredeemed concession, longest-waiting first. */
export function priorityContacts(concessions: readonly Concession[], groupContacts: readonly string[]): string[] {
  const group = new Set(groupContacts);
  const oldest = new Map<string, number>();
  for (const c of concessions) {
    if (c.redeemedInEventId || !group.has(c.contact)) continue;
    const t = Date.parse(c.at);
    const at = Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    const prev = oldest.get(c.contact);
    if (prev === undefined || at < prev) oldest.set(c.contact, at);
  }
  return [...oldest.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([contact]) => contact);
}

/** Same ordering as priorityContacts, translated to this event's person ids. */
export function priorityIds(concessions: readonly Concession[], people: readonly Person[]): string[] {
  const byContact = new Map(people.flatMap((p) => contactsOf(p).map((c) => [c, p.id] as const)));
  const ids = priorityContacts(concessions, [...byContact.keys()])
    .map((contact) => byContact.get(contact))
    .filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
}

export function newConcessions(input: {
  eventId: string;
  people: readonly Person[];
  gaveUpIds: readonly string[];
  what: string;
  now: string;
  /** Pass the stored list so re-running a tally doesn't record the same concession twice. */
  existing?: readonly Concession[];
}): Concession[] {
  const seen = new Set(
    (input.existing ?? []).map((c) => `${c.contact}|${c.eventId}|${c.what}`),
  );
  const out: Concession[] = [];
  for (const id of input.gaveUpIds) {
    const person = input.people.find((p) => p.id === id);
    if (!person) continue;
    const contact = primaryContact(person);
    const key = `${contact}|${input.eventId}|${input.what}`;
    if (!contact || seen.has(key)) continue;
    seen.add(key);
    out.push({ contact, eventId: input.eventId, what: input.what, at: input.now });
  }
  return out;
}

/**
 * Marks open concessions for these contacts as honored at eventId. Concessions made at
 * eventId itself stay open: giving something up tonight earns priority next time.
 */
export function redeem(concessions: readonly Concession[], contacts: readonly string[], eventId: string): Concession[] {
  const target = new Set(contacts);
  return concessions.map((c) =>
    !c.redeemedInEventId && target.has(c.contact) && c.eventId !== eventId ? { ...c, redeemedInEventId: eventId } : c,
  );
}

/**
 * "Maya gave up a pick last time, so Maya gets priority tonight." Worded to avoid
 * gendered pronouns. Returns undefined when nobody has priority.
 */
export function fairnessNote(input: { people: readonly Person[]; priorityContacts: readonly string[] }): string | undefined {
  const names = input.priorityContacts
    .map((contact) => input.people.find((p) => hasContact(p, contact))?.name)
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return undefined;
  if (names.length === 1) return `${names[0]} gave up a pick last time, so ${names[0]} gets priority tonight.`;
  return `${joinNames(names)} gave up a pick last time, so they get priority tonight.`;
}
