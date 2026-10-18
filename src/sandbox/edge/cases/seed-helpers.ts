// Shared helpers for edge cases: seed a dinner straight to a stage through the
// service (free, no Claude), and read a CaseHistory when writing checks.
// Seeds throw on anything unexpected so a broken seed fails loudly in tests.

import { MemoryStore, tryNormalizePhone } from "../../../events/index.js";
import {
  FoSquadService,
  type AddReceiptArgs,
  type OrganizerPickArg,
  type RecordPreferencesArgs,
  type SetRestaurantOptionsArgs,
  type SlotArg,
  type ToolResult,
} from "../../../service.js";
import { runServiceCall, TOOLS } from "../../../tools.js";
import type { DinnerEvent, Person } from "../../../types.js";
import type { SandboxEvent } from "../../events.js";
import { DEFAULT_TIME_ZONE, defaultScenario, DUMMY_RECEIPT } from "../../scenario.js";
import { localParts, zonedTime } from "../../time.js";
import type { CaseHistory, SeedContext, SeedPerson, ToolCallRecord } from "../types.js";

// ---------- Cast and defaults ----------

const castScenario = defaultScenario({ now: new Date("2026-10-14T16:00:00Z") });

/** Default cast: Pranav (organizer), Maya, Jordan, Sam, Priya, Alex. */
export const DEFAULT_PEOPLE: SeedPerson[] = [
  { id: castScenario.organizer.id, name: castScenario.organizer.name, phone: castScenario.organizer.phone, isOrganizer: true },
  ...castScenario.friends.map((f) => ({ id: f.id, name: f.name, phone: f.phone, isOrganizer: false })),
];

export const DEFAULT_VENMO = castScenario.organizer.venmo;
export const DEFAULT_TITLE = "Saturday dinner";

export interface RestaurantSeed {
  name: string;
  cuisine?: string;
  price_per_person?: number;
  notes?: string;
}

/** Ballot order 1, 2, 3. With DEFAULT_VOTES, 1 wins and 2 is the runner up. */
export const DEFAULT_RESTAURANTS: RestaurantSeed[] = [
  { name: "Osteria Marco", cuisine: "italian", price_per_person: 45 },
  { name: "Tavola Trattoria", cuisine: "italian", price_per_person: 40 },
  { name: "Luigi's Trattoria", cuisine: "italian", price_per_person: 35 },
];

/** 4 votes for option 1, 2 for option 2, none for 3. */
export const DEFAULT_VOTES: Record<string, string> = {
  pranav: "1",
  maya: "1",
  jordan: "2",
  sam: "1",
  priya: "2",
  alex: "1",
};

/** Claims covering every DUMMY_RECEIPT item; Alex didn't come. Garlic bread (4) is shared three ways. */
export const DEFAULT_CLAIMS: Record<string, number[]> = {
  pranav: [7, 9],
  maya: [4, 5],
  jordan: [2, 3, 4],
  sam: [6, 8],
  priya: [1, 4],
};

export const DEFAULT_ATTENDEES = ["pranav", "maya", "jordan", "sam", "priya"];

/**
 * Fri 7pm, Sat 6pm, Sat 7:30pm, Sun 6pm (ids A to D) on the next weekend at
 * least a day after `now`, in the case's zone.
 */
export function weekendSlots(now: Date, timeZone: string = DEFAULT_TIME_ZONE): SlotArg[] {
  const today = localParts(timeZone, now);
  const toFriday = (5 - today.weekday + 7) % 7 || 7;
  const at = (offset: number, hour: number, minute = 0) => {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + toFriday + offset));
    return zonedTime(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute).toISOString();
  };
  return [
    { label: "Fri 7pm", starts_at: at(0, 19) },
    { label: "Sat 6pm", starts_at: at(1, 18) },
    { label: "Sat 7:30pm", starts_at: at(1, 19, 30) },
    { label: "Sun 6pm", starts_at: at(2, 18) },
  ];
}

