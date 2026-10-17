import type { Concession, Person } from "../types.js";
import { joinNames } from "./text.js";

/** Phones in this group with an unredeemed concession, longest-waiting first. */
export function priorityPhones(concessions: readonly Concession[], groupPhones: readonly string[]): string[] {
  const group = new Set(groupPhones);
  const oldest = new Map<string, number>();
  for (const c of concessions) {
    if (c.redeemedInEventId || !group.has(c.phone)) continue;
    const t = Date.parse(c.at);
    const at = Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    const prev = oldest.get(c.phone);
    if (prev === undefined || at < prev) oldest.set(c.phone, at);
  }
  return [...oldest.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([phone]) => phone);
}

/** Same ordering as priorityPhones, translated to this event's person ids. */
export function priorityIds(concessions: readonly Concession[], people: readonly Person[]): string[] {
  const byPhone = new Map(people.map((p) => [p.phone, p.id]));
  return priorityPhones(concessions, people.map((p) => p.phone))
    .map((phone) => byPhone.get(phone))
    .filter((id): id is string => id !== undefined);
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
    (input.existing ?? []).map((c) => `${c.phone}|${c.eventId}|${c.what}`),
  );
  const out: Concession[] = [];
  for (const id of input.gaveUpIds) {
    const person = input.people.find((p) => p.id === id);
    if (!person) continue;
    const key = `${person.phone}|${input.eventId}|${input.what}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ phone: person.phone, eventId: input.eventId, what: input.what, at: input.now });
  }
  return out;
}

/**
 * Marks open concessions for these phones as honored at eventId. Concessions made at
 * eventId itself stay open: giving something up tonight earns priority next time.
 */
export function redeem(concessions: readonly Concession[], phones: readonly string[], eventId: string): Concession[] {
  const target = new Set(phones);
  return concessions.map((c) =>
    !c.redeemedInEventId && target.has(c.phone) && c.eventId !== eventId ? { ...c, redeemedInEventId: eventId } : c,
  );
}

/**
 * "Maya gave up a pick last time, so Maya gets priority tonight." Worded to avoid
 * gendered pronouns. Returns undefined when nobody has priority.
 */
export function fairnessNote(input: { people: readonly Person[]; priorityPhones: readonly string[] }): string | undefined {
  const names = input.priorityPhones
    .map((phone) => input.people.find((p) => p.phone === phone)?.name)
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return undefined;
  if (names.length === 1) return `${names[0]} gave up a pick last time, so ${names[0]} gets priority tonight.`;
  return `${joinNames(names)} gave up a pick last time, so they get priority tonight.`;
}