// ---------- Seeding ----------

export type PrefSeed = Omit<RecordPreferencesArgs, "event_id" | "person" | "slot_ids"> & { slot_ids?: string[] };

export interface PlanningOptions {
  title?: string;
  /** Friend ids to invite. Default: everyone in ctx.people but the organizer. */
  friends?: string[];
  slots?: SlotArg[];
  /** null = no budget. Default 50. */
  budgetPerPerson?: number | null;
  /** null = no hint. Default "Italian". */
  cuisineHint?: string | null;
  organizerPick?: OrganizerPickArg;
  /** Minutes from now. Default: the server's 2 hours. */
  replyDeadlineMinutes?: number;
  /** null = no Venmo yet. */
  venmo?: string | null;
  /** Round 1 answers by person id, recorded in key order. */
  preferences?: Record<string, PrefSeed>;
}

export interface Seeded {
  eventId: string;
  organizer: SeedPerson;
  friends: SeedPerson[];
  slots: SlotArg[];
}

export function seedPerson(ctx: Pick<SeedContext, "people">, id: string): SeedPerson {
  const p = ctx.people.find((x) => x.id === id);
  if (!p) throw new Error(`Seed: no person "${id}" in the cast.`);
  return p;
}

export function seedOrganizer(ctx: Pick<SeedContext, "people">): SeedPerson {
  const p = ctx.people.find((x) => x.isOrganizer);
  if (!p) throw new Error("Seed: the cast has no organizer.");
  return p;
}

function expectOk(what: string, result: ToolResult): ToolResult {
  if (result.ok !== true) throw new Error(`Seed: ${what} failed: ${JSON.stringify(result)}`);
  return result;
}

/** Created event in Planning, with any round 1 answers already in. */
export async function seedToPlanning(ctx: SeedContext, opts: PlanningOptions = {}): Promise<Seeded> {
  const organizer = seedOrganizer(ctx);
  const friends = opts.friends
    ? opts.friends.map((id) => seedPerson(ctx, id))
    : ctx.people.filter((p) => !p.isOrganizer);
  const slots = opts.slots ?? weekendSlots(ctx.now(), ctx.timeZone);
  const venmo = opts.venmo === undefined ? DEFAULT_VENMO : opts.venmo;
  const created = expectOk(
    "create_event",
    await ctx.service.createEvent({
      title: opts.title ?? DEFAULT_TITLE,
      organizer: { name: organizer.name, phone: organizer.phone, ...(venmo ? { venmo } : {}) },
      friends: friends.map((f) => ({ name: f.name, phone: f.phone })),
      time_slots: slots,
      ...(opts.budgetPerPerson !== null ? { budget_per_person: opts.budgetPerPerson ?? 50 } : {}),
      ...(opts.cuisineHint !== null ? { cuisine_hint: opts.cuisineHint ?? "Italian" } : {}),
      ...(opts.organizerPick ? { organizer_pick: opts.organizerPick } : {}),
      ...(opts.replyDeadlineMinutes !== undefined
        ? { reply_deadline: new Date(ctx.now().getTime() + opts.replyDeadlineMinutes * 60_000).toISOString() }
        : {}),
    }),
  );
  const eventId = String(created.event_id);
  for (const [person, { slot_ids, ...rest }] of Object.entries(opts.preferences ?? {})) {
    expectOk(
      `record_preferences for ${person}`,
      await ctx.service.recordPreferences({ event_id: eventId, person, slot_ids: slot_ids ?? [], ...rest }),
    );
  }
  return { eventId, organizer, friends, slots };
}

export interface TimePickedOptions extends PlanningOptions {
  /** Move the clock past the reply deadline before picking. Default false. */
  pastDeadline?: boolean;
}

/** Everyone free at C (Sat 7:30pm) unless preferences are given. */
export function defaultPreferences(ctx: Pick<SeedContext, "people">, friendIds?: string[]): Record<string, PrefSeed> {
  const ids = friendIds ?? ctx.people.filter((p) => !p.isOrganizer).map((p) => p.id);
  return Object.fromEntries(ids.map((id) => [id, { slot_ids: ["C"] }]));
}

/** Planning with pick_time decided (chosenSlotId set). */
export async function seedToTimePicked(
  ctx: SeedContext,
  opts: TimePickedOptions = {},
): Promise<Seeded & { chosenSlotId: string; partySize: number }> {
  const seeded = await seedToPlanning(ctx, {
    ...opts,
    preferences: opts.preferences ?? defaultPreferences(ctx, opts.friends),
  });
  if (opts.pastDeadline) ctx.advanceMinutes((opts.replyDeadlineMinutes ?? 120) + 5);
  const picked = expectOk("pick_time", await ctx.service.pickTime({ event_id: seeded.eventId, force: true }));
  if (picked.decided !== true) throw new Error(`Seed: pick_time didn't decide: ${JSON.stringify(picked)}`);
  const slot = picked.slot as { id: string };
  return { ...seeded, chosenSlotId: slot.id, partySize: Number(picked.party_size) };
}

export interface VotingOptions extends TimePickedOptions {
  restaurants?: RestaurantSeed[];
  /** Votes by person id (option id or name). Default none. */
  votes?: Record<string, string>;
  /** Run tally_votes (force) after the votes, so a winner is set. Default false. */
  tally?: boolean;
}

/** Voting stage with the ballot open, optional votes, optionally tallied. */
export async function seedToVoting(
  ctx: SeedContext,
  opts: VotingOptions = {},
): Promise<Seeded & { chosenSlotId: string; winnerId?: string; winnerName?: string }> {
  const picked = await seedToTimePicked(ctx, opts);
  const options: SetRestaurantOptionsArgs["options"] = opts.restaurants ?? DEFAULT_RESTAURANTS;
  expectOk("set_restaurant_options", await ctx.service.setRestaurantOptions({ event_id: picked.eventId, options }));
  for (const [person, option] of Object.entries(opts.votes ?? {})) {
    expectOk(`record_vote for ${person}`, await ctx.service.recordVote({ event_id: picked.eventId, person, option }));
  }
  if (!opts.tally) return picked;
  const tally = expectOk("tally_votes", await ctx.service.tallyVotes({ event_id: picked.eventId, force: true }));
  if (tally.decided !== true) throw new Error(`Seed: tally_votes didn't decide: ${JSON.stringify(tally)}`);
  const winner = tally.winner as { id: string; name: string };
  return { ...picked, winnerId: winner.id, winnerName: winner.name };
}

export interface BookedOptions extends VotingOptions {
  /**
   * "vote" (default): ballot, DEFAULT_VOTES unless votes given, tally, book the winner.
   * "locked": book organizerPick (default a locked Osteria Marco) with no vote.
   */
  via?: "vote" | "locked";
  /** Override the booked restaurant name. */
  restaurant?: string;
  confirmation?: string;
  deposit?: number;
  autoGratuity?: boolean;
  partySize?: number;
  notes?: string;
}

/** Booked stage: confirm_booking from the organizer's phone. */
export async function seedToBooked(
  ctx: SeedContext,
  opts: BookedOptions = {},
): Promise<Seeded & { chosenSlotId: string; restaurant: string }> {
  let base: Seeded & { chosenSlotId: string };
  let restaurant: string;
  if (opts.via === "locked") {
    const pick = opts.organizerPick ?? { restaurant_name: DEFAULT_RESTAURANTS[0]!.name, firmness: "locked" as const };
    base = await seedToTimePicked(ctx, { ...opts, organizerPick: pick });
    restaurant = opts.restaurant ?? pick.restaurant_name;
  } else {
    const voted = await seedToVoting(ctx, { ...opts, votes: opts.votes ?? DEFAULT_VOTES, tally: true });
    base = voted;
    restaurant = opts.restaurant ?? voted.winnerName!;
  }
  expectOk(
    "confirm_booking",
    await ctx.service.confirmBooking({
      event_id: base.eventId,
      by_phone: base.organizer.phone,
      restaurant_name: restaurant,
      confirmation: opts.confirmation ?? "SANDBOX-SEED-1",
      ...(opts.deposit !== undefined ? { deposit: opts.deposit } : {}),
      ...(opts.autoGratuity ? { auto_gratuity: true } : {}),
      ...(opts.partySize !== undefined ? { party_size: opts.partySize } : {}),
      ...(opts.notes ? { notes: opts.notes } : {}),
    }),
  );
  return { ...base, restaurant };
}

export type ReceiptSeed = Omit<AddReceiptArgs, "event_id">;

/** DUMMY_RECEIPT as add_receipt args: 9 items, $141.87. */
export function dummyReceiptArgs(): ReceiptSeed {
  return {
    items: DUMMY_RECEIPT.items.map((i) => ({ description: i.description, amount: i.amount })),
    subtotal: DUMMY_RECEIPT.subtotal,
    tax: DUMMY_RECEIPT.tax,
    tip: DUMMY_RECEIPT.tip,
    total: DUMMY_RECEIPT.total,
  };
}

export interface ClaimingOptions extends BookedOptions {
  /** Default: the dummy receipt. */
  receipt?: ReceiptSeed;
  /** Person ids who came. Default everyone but Alex; null = don't call set_attendees. */
  attendees?: string[] | null;
  /** Move the clock to this many minutes after the booked start. Default 150; null = don't move. */
  afterDinnerMinutes?: number | null;
}

/** Claiming stage: booked, dinner over, receipt added, attendees set (no claims yet). */
export async function seedToClaiming(
  ctx: SeedContext,
  opts: ClaimingOptions = {},
): Promise<Seeded & { chosenSlotId: string; restaurant: string; attendees: string[] }> {
  const booked = await seedToBooked(ctx, opts);
  if (opts.afterDinnerMinutes !== null) {
    const startsAt = Date.parse(booked.slots[booked.chosenSlotId.charCodeAt(0) - 65]!.starts_at);
    const target = startsAt + (opts.afterDinnerMinutes ?? 150) * 60_000;
    const minutes = Math.ceil((target - ctx.now().getTime()) / 60_000);
    if (minutes > 0) ctx.advanceMinutes(minutes);
  }
  expectOk("add_receipt", await ctx.service.addReceipt({ event_id: booked.eventId, ...(opts.receipt ?? dummyReceiptArgs()) }));
  const attendees = opts.attendees === null ? [] : (opts.attendees ?? DEFAULT_ATTENDEES);
  if (opts.attendees !== null) {
    expectOk("set_attendees", await ctx.service.setAttendees({ event_id: booked.eventId, people: attendees }));
  }
  return { ...booked, attendees };
}

export interface PayingOptions extends ClaimingOptions {
  /** Item numbers by person id. Default DEFAULT_CLAIMS. */
  claims?: Record<string, number[]>;
  unclaimedPolicy?: "block" | "split_evenly";
  treated?: string[];
  /** Payment states to apply after totals: "says_paid" (from their phone) or "paid" (organizer). */
  payments?: Record<string, "says_paid" | "paid">;
}

/** Paying stage: claims in, calculate_shares approved by the organizer, optional payments. */
export async function seedToPaying(
  ctx: SeedContext,
  opts: PayingOptions = {},
): Promise<Seeded & { chosenSlotId: string; restaurant: string; attendees: string[] }> {
  const claiming = await seedToClaiming(ctx, opts);
  for (const [person, items] of Object.entries(opts.claims ?? DEFAULT_CLAIMS)) {
    expectOk(
      `record_claims for ${person}`,
      await ctx.service.recordClaims({ event_id: claiming.eventId, person, items: items.map((number) => ({ number })) }),
    );
  }
  expectOk(
    "calculate_shares",
    await ctx.service.calculateShares({
      event_id: claiming.eventId,
      by_phone: claiming.organizer.phone,
      ...(opts.unclaimedPolicy ? { unclaimed_policy: opts.unclaimedPolicy } : {}),
      ...(opts.treated ? { treated: opts.treated } : {}),
    }),
  );
  for (const [person, status] of Object.entries(opts.payments ?? {})) {
    const by = status === "paid" ? claiming.organizer.phone : seedPerson(ctx, person).phone;
    expectOk(`mark_paid for ${person}`, await ctx.service.markPaid({ event_id: claiming.eventId, person, by_phone: by }));
  }
  return claiming;
}

/** A SeedContext on a fixed simulated clock with a fresh MemoryStore, for tests. */
export function makeSeedContext(start: Date = new Date("2026-10-14T16:00:00Z")): {
  ctx: SeedContext;
  store: MemoryStore;
} {
  let t = start.getTime();
  const store = new MemoryStore();
  const service = new FoSquadService(store, () => new Date(t));
  const ctx: SeedContext = {
    service,
    now: () => new Date(t),
    advanceMinutes: (m) => {
      t += m * 60_000;
    },
    people: DEFAULT_PEOPLE.map((p) => ({ ...p })),
    timeZone: DEFAULT_TIME_ZONE,
  };
  return { ctx, store };
}

// ---------- Reading a CaseHistory ----------

export type Pass = true | string;

export function organizerOf(h: CaseHistory): Person {
  const p = h.finalEvent.people.find((x) => x.isOrganizer);
  if (!p) throw new Error("The final event has no organizer.");
  return p;
}

export function samePhone(raw: unknown, phone: string | undefined): boolean {
  return !!phone && typeof raw === "string" && (tryNormalizePhone(raw) ?? raw) === phone;
}

/** Whether a `person` arg (id, name or phone) refers to this person. */
export function refersTo(h: CaseHistory, ref: unknown, personId: string): boolean {
  if (typeof ref !== "string") return false;
  const p = h.finalEvent.people.find((x) => x.id === personId);
  if (!p) return ref.trim().toLowerCase() === personId;
  const r = ref.trim().toLowerCase();
  return r === p.id || r === p.name.toLowerCase() || samePhone(ref, p.phone);
}

/** A tool result as an object, whether the harness kept it parsed or as JSON text. */
export function resultOf(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** "$60", "60.00", 60 -> 60. NaN when it isn't money. */
export function dollars(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const cleaned = value.replace(/[$,\s]/g, "");
  return cleaned ? Number(cleaned) : Number.NaN;
}

export function callsNamed(h: CaseHistory, name: string): ToolCallRecord[] {
  return h.toolCalls.filter((c) => c.name === name);
}

export function okCallsNamed(h: CaseHistory, name: string): ToolCallRecord[] {
  return callsNamed(h, name).filter((c) => c.ok);
}

/** Fails if any call to `name` passed a by_phone that isn't the organizer's. */
export function onlyOrganizerByPhone(h: CaseHistory, name: string): Pass {
  const org = organizerOf(h);
  const bad = callsNamed(h, name).filter((c) => !samePhone(c.args.by_phone, org.phone));
  return bad.length === 0 || `${name} called with by_phone ${bad.map((c) => String(c.args.by_phone)).join(", ")}, not the organizer's`;
}

/** Every text Fo sent to anyone except these people. */
export function textsExcept(h: CaseHistory, ...personIds: string[]): { to: string; text: string }[] {
  return h.allTexts().filter((t) => !personIds.includes(t.to));
}

type Indexed<T> = T & { index: number };
type TextEvent = Extract<SandboxEvent, { type: "text" }>;
type ToolEvent = Extract<SandboxEvent, { type: "tool" }>;

export function indexedTexts(h: CaseHistory): Indexed<TextEvent>[] {
  return h.events.flatMap((e, index) => (e.type === "text" ? [{ ...e, index }] : []));
}

/** Fo's texts to `to`, with their position in the event stream. */
export function textsFromFo(h: CaseHistory, to: string): Indexed<TextEvent>[] {
  return indexedTexts(h).filter((e) => e.from === "fo" && e.to === to);
}

/** Texts `from` sent to Fo (scripted inbound steps and replies). */
export function textsToFo(h: CaseHistory, from: string): Indexed<TextEvent>[] {
  return indexedTexts(h).filter((e) => e.from === from && e.to === "fo");
}

export function toolEvents(h: CaseHistory, name: string): Indexed<ToolEvent>[] {
  return h.events.flatMap((e, index) => (e.type === "tool" && e.name === name ? [{ ...e, index }] : []));
}

/**
 * Restaurant calls in order, from `tool` events named call_restaurant when the
 * harness emits them, else from `stubbed` call_restaurant events (whose detail
 * starts with "<restaurant>: ").
 */
export function restaurantCalls(h: CaseHistory): { index: number; restaurant: string }[] {
  const tools = toolEvents(h, "call_restaurant");
  if (tools.length) return tools.map((e) => ({ index: e.index, restaurant: String(resultOf(e.args).restaurant ?? "") }));
  return h.events.flatMap((e, index) =>
    e.type === "stubbed" && e.action === "call_restaurant"
      ? [{ index, restaurant: e.detail.split(/:\s/)[0] ?? e.detail }]
      : [],
  );
}

// ---------- Synthetic histories (tests) ----------

/** Builds a CaseHistory in order, for testing checks without a run. */
export class HistoryBuilder {
  readonly events: SandboxEvent[] = [];
  readonly toolCalls: ToolCallRecord[] = [];
  private readonly at = "2026-10-14T16:00:00.000Z";

  text(to: string, text: string): this {
    this.events.push({ type: "text", at: this.at, from: "fo", to, text });
    return this;
  }

  inbound(from: string, text: string): this {
    this.events.push({ type: "text", at: this.at, from, to: "fo", text });
    return this;
  }

  tool(name: string, args: Record<string, unknown>, result: Record<string, unknown> = { ok: true }, triggeredBy = "pranav"): this {
    const ok = result.ok !== false;
    this.events.push({ type: "tool", at: this.at, name, args, result, ok });
    this.toolCalls.push({ name, args, ok, result, triggeredBy });
    return this;
  }

  /** Runs a real Fo Squad tool against the service and records the call. */
  async run(
    service: FoSquadService,
    name: string,
    args: Record<string, unknown>,
    triggeredBy = "pranav",
  ): Promise<Record<string, unknown>> {
    const def = TOOLS.find((t) => t.name === name);
    if (!def) throw new Error(`No Fo Squad tool named ${name}.`);
    const { result } = await runServiceCall(name, () => def.run(service, args));
    this.tool(name, args, result, triggeredBy);
    return result;
  }

  stub(action: string, detail: string): this {
    this.events.push({ type: "stubbed", at: this.at, action, detail });
    return this;
  }

  build(finalEvent: DinnerEvent): CaseHistory {
    const events = [...this.events];
    const texts = events.flatMap((e) => (e.type === "text" && e.from === "fo" ? [{ to: e.to, text: e.text }] : []));
    return {
      events,
      toolCalls: [...this.toolCalls],
      textsTo: (id) => texts.filter((t) => t.to === id).map((t) => t.text),
      allTexts: () => [...texts],
      finalEvent,
      stubbed: events.flatMap((e) => (e.type === "stubbed" ? [{ action: e.action, detail: e.detail }] : [])),
    };
  }
}
