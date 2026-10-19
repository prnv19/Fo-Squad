// Business rules for every MCP tool. Takes already-validated snake_case args,
// returns plain JSON-able objects, and throws FoError for anything Fo should
// relay to the organizer. No MCP imports: src/server.ts is a thin wrapper.

import {
  assertCanText,
  assertOrganizer,
  assertStage,
  assertUniqueContacts,
  channelOf,
  contactLabel,
  contactsOf,
  tryNormalizeContact,
  createEvent,
  DEFAULT_REPLY_WINDOW_MS,
  FoError,
  generateEventId,
  getOrganizer,
  getStatus,
  hasContact,
  isOrganizerContact,
  primaryContact,
  requirePerson,
  resolvePerson,
  shiftWaiting,
  slugId,
  transition,
  updateEvent,
  withEventLock,
  type EventStore,
} from "./events/index.js";
import { contactFor } from "./events/factory.js";
import { billQuestionAt, dayOfReminderAt, DEFAULT_TIME_ZONE } from "./events/zone.js";
import {
  fairnessNote,
  filterRestaurantOptions,
  hardConstraints,
  isLateReply,
  joinNames,
  newConcessions,
  pickCuisine,
  pickTime,
  priorityIds,
  redeem,
  tallyVotes,
  type HardConstraints,
  type PickCuisineResult,
  type PickTimeResult,
} from "./planning/index.js";
import {
  analyzeClaims,
  buildShareMessage,
  buildSplitInput,
  buildVenmoLink,
  type VenmoLink,
  computeSplit,
  formatCents,
  nextItemNumber,
  parseClaimReply,
  parseDollars,
  validateReceipt,
} from "./split/index.js";
import type {
  Cents,
  Claim,
  Concession,
  DinnerEvent,
  LineItem,
  Person,
  PersonShare,
  Preferences,
  Receipt,
  RestaurantOption,
  ShiftCheck,
  SplitError,
  TimeSlot,
} from "./types.js";

export type Money = string | number;
export type ToolResult = Record<string, unknown>;

// ---------- Tool args (snake_case, as they arrive over MCP) ----------

export interface SlotArg {
  label: string;
  starts_at: string;
}
/** Phone for people Fo texts, email for people Fo emails; at least one. */
export interface FriendArg {
  name: string;
  phone?: string;
  email?: string;
}

/** Who a request came from: by_phone for a text, by_email for an email. */
export interface SenderArgs {
  by_phone?: string;
  by_email?: string;
}
export interface OrganizerPickArg {
  restaurant_name: string;
  firmness: "locked" | "suggested";
}

export interface CreateEventArgs {
  title: string;
  organizer: { name: string; phone?: string; email?: string; venmo?: string };
  friends: FriendArg[];
  time_slots?: SlotArg[];
  budget_per_person?: Money;
  cuisine_hint?: string;
  reply_deadline?: string;
  organizer_pick?: OrganizerPickArg;
  /** A receipt (no time_slots) from a different meal than the organizer's open dinner. */
  separate_dinner?: boolean;
}

export interface UpdateEventArgs extends SenderArgs {
  event_id: string;
  time_slots?: SlotArg[];
  organizer_pick?: OrganizerPickArg;
  organizer_venmo?: string;
  reply_deadline?: string;
  fix_phone?: { person: string; phone: string };
  fix_email?: { person: string; email: string };
  add_friends?: FriendArg[];
  remove_friends?: string[];
}

export interface RecordPreferencesArgs {
  event_id: string;
  person: string;
  slot_ids: string[];
  any_time?: boolean;
  cuisines?: string[];
  avoid_cuisines?: string[];
  dietary?: string[];
  budget?: Money;
  plus_ones?: number;
}

export interface PersonArgs {
  event_id: string;
  person: string;
}

export interface ForceArgs {
  event_id: string;
  force?: boolean;
}

export interface PickTimeArgs extends ForceArgs {
  /** The organizer said to decide now, without asking whoever would miss out. */
  skip_shift_check?: boolean;
}

export interface SetRestaurantOptionsArgs {
  event_id: string;
  options: { name: string; cuisine?: string; price_per_person?: Money; notes?: string }[];
}

export interface RecordVoteArgs {
  event_id: string;
  person: string;
  option: string;
}

export interface ConfirmBookingArgs extends SenderArgs {
  event_id: string;
  restaurant_name: string;
  slot_id?: string;
  party_size?: number;
  confirmation?: string;
  deposit?: Money;
  auto_gratuity?: boolean;
  notes?: string;
}

export interface AddReceiptArgs extends SenderArgs {
  event_id: string;
  items: { description: string; amount: Money }[];
  subtotal: Money;
  tax: Money;
  tip: Money;
  fees?: Money;
  discount?: Money;
  total: Money;
  tip_included?: boolean;
  deposit_credit?: Money;
}

export interface SetAttendeesArgs {
  event_id: string;
  people: string[];
}

export interface RecordClaimsArgs {
  event_id: string;
  claim?: string;
  person?: string;
  items?: { number: number; weight?: number }[];
}

export interface CalculateSharesArgs extends SenderArgs {
  event_id: string;
  unclaimed_policy?: "block" | "split_evenly";
  treated?: string[];
  fees_split_evenly?: boolean;
}

export interface CoverBillArgs extends SenderArgs {
  event_id: string;
}

export interface SendTotalsArgs extends SenderArgs {
  event_id: string;
}

export interface GetStatusArgs {
  event_id?: string;
  phone?: string;
  email?: string;
}

// ---------- Small pure helpers ----------

const MAX_SLOTS = 26;
/** How long the people asked to shift get to answer before pick_time decides anyway. */
const SHIFT_WINDOW_MS = 30 * 60 * 1000;

/**
 * "(Italian, ~$45)": enough for friends to choose between options. Never the
 * notes, which may say why a place was picked (someone's diet or budget), and
 * no price on the organizer's treat, where it would read as what they'll pay.
 */
function ballotTag(o: RestaurantOption, treat: boolean): string {
  const parts = [
    ...(o.cuisine ? [o.cuisine] : []),
    ...(o.pricePerPersonCents !== undefined && !treat ? [`~${formatCents(o.pricePerPersonCents).replace(/\.00$/, "")}`] : []),
  ];
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** Whether the meal is over (or under way): a booked table's start has passed, or it was a split-only night. */
function mealHappened(e: DinnerEvent, nowIso: string): boolean {
  if (e.booking) return Date.parse(nowIso) >= Date.parse(e.booking.startsAt);
  if (e.timeSlots.length === 0) return true;
  return e.stage !== "planning" && e.stage !== "voting";
}

/** The booked meal hasn't started yet, so there's no bill to split or cover. */
function assertMealHappened(e: DinnerEvent, nowIso: string, doing: string): void {
  if (e.booking && Date.parse(nowIso) < Date.parse(e.booking.startsAt)) {
    const when = slotLabel(e, e.booking.slotId) ?? e.booking.startsAt;
    throw new FoError(
      "NOT_YET",
      `"${e.title}" is booked for ${when} and hasn't happened yet, so I can't ${doing} now. Ask about the bill after it.`,
    );
  }
}

function invalid(message: string): FoError {
  return new FoError("INVALID_INPUT", message);
}

function parseMoney(value: Money, what: string): Cents {
  try {
    return parseDollars(value);
  } catch (err) {
    throw invalid(`The ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseNonNegative(value: Money | undefined, what: string): Cents {
  if (value === undefined) return 0;
  const cents = parseMoney(value, what);
  if (cents < 0) throw invalid(`The ${what} can't be negative.`);
  return cents;
}

function tags(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean))].sort();
}

function cleanVenmo(raw: string): string | undefined {
  const handle = raw.trim().replace(/^@+/, "");
  if (!handle) return undefined;
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(handle)) throw invalid(`"${raw}" doesn't look like a Venmo username.`);
  return handle;
}

/** The phone number or email the request came from: exactly one of by_phone and by_email. */
function senderOf(args: SenderArgs): string {
  const phone = args.by_phone?.trim();
  const email = args.by_email?.trim();
  if (phone && email) throw invalid("Pass by_phone for a text or by_email for an email, not both.");
  if (!phone && !email) throw invalid("Say who this came from: by_phone for a text or by_email for an email.");
  return (phone || email)!;
}

/** "text Maya (+1555...) and Jordan (+1555...), and email Sam (sam@x.com)". */
function reachList(people: Person[]): string {
  const texted = people.filter((p) => channelOf(p) === "text").map(contactLabel);
  const emailed = people.filter((p) => channelOf(p) === "email").map(contactLabel);
  return [texted.length ? `text ${joinNames(texted)}` : "", emailed.length ? `email ${joinNames(emailed)}` : ""]
    .filter(Boolean)
    .join(", and ");
}

function buildSlots(slots: SlotArg[]): TimeSlot[] {
  if (slots.length > MAX_SLOTS) throw invalid(`At most ${MAX_SLOTS} time options, please.`);
  return slots.map((s, i) => {
    const id = String.fromCharCode(65 + i);
    const label = s.label.trim();
    if (!label) throw invalid(`Time option ${id} needs a label like "Sat 7:30pm".`);
    if (Number.isNaN(Date.parse(s.starts_at))) {
      throw invalid(`Time option ${id} (${label}) needs a valid start time.`);
    }
    return { id, label, startsAt: s.starts_at };
  });
}

function futureDeadline(raw: string, nowMs: number): string {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw invalid(`"${raw}" isn't a valid reply deadline.`);
  if (ms <= nowMs) throw invalid("The reply deadline has to be in the future.");
  return new Date(ms).toISOString();
}

/** Compares state while ignoring updatedAt, so a repeated call doesn't look like a change. */
function sameState(a: DinnerEvent, b: DinnerEvent): boolean {
  return JSON.stringify({ ...a, updatedAt: "" }) === JSON.stringify({ ...b, updatedAt: "" });
}

const nameOf = (event: DinnerEvent, id: string): string =>
  event.people.find((p) => p.id === id)?.name ?? id;
const namesOf = (event: DinnerEvent, ids: readonly string[]): string[] => ids.map((id) => nameOf(event, id));
/** Priority person ids as the contacts fairnessNote matches on. */
const priorityContactsOf = (event: DinnerEvent, ids: readonly string[]): string[] =>
  ids.flatMap((id) => {
    const p = event.people.find((x) => x.id === id);
    return p ? [primaryContact(p)] : [];
  });
const nameMap = (event: DinnerEvent): Record<string, string> =>
  Object.fromEntries(event.people.map((p) => [p.id, p.name]));

function slotLabel(event: DinnerEvent, slotId: string | undefined): string | undefined {
  return slotId ? (event.timeSlots.find((s) => s.id === slotId)?.label ?? slotId) : undefined;
}

function slotJson(s: TimeSlot) {
  return { id: s.id, label: s.label, starts_at: s.startsAt };
}

function organizerJson(event: DinnerEvent) {
  const o = event.people.find((p) => p.id === event.organizerId);
  return o ? { id: o.id, name: o.name, ...contactJson(o) } : undefined;
}

/** phone and/or email, plus the channel Fo uses to reach them. */
function contactJson(p: Person) {
  return { ...(p.phone ? { phone: p.phone } : {}), ...(p.email ? { email: p.email } : {}), channel: channelOf(p) };
}

function peopleJson(event: DinnerEvent) {
  return event.people.map((p) => ({
    id: p.id,
    name: p.name,
    ...contactJson(p),
    is_organizer: p.isOrganizer,
    ...(p.optedOut ? { opted_out: true } : {}),
  }));
}

function itemJson(i: LineItem) {
  return { number: i.number, description: i.description, amount_cents: i.amountCents, amount: formatCents(i.amountCents) };
}

function itemList(items: LineItem[]): string {
  return items.map((i) => `${i.number}) ${i.description} ${formatCents(i.amountCents)}`).join("  ");
}

function canAttend(pref: Preferences, slotId: string): boolean {
  return pref.anyTime || pref.slotIds.includes(slotId);
}

/** Replies that count for time decisions: current answers from people Fo may text. */
function timePrefs(event: DinnerEvent): Preferences[] {
  const active = new Set(event.people.filter((p) => !p.optedOut).map((p) => p.id));
  return event.preferences.filter((p) => active.has(p.personId) && !p.slotsStale);
}

/**
 * The organizer proposed the time options, so if they never answered round 1
 * they count as free for all of them. Only used as pickTime input, never saved,
 * otherwise party_size would come out one short.
 */
function withOrganizer(event: DinnerEvent, prefs: Preferences[], nowIso: string): Preferences[] {
  if (prefs.some((p) => p.personId === event.organizerId)) return prefs;
  return [
    ...prefs,
    {
      personId: event.organizerId,
      slotIds: [],
      anyTime: true,
      cuisines: [],
      avoidCuisines: [],
      dietary: [],
      plusOnes: 0,
      updatedAt: nowIso,
    },
  ];
}

/** Same count pickTime uses: respondents free at the slot plus their plus-ones. */
function partySizeFor(event: DinnerEvent, slotId: string, nowIso: string): number {
  return withOrganizer(event, timePrefs(event), nowIso)
    .filter((p) => canAttend(p, slotId))
    .reduce((sum, p) => sum + 1 + Math.max(0, p.plusOnes || 0), 0);
}

/**
 * Friends who'd miss out at the best slots (every slot tied for the most free),
 * with the ones they'd miss, so each can be asked privately if one could work.
 */
function shiftAsks(event: DinnerEvent, time: PickTimeResult, prefs: Preferences[]): ShiftCheck["asks"] {
  const most = time.ranking[0]?.count ?? 0;
  const top = time.ranking.filter((r) => r.count === most).map((r) => r.slotId);
  return event.people.flatMap((person) => {
    if (person.id === event.organizerId) return [];
    const pref = prefs.find((p) => p.personId === person.id);
    const missed = pref ? top.filter((s) => !canAttend(pref, s)) : [];
    return missed.length ? [{ personId: person.id, slotIds: missed }] : [];
  });
}

/** Mirrors getStatus: people with no current answer might still come, so they can vote. */
function canMakeChosenSlot(event: DinnerEvent, person: Person): boolean {
  if (!event.chosenSlotId || person.id === event.organizerId) return true;
  const pref = event.preferences.find((p) => p.personId === person.id);
  if (!pref || pref.slotsStale) return true;
  return canAttend(pref, event.chosenSlotId);
}

function voters(event: DinnerEvent): Person[] {
  return event.people.filter((p) => !p.optedOut && canMakeChosenSlot(event, p));
}

/** Hard constraints from everyone who answered and can make the chosen slot. */
function constraintsFor(event: DinnerEvent): HardConstraints {
  const going = new Set(voters(event).map((p) => p.id));
  const input: { preferences: Preferences[]; groupBudgetCents?: Cents } = {
    preferences: event.preferences.filter((p) => going.has(p.personId)),
  };
  if (event.budgetPerPersonCents !== undefined) input.groupBudgetCents = event.budgetPerPersonCents;
  return hardConstraints(input);
}

function constraintsJson(c: HardConstraints) {
  // A number only: whose budget it is never leaves the server.
  return {
    dietary: c.dietary,
    avoid_cuisines: c.avoidCuisines,
    ...(c.maxBudgetPerPersonCents !== undefined
      ? {
          max_budget_per_person_cents: c.maxBudgetPerPersonCents,
          max_budget_per_person: formatCents(c.maxBudgetPerPersonCents),
        }
      : {}),
  };
}

function describeItems(event: DinnerEvent, numbers: number[]): string {
  const items = event.receipts.flatMap((r) => r.items);
  return joinNames(
    numbers.map((n) => {
      const item = items.find((i) => i.number === n);
      return item ? `${n}) ${item.description} ${formatCents(item.amountCents)}` : `item ${n}`;
    }),
  );
}

function splitErrorMessage(event: DinnerEvent, error: SplitError): string {
  switch (error.code) {
    case "UNCLAIMED_ITEMS":
      return `Nobody has claimed ${describeItems(event, error.itemNumbers)} yet. Ask who had ${error.itemNumbers.length > 1 ? "them" : "it"}, or the organizer can split ${error.itemNumbers.length > 1 ? "them" : "it"} evenly with unclaimed_policy "split_evenly".`;
    case "UNKNOWN_ITEM":
      return `Item ${error.itemNumbers.join(", ")} ${error.itemNumbers.length > 1 ? "aren't" : "isn't"} on the receipt. Fix those claims with record_claims.`;
    case "NON_ATTENDEE_CLAIM":
      return `${joinNames(namesOf(event, error.personIds))} claimed items but ${error.personIds.length > 1 ? "aren't" : "isn't"} on the attendee list. Update set_attendees or their claims.`;
    case "NO_ATTENDEES":
      return "Nobody is on the attendee list. Call set_attendees first.";
    case "TOTAL_MISMATCH":
      return `The shares add up to ${formatCents(error.actualCents)} but the bill is ${formatCents(error.expectedCents)}. Nothing was sent; check the receipt.`;
    case "INVALID_INPUT":
      return error.message;
  }
}

function extrasLabel(event: DinnerEvent): string {
  const labels: string[] = [];
  const sum = (pick: (r: Receipt) => number) => event.receipts.reduce((acc, r) => acc + pick(r), 0);
  if (sum((r) => r.taxCents)) labels.push("tax");
  // A gratuity printed on the receipt reads as a service charge, so nobody thinks to tip again.
  if (event.receipts.some((r) => r.tipCents && r.tipIncluded)) labels.push("service charge");
  if (event.receipts.some((r) => r.tipCents && !r.tipIncluded)) labels.push("tip");
  if (sum((r) => r.feesCents)) labels.push("fees");
  if (sum((r) => r.discountCents) || event.booking?.depositCents) labels.push("deposit and discounts");
  return labels.length ? joinNames(labels) : "tax and tip";
}

interface ShareRow {
  share: PersonShare;
  person: Person;
  isOrganizer: boolean;
  link?: VenmoLink;
  message?: string;
}

/** Each person's share with their Venmo link and ready-to-send message (none for the organizer). */
function shareRows(e: DinnerEvent, shares: readonly PersonShare[]): ShareRow[] {
  const organizer = getOrganizer(e)!;
  const label = extrasLabel(e);
  return shares.map((share) => {
    const person = e.people.find((p) => p.id === share.personId)!;
    const isOrganizer = person.id === e.organizerId;
    const link =
      !isOrganizer && share.totalCents > 0 && e.organizerVenmo
        ? buildVenmoLink({ handle: e.organizerVenmo, amountCents: share.totalCents, note: e.title })
        : undefined;
    const message = isOrganizer
      ? undefined
      : buildShareMessage({
          eventTitle: e.title,
          organizerName: organizer.name,
          share,
          ...(link ? { link: link.webUrl } : {}),
          ...(e.organizerVenmo ? { organizerHandle: e.organizerVenmo } : {}),
          extrasLabel: label,
        });
    return { share, person, isOrganizer, ...(link ? { link } : {}), ...(message ? { message } : {}) };
  });
}

function messagesJson(friends: readonly ShareRow[]) {
  return friends.map((r) => ({
    person_id: r.person.id,
    name: r.person.name,
    ...contactJson(r.person),
    amount_cents: r.share.totalCents,
    amount: formatCents(r.share.totalCents),
    message: r.message,
    ...(r.person.optedOut ? { do_not_text: true } : {}),
  }));
}

function shareJson(event: DinnerEvent, s: PersonShare) {
  return {
    person_id: s.personId,
    name: nameOf(event, s.personId),
    items: s.items.map((i) => ({
      number: i.itemNumber,
      description: i.description,
      fraction: i.fraction,
      share_cents: i.shareCents,
      share: formatCents(i.shareCents),
    })),
    subtotal_cents: s.subtotalCents,
    subtotal: formatCents(s.subtotalCents),
    extras_cents: s.extrasCents,
    extras: formatCents(s.extrasCents),
    ...(s.treatCents ? { treat_cents: s.treatCents, treat: formatCents(s.treatCents) } : {}),
    total_cents: s.totalCents,
    total: formatCents(s.totalCents),
  };
}

// ---------- The service ----------

export interface ServiceOptions {
  /** IANA zone for placing the day-of reminder (no earlier than 9am local). */
  timeZone?: string;
}

export class FoSquadService {
  private readonly timeZone: string;

  constructor(
    private readonly store: EventStore,
    private readonly clock: () => Date = () => new Date(),
    opts: ServiceOptions = {},
  ) {
    this.timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private async load(eventId: string): Promise<DinnerEvent> {
    const event = await this.store.get(eventId);
    if (!event) throw new FoError("NOT_FOUND", `I can't find a dinner with id "${eventId}".`);
    return event;
  }

  /** Every success result carries the same envelope, with next_action from getStatus. */
  private ok(event: DinnerEvent, extra: ToolResult = {}, lead?: string): ToolResult {
    const status = getStatus(event, this.clock(), this.timeZone);
    return {
      ok: true,
      event_id: event.id,
      stage: event.stage,
      ...extra,
      next_action: lead ? `${lead} ${status.nextAction}` : status.nextAction,
    };
  }

  /**
   * Locked read-modify-write. `fn` edits a copy and returns the next event plus
   * any data for the result. updatedAt only moves when something really changed.
   */
  private async mutate<T>(
    eventId: string,
    fn: (event: DinnerEvent, nowIso: string) => { event: DinnerEvent; data: T } | Promise<{ event: DinnerEvent; data: T }>,
  ): Promise<{ event: DinnerEvent; data: T }> {
    let data!: T;
    const nowIso = this.nowIso();
    const event = await updateEvent(this.store, eventId, async (current) => {
      const r = await fn(structuredClone(current), nowIso);
      data = r.data;
      if (sameState(current, r.event)) return current;
      return { ...r.event, updatedAt: nowIso };
    });
    return { event, data };
  }

  /** Read-modify-write of the fairness memory, under its own lock key. */
  private async updateConcessions(fn: (all: Concession[]) => Concession[]): Promise<void> {
    await withEventLock("concessions", async () => {
      const before = await this.store.getConcessions();
      const after = fn(before);
      if (JSON.stringify(before) !== JSON.stringify(after)) await this.store.putConcessions(after);
    });
  }

  // ----- create_event -----

  async createEvent(args: CreateEventArgs): Promise<ToolResult> {
    const now = this.clock();
    const input = {
      title: args.title,
      organizer: args.organizer,
      friends: args.friends,
      timeSlots: (args.time_slots ?? []).map((s) => ({ label: s.label, startsAt: s.starts_at })),
      ...(args.budget_per_person !== undefined
        ? { budgetPerPersonCents: parseMoney(args.budget_per_person, "budget per person") }
        : {}),
      ...(args.cuisine_hint !== undefined ? { cuisineHint: args.cuisine_hint } : {}),
      ...(args.reply_deadline !== undefined ? { replyDeadline: args.reply_deadline } : {}),
      ...(args.organizer_pick
        ? { organizerPick: { restaurantName: args.organizer_pick.restaurant_name, firmness: args.organizer_pick.firmness } }
        : {}),
    };
    // Validate first with a throwaway id so bad input fails before any store work.
    const draft = createEvent(input, { now, id: "draft" });

    // Fo retrying the same call must not create a second dinner.
    const duplicate = (await this.store.list()).find(
      (e) =>
        e.stage === "planning" &&
        e.title === draft.title &&
        JSON.stringify(e.people.map((p) => [p.name, p.phone, p.email])) ===
          JSON.stringify(draft.people.map((p) => [p.name, p.phone, p.email])) &&
        JSON.stringify(e.timeSlots) === JSON.stringify(draft.timeSlots),
    );
    if (duplicate) return this.createdResult(duplicate, true);

    // A receipt mid-plan belongs to the dinner being planned, not a new one.
    if (draft.timeSlots.length === 0 && !args.separate_dinner) {
      const organizer = getOrganizer(draft)!;
      const open = (await this.store.list())
        .filter((e) => e.stage !== "settled" && contactsOf(organizer).some((c) => isOrganizerContact(e, c)))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
      if (open) {
        throw new FoError(
          "OPEN_DINNER",
          `${organizer.name} already has an open dinner, "${open.title}" (event_id ${open.id}, stage ${open.stage}). ` +
            `If this receipt is from that meal, call add_receipt with event_id ${open.id}. ` +
            `Only if ${organizer.name} says it's from a different meal, call create_event again with separate_dinner: true. Nothing was created.`,
        );
      }
    }

    let id = generateEventId(draft.title);
    for (let tries = 0; (await this.store.get(id)) && tries < 10; tries++) id = generateEventId(draft.title);
    if (await this.store.get(id)) throw new Error("Could not find a free event id");
    const event = { ...draft, id };
    await withEventLock(id, () => this.store.put(event));
    return this.createdResult(event, false);
  }

  private createdResult(event: DinnerEvent, alreadyExisted: boolean): ToolResult {
    const list = reachList(event.people.filter((p) => !p.isOrganizer));
    return this.ok(
      event,
      {
        ...(alreadyExisted ? { already_existed: true } : {}),
        title: event.title,
        people: peopleJson(event),
        time_slots: event.timeSlots.map(slotJson),
        reply_deadline: event.replyDeadline,
        ...(event.budgetPerPersonCents !== undefined
          ? { budget_per_person_cents: event.budgetPerPersonCents, budget_per_person: formatCents(event.budgetPerPersonCents) }
          : {}),
        ...(event.cuisineHint ? { cuisine_hint: event.cuisineHint } : {}),
        ...(event.organizerPick
          ? { organizer_pick: { restaurant_name: event.organizerPick.restaurantName, firmness: event.organizerPick.firmness } }
          : {}),
        ...(event.organizerVenmo ? { organizer_venmo: event.organizerVenmo } : {}),
        confirm_with_organizer: `I'll ${list}. Look right?`,
      },
      `Confirm the list with the organizer before messaging anyone (fix numbers or emails with update_event). Then:`,
    );
  }

  // ----- update_event -----

  async updateEvent(args: UpdateEventArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e, nowIso) => {
      assertStage(e, ["planning", "voting", "booked"], "change the plan");
      assertOrganizer(e, senderOf(args), "change the plan");
      const nowMs = Date.parse(nowIso);
      const changes: string[] = [];
      const warnings: string[] = [];

      if (args.remove_friends?.length) {
        for (const ref of args.remove_friends) {
          const person = resolvePerson(e, ref);
          if (!person) {
            warnings.push(`"${ref}" isn't on this dinner (already removed?).`);
            continue;
          }
          if (person.id === e.organizerId) throw invalid("The organizer can't be removed from their own dinner.");
          const id = person.id;
          e.people = e.people.filter((p) => p.id !== id);
          e.preferences = e.preferences.filter((p) => p.personId !== id);
          e.votes = e.votes.filter((v) => v.personId !== id);
          e.nudgedIds = e.nudgedIds.filter((n) => n !== id);
          changes.push(`Removed ${person.name}.`);
        }
      }

      if (args.fix_phone) {
        const person = requirePerson(e, args.fix_phone.person);
        const { phone } = contactFor(person.name, { phone: args.fix_phone.phone });
        if (person.phone !== phone) {
          e.people = e.people.map((p) => (p.id === person.id ? { ...p, phone } : p));
          changes.push(`${person.name}'s number is now ${phone}.`);
        }
      }

      if (args.fix_email) {
        const person = requirePerson(e, args.fix_email.person);
        const { email } = contactFor(person.name, { email: args.fix_email.email });
        if (person.email !== email) {
          e.people = e.people.map((p) => (p.id === person.id ? { ...p, email } : p));
          changes.push(`${person.name}'s email is now ${email}.`);
        }
      }

      if (args.add_friends?.length) {
        const taken = new Set(e.people.map((p) => p.id));
        for (const f of args.add_friends) {
          const name = f.name.trim().replace(/\s+/g, " ");
          if (!name) throw invalid("Each new friend needs a name.");
          const contact = contactFor(name, f);
          const existing = e.people.find((p) => contactsOf(contact).some((c) => contactsOf(p).includes(c)));
          // Same person sent twice is a retry, not a duplicate.
          if (existing && existing.name.toLowerCase() === name.toLowerCase()) continue;
          const id = slugId(name, taken);
          taken.add(id);
          e.people.push({ id, name, ...contact, isOrganizer: false });
          changes.push(`Added ${name}.`);
        }
      }
      assertUniqueContacts(e.people);

      if (args.organizer_venmo !== undefined) {
        const handle = cleanVenmo(args.organizer_venmo);
        if (handle !== e.organizerVenmo) {
          if (handle) e.organizerVenmo = handle;
          else delete e.organizerVenmo;
          changes.push(handle ? `Venmo is now @${handle}.` : "Removed the Venmo handle.");
        }
      }

      if (args.organizer_pick) {
        const restaurantName = args.organizer_pick.restaurant_name.trim();
        if (!restaurantName) throw invalid("The organizer's pick needs a restaurant name.");
        const pick = { restaurantName, firmness: args.organizer_pick.firmness };
        if (JSON.stringify(pick) !== JSON.stringify(e.organizerPick)) {
          e.organizerPick = pick;
          changes.push(`Organizer's pick: ${restaurantName} (${pick.firmness}).`);
        }
      }

      let next = e;
      if (args.time_slots) {
        if (args.time_slots.length === 0) throw invalid("Send at least one new time option.");
        const slots = buildSlots(args.time_slots);
        if (JSON.stringify(slots) !== JSON.stringify(e.timeSlots)) {
          next.timeSlots = slots;
          // Old letters mean nothing for the new options; keep food and dietary answers.
          next.preferences = next.preferences.map((p) => ({ ...p, slotIds: [], anyTime: false, slotsStale: true }));
          delete next.chosenSlotId;
          delete next.chosenCuisine;
          delete next.shiftCheck;
          next.restaurantOptions = [];
          next.votes = [];
          delete next.winningRestaurantId;
          next.nudgedIds = [];
          if (args.reply_deadline === undefined) {
            next.replyDeadline = new Date(nowMs + DEFAULT_REPLY_WINDOW_MS).toISOString();
          }
          if (next.stage !== "planning") next = transition(next, "planning", nowIso);
          changes.push(
            `New time options: ${slots.map((s) => `${s.id}) ${s.label}`).join(" ")}. Everyone needs to answer the new times.`,
          );
        }
      }

      if (args.reply_deadline !== undefined) {
        const deadline = futureDeadline(args.reply_deadline, nowMs);
        if (deadline !== next.replyDeadline) {
          next.replyDeadline = deadline;
          changes.push(`Reply deadline is now ${deadline}.`);
        }
      }

      return { event: next, data: { changes, warnings } };
    });

    return this.ok(event, {
      changes: data.changes.length ? data.changes : ["Nothing changed."],
      ...(data.warnings.length ? { warnings: data.warnings } : {}),
      people: peopleJson(event),
      time_slots: event.timeSlots.map(slotJson),
      reply_deadline: event.replyDeadline,
    });
  }

  // ----- record_preferences -----

  private planLocked(e: DinnerEvent): FoError {
    const slot = slotLabel(e, e.booking?.slotId ?? e.chosenSlotId);
    const place = e.booking?.restaurantName ?? e.organizerPick?.restaurantName;
    const details = [slot, place ? `at ${place}` : undefined].filter(Boolean).join(" ");
    return new FoError(
      "PLAN_LOCKED",
      `The plan for "${e.title}" is already set${details ? `: ${details}` : ""}. Answers can't change now; let them know kindly and share the details.`,
    );
  }

  async recordPreferences(args: RecordPreferencesArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e, nowIso) => {
      const person = requirePerson(e, args.person);
      assertCanText(person);
      // Someone pick_time asked about shifting can still answer after the reply deadline.
      const askedToShift = e.shiftCheck?.asks.some((a) => a.personId === person.id) ?? false;
      if (e.stage !== "planning" || e.chosenSlotId || (isLateReply(e.replyDeadline, nowIso) && !askedToShift)) {
        throw this.planLocked(e);
      }

      const valid = new Set(e.timeSlots.map((s) => s.id));
      const slotIds = [...new Set(args.slot_ids.map((s) => s.trim().toUpperCase()).filter(Boolean))].sort();
      const unknown = slotIds.filter((s) => !valid.has(s));
      if (unknown.length) {
        const options = e.timeSlots.map((s) => `${s.id}) ${s.label}`).join(" ");
        throw invalid(`There's no time option ${unknown.join(", ")}. The options are: ${options || "none yet"}.`);
      }

      const prev = e.preferences.find((p) => p.personId === person.id);
      // After new time options, a reply with only letters keeps their earlier food answers.
      const carry = prev?.slotsStale ? prev : undefined;
      const pref: Preferences = {
        personId: person.id,
        slotIds: args.any_time ? [] : slotIds,
        anyTime: args.any_time ?? false,
        cuisines: args.cuisines ? tags(args.cuisines) : (carry?.cuisines ?? []),
        avoidCuisines: args.avoid_cuisines ? tags(args.avoid_cuisines) : (carry?.avoidCuisines ?? []),
        dietary: args.dietary ? tags(args.dietary) : (carry?.dietary ?? []),
        plusOnes: args.plus_ones ?? carry?.plusOnes ?? 0,
        updatedAt: nowIso,
      };
      if (args.budget !== undefined) {
        const cents = parseMoney(args.budget, "budget");
        if (cents <= 0) throw invalid("A budget has to be a positive amount.");
        pref.budgetCents = cents;
      } else if (carry?.budgetCents !== undefined) {
        pref.budgetCents = carry.budgetCents;
      }

      const unchanged = prev && JSON.stringify({ ...prev, updatedAt: "" }) === JSON.stringify({ ...pref, updatedAt: "" });
      if (!unchanged) e.preferences = [...e.preferences.filter((p) => p.personId !== person.id), pref];
      // A "no" changes nothing but still answers the shift question.
      if (askedToShift && !e.shiftCheck!.answeredIds.includes(person.id)) {
        e.shiftCheck!.answeredIds = [...e.shiftCheck!.answeredIds, person.id];
      }
      return { event: e, data: { person, pref: unchanged ? prev : pref } };
    });

    const p = data.pref;
    return this.ok(event, {
      person: { id: data.person.id, name: data.person.name },
      saved: {
        slots: p.anyTime ? "any time" : p.slotIds.map((id) => `${id}) ${slotLabel(event, id)}`),
        cuisines: p.cuisines,
        avoid_cuisines: p.avoidCuisines,
        dietary: p.dietary,
        plus_ones: p.plusOnes,
        ...(p.budgetCents !== undefined ? { budget: formatCents(p.budgetCents), budget_is_private: true } : {}),
      },
      pending: getStatus(event, this.clock(), this.timeZone).pending.map((x) => x.name),
      ...(event.shiftCheck && !event.chosenSlotId
        ? { waiting_on_shift: namesOf(event, shiftWaiting(event, this.nowIso())) }
        : {}),
    });
  }

  // ----- mark_nudged -----

  async markNudged(args: PersonArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e) => {
      assertStage(e, ["planning", "voting"], "record a nudge");
      const person = requirePerson(e, args.person);
      assertCanText(person);
      const already = e.nudgedIds.includes(person.id);
      if (!already) e.nudgedIds = [...e.nudgedIds, person.id];
      return { event: e, data: { person, already } };
    });
    return this.ok(event, {
      person: { id: data.person.id, name: data.person.name },
      already_nudged: data.already,
      nudged: namesOf(event, event.nudgedIds),
    });
  }

  // ----- pick_time -----

  async pickTime(args: PickTimeArgs): Promise<ToolResult> {
    const nowIso = this.nowIso();
    const peek = await this.load(args.event_id);
    assertStage(peek, ["planning"], "pick a time");
    if (peek.timeSlots.length === 0) {
      throw invalid(
        "This dinner has no time options. Ask the organizer for some and call update_event, or if dinner already happened, go straight to add_receipt.",
      );
    }
    const friendsAnswered = timePrefs(peek).filter((p) => p.personId !== peek.organizerId);
    const pending = getStatus(peek, nowIso, this.timeZone).pending;
    if (pending.length > 0 && !args.force && !isLateReply(peek.replyDeadline, nowIso)) {
      return this.ok(peek, {
        decided: false,
        waiting_on: pending.map((p) => p.name),
        answered: namesOf(peek, friendsAnswered.map((p) => p.personId)),
      }, `Not deciding yet: still waiting on ${joinNames(pending.map((p) => p.name))} and the deadline hasn't passed. Call pick_time with force: true if the organizer wants to decide now.`);
    }
    if (friendsAnswered.length === 0) {
      return this.ok(peek, { decided: false, status: "no_responses", reason: "No friend has answered yet." });
    }

    const concessions = await this.store.getConcessions();
    interface Decision {
      time: PickTimeResult;
      prio: string[];
      /** "asked" when this call opened the shift check, "waiting" while it's still open. */
      shift?: "asked" | "waiting";
      cuisine?: PickCuisineResult;
      constraints?: HardConstraints;
      goingPrefs?: Preferences[];
    }
    const { event, data } = await this.mutate<Decision>(args.event_id, (e) => {
      assertStage(e, ["planning"], "pick a time");
      const invited = e.people.filter((p) => !p.optedOut);
      // The organizer decides anyway, so fairness priority is only ever for friends.
      const prio = priorityIds(concessions, invited, e.id).filter((id) => id !== e.organizerId);
      const names = nameMap(e);
      const prefs = withOrganizer(e, timePrefs(e), nowIso);
      const time = pickTime({
        slots: e.timeSlots,
        preferences: prefs,
        invitedIds: invited.map((p) => p.id),
        organizerId: e.organizerId,
        priorityIds: prio,
        names,
      });
      if (!time.slotId) return { event: e, data: { time, prio } };

      // Someone would miss out: ask them before locking anything, once per round.
      if (time.status === "majority" && !args.skip_shift_check) {
        if (!e.shiftCheck) {
          const asks = shiftAsks(e, time, prefs);
          if (asks.length) {
            e.shiftCheck = {
              askedAt: nowIso,
              deadline: new Date(Date.parse(nowIso) + SHIFT_WINDOW_MS).toISOString(),
              asks,
              answeredIds: [],
            };
            return { event: e, data: { time, prio, shift: "asked" } };
          }
        } else if (shiftWaiting(e, nowIso).length) {
          return { event: e, data: { time, prio, shift: "waiting" } };
        }
      }

      const slotId = time.slotId;
      const going = new Set(time.canMake);
      const goingPrefs = e.preferences.filter((p) => going.has(p.personId));
      const cuisine = pickCuisine({
        preferences: goingPrefs,
        organizerId: e.organizerId,
        ...(e.cuisineHint ? { hint: e.cuisineHint } : {}),
        priorityIds: prio,
      });
      e.chosenSlotId = slotId;
      if (cuisine.cuisine) e.chosenCuisine = cuisine.cuisine;
      else delete e.chosenCuisine;
      const constraints = constraintsFor(e);
      return { event: e, data: { time, prio, cuisine, constraints, goingPrefs } };
    });

    const { time, prio } = data;
    const invited = event.people.filter((p) => !p.optedOut);
    const note = fairnessNote({ people: invited, priorityContacts: priorityContactsOf(event, prio) });
    const ranking = time.ranking.map((r) => ({ slot_id: r.slotId, label: r.label, can_make: r.count }));

    if (data.shift && event.shiftCheck) {
      const check = event.shiftCheck;
      const waiting = new Set(shiftWaiting(event, nowIso));
      const most = time.ranking[0]?.count ?? 0;
      const top = time.ranking.filter((r) => r.count === most);
      const respondents = time.canMake.length + time.cantMake.length;
      const reason =
        top.length > 1
          ? `${joinNames(top.map((r) => r.label))} each work for ${most} of ${respondents}, a tie. Nothing is locked yet.`
          : `${top[0]!.label} works for ${most} of ${respondents}. Nothing is locked yet.`;
      const asks = check.asks
        .filter((a) => data.shift === "asked" || waiting.has(a.personId))
        .map((a) => {
          const person = event.people.find((p) => p.id === a.personId)!;
          const pref = event.preferences.find((p) => p.personId === a.personId);
          const labels = a.slotIds.map((id) => slotLabel(event, id)!);
          return {
            person_id: person.id,
            name: person.name,
            ...contactJson(person),
            ask_about: a.slotIds.map((id) => ({ id, label: slotLabel(event, id) })),
            current_answer: pref?.anyTime ? "any time" : (pref?.slotIds ?? []),
            message: `Quick one for ${event.title}: could ${joinNames(labels, "or")} work for you after all? No worries if not.`,
          };
        });
      return this.ok(event, {
        decided: false,
        status: "check_shift",
        reason,
        ask_to_shift: asks,
        shift_deadline: check.deadline,
        ranking,
        can_make: namesOf(event, time.canMake),
        cant_make: namesOf(event, time.cantMake),
        no_reply: namesOf(event, time.noReply),
        tell_organizer: `${reason} Checking privately with ${joinNames(asks.map((a) => a.name))} whether another time could work for them.`,
      }, data.shift === "asked"
        ? "Before locking a time, send each ask_to_shift message privately (one per person) and tell the organizer. Record each answer with record_preferences, sending their full list of letters (current_answer plus any new one), even when the answer is no. Schedule pick_time at shift_deadline. If the organizer says to decide now, call pick_time with skip_shift_check: true."
        : `Still waiting on ${joinNames(asks.map((a) => a.name))} about shifting. Call pick_time again when they answer or at ${check.deadline}, or with skip_shift_check: true if the organizer says to decide now.`);
    }

    if (!time.slotId || !data.cuisine || !data.constraints) {
      const best = time.bestSlotId ? event.timeSlots.find((s) => s.id === time.bestSlotId) : undefined;
      return this.ok(event, {
        decided: false,
        status: time.status,
        ...(time.status === "no_overlap" ? { code: "NO_OVERLAP" } : {}),
        reason: time.reason,
        ...(best ? { best_slot: slotJson(best), best_slot_id: best.id } : {}),
        can_make: namesOf(event, time.canMake),
        cant_make: namesOf(event, time.cantMake),
        no_reply: namesOf(event, time.noReply),
        ranking,
      }, time.status === "no_overlap"
        ? "No time works for enough people. Ask the organizer for new time options, then call update_event with time_slots and re-ask everyone."
        : undefined);
    }

    const cuisine = data.cuisine;
    // Fairness memory: giving something up tonight earns priority next time,
    // and anyone who just won a tie because of an old concession has used it.
    const beneficiaries = new Set<string>();
    if (time.tieBrokenBy === "fairness") prio.filter((id) => time.canMake.includes(id)).forEach((id) => beneficiaries.add(id));
    if (cuisine.tieBrokenBy === "fairness" && cuisine.cuisine) {
      for (const p of data.goingPrefs ?? []) {
        if (prio.includes(p.personId) && p.cuisines.map((c) => c.toLowerCase()).includes(cuisine.cuisine)) beneficiaries.add(p.personId);
      }
    }
    await this.recordConcessions(event, [
      { gaveUpIds: time.cantMake, what: "time slot" },
      { gaveUpIds: cuisine.gaveUp, what: "cuisine" },
    ], [...beneficiaries], nowIso);

    const slot = event.timeSlots.find((s) => s.id === time.slotId) as TimeSlot;
    return this.ok(event, {
      decided: true,
      status: time.status,
      slot: slotJson(slot),
      reason: time.reason,
      ...(time.tieBrokenBy ? { tie_broken_by: time.tieBrokenBy } : {}),
      can_make: namesOf(event, time.canMake),
      cant_make: namesOf(event, time.cantMake),
      no_reply: namesOf(event, time.noReply),
      ...(event.shiftCheck ? { asked_to_shift: namesOf(event, event.shiftCheck.asks.map((a) => a.personId)) } : {}),
      party_size: time.partySize,
      cuisine: {
        winner: cuisine.cuisine ?? null,
        reason: cuisine.reason,
        counts: cuisine.counts,
        ...(cuisine.tieBrokenBy ? { tie_broken_by: cuisine.tieBrokenBy } : {}),
      },
      hard_constraints: constraintsJson(data.constraints),
      ...(note ? { fairness_note: note } : {}),
      ranking,
      ...(time.cantMake.length
        ? { tell_privately: `Let ${joinNames(namesOf(event, time.cantMake))} know kindly that dinner landed on ${slot.label}.` }
        : {}),
    });
  }

  private async recordConcessions(
    event: DinnerEvent,
    groups: { gaveUpIds: string[]; what: string }[],
    redeemIds: string[],
    nowIso: string,
  ): Promise<void> {
    await this.updateConcessions((all) => {
      let next = [...all];
      for (const g of groups) {
        next = [
          ...next,
          ...newConcessions({ eventId: event.id, people: event.people, gaveUpIds: g.gaveUpIds, what: g.what, now: nowIso, existing: next }),
        ];
      }
      // Every contact, so a concession recorded under either one is honored.
      const contacts = redeemIds.flatMap((id) => {
        const p = event.people.find((x) => x.id === id);
        return p ? contactsOf(p) : [];
      });
      return contacts.length ? redeem(next, contacts, event.id) : next;
    });
  }

  // ----- set_restaurant_options -----

  async setRestaurantOptions(args: SetRestaurantOptionsArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e, nowIso) => {
      assertStage(e, ["planning", "voting"], "set restaurant options");
      if (!e.chosenSlotId) throw new FoError("WRONG_STAGE", "Pick the time first with pick_time, then set restaurant options.");
      if (args.options.length === 0) throw invalid("Send at least one restaurant option.");

      const seen = new Set<string>();
      const candidates: RestaurantOption[] = args.options.map((o, i) => {
        const name = o.name.trim();
        if (!name) throw invalid(`Option ${i + 1} needs a name.`);
        if (seen.has(name.toLowerCase())) throw invalid(`${name} is listed twice.`);
        seen.add(name.toLowerCase());
        const option: RestaurantOption = { id: String(i + 1), name };
        if (o.cuisine?.trim()) option.cuisine = o.cuisine.trim();
        if (o.price_per_person !== undefined) option.pricePerPersonCents = parseNonNegative(o.price_per_person, `price per person for ${name}`);
        if (o.notes?.trim()) option.notes = o.notes.trim();
        return option;
      });

      const filtered = filterRestaurantOptions(candidates, constraintsFor(e));
      if (filtered.allowed.length === 0) {
        throw invalid(
          `None of these fit the group: ${filtered.rejected.map((r) => `${r.option.name} (${r.reason})`).join(", ")}. Find options that do.`,
        );
      }
      // Hard constraints beat votes, so rejected places never reach the ballot. Number what's left 1, 2, 3.
      const options = filtered.allowed.map((o, i) => ({ ...o, id: String(i + 1) }));

      let next = e;
      if (JSON.stringify(options) !== JSON.stringify(e.restaurantOptions)) {
        next.restaurantOptions = options;
        next.votes = [];
        delete next.winningRestaurantId;
        next.nudgedIds = [];
      }
      if (next.stage === "planning") {
        next.nudgedIds = [];
        next = transition(next, "voting", nowIso);
      }
      return { event: next, data: { rejected: filtered.rejected } };
    });

    const slot = slotLabel(event, event.chosenSlotId);
    const ballot = event.restaurantOptions.map((o) => `${o.id}) ${o.name}${ballotTag(o, event.organizerCovered === true)}`).join(" ");
    return this.ok(event, {
      options: event.restaurantOptions.map((o) => ({
        id: o.id,
        name: o.name,
        ...(o.cuisine ? { cuisine: o.cuisine } : {}),
        ...(o.pricePerPersonCents !== undefined ? { price_per_person: formatCents(o.pricePerPersonCents) } : {}),
        ...(o.notes ? { notes: o.notes } : {}),
      })),
      ...(data.rejected.length
        ? { rejected: data.rejected.map((r) => ({ name: r.option.name, reason: r.reason })) }
        : {}),
      voters: voters(event).map((p) => p.name),
      ballot: `${slot} it is! Vote for a spot: ${ballot}. Reply with a number.`,
    });
  }

  // ----- record_vote -----

  async recordVote(args: RecordVoteArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e, nowIso) => {
      const person = requirePerson(e, args.person);
      assertCanText(person);
      if (["booked", "claiming", "paying", "settled"].includes(e.stage) || e.winningRestaurantId) {
        const winner = e.restaurantOptions.find((o) => o.id === e.winningRestaurantId)?.name ?? e.booking?.restaurantName;
        throw new FoError("PLAN_LOCKED", `Voting for "${e.title}" is closed${winner ? `: ${winner} won` : ""}. Let them know kindly.`);
      }
      assertStage(e, ["voting"], "record a vote");
      if (!canMakeChosenSlot(e, person)) {
        throw invalid(`${person.name} can't make ${slotLabel(e, e.chosenSlotId)}, so they don't vote.`);
      }
      const ref = args.option.trim().replace(/^#/, "").replace(/[).]$/, "").trim();
      const option =
        e.restaurantOptions.find((o) => o.id === ref) ??
        e.restaurantOptions.find((o) => o.name.toLowerCase() === ref.toLowerCase());
      if (!option) {
        throw invalid(
          `"${args.option}" isn't one of the options: ${e.restaurantOptions.map((o) => `${o.id}) ${o.name}`).join(" ")}.`,
        );
      }
      const prev = e.votes.find((v) => v.personId === person.id);
      if (prev?.restaurantId !== option.id) {
        e.votes = [...e.votes.filter((v) => v.personId !== person.id), { personId: person.id, restaurantId: option.id, updatedAt: nowIso }];
      }
      return { event: e, data: { person, option } };
    });
    const voted = new Set(event.votes.map((v) => v.personId));
    return this.ok(event, {
      person: { id: data.person.id, name: data.person.name },
      vote: { id: data.option.id, name: data.option.name },
      votes_in: voted.size,
      waiting_on: voters(event).filter((p) => !voted.has(p.id)).map((p) => p.name),
    });
  }

  // ----- tally_votes -----

  async tallyVotes(args: ForceArgs): Promise<ToolResult> {
    const nowIso = this.nowIso();
    const peek = await this.load(args.event_id);
    assertStage(peek, ["voting"], "tally votes");
    const voted = new Set(peek.votes.map((v) => v.personId));
    const pending = voters(peek).filter((p) => !voted.has(p.id));
    if (pending.length > 0 && !args.force) {
      return this.ok(peek, {
        decided: false,
        waiting_on: pending.map((p) => p.name),
        votes_in: voted.size,
      }, `Not tallying yet: still waiting on ${joinNames(pending.map((p) => p.name))}. Call tally_votes with force: true to decide with the votes in.`);
    }

    const concessions = await this.store.getConcessions();
    const { event, data } = await this.mutate(args.event_id, (e) => {
      assertStage(e, ["voting"], "tally votes");
      const voterPeople = voters(e);
      const prio = priorityIds(concessions, voterPeople, e.id).filter((id) => id !== e.organizerId);
      const tally = tallyVotes({
        options: e.restaurantOptions,
        votes: e.votes,
        voterIds: voterPeople.map((p) => p.id),
        organizerId: e.organizerId,
        priorityIds: prio,
        names: nameMap(e),
      });
      if (tally.winnerId) e.winningRestaurantId = tally.winnerId;
      return { event: e, data: { tally, prio } };
    });

    const { tally, prio } = data;
    const ranking = tally.ranking.map((r) => ({ option_id: r.optionId, name: r.name, votes: r.votes }));
    if (!tally.winnerId) {
      return this.ok(event, { decided: false, reason: tally.reason, ranking });
    }

    const best = tally.ranking[0]!;
    const beneficiaries =
      tally.tieBrokenBy === "fairness" ? prio.filter((id) => id !== event.organizerId && best.voterIds.includes(id)) : [];
    await this.recordConcessions(event, [{ gaveUpIds: tally.gaveUp, what: "restaurant" }], beneficiaries, nowIso);

    const note = fairnessNote({ people: event.people, priorityContacts: priorityContactsOf(event, prio) });
    const slotId = event.chosenSlotId;
    const partySize = slotId ? partySizeFor(event, slotId, nowIso) : undefined;
    const slot = slotLabel(event, slotId);
    return this.ok(event, {
      decided: true,
      winner: { id: best.optionId, name: best.name, votes: best.votes },
      reason: tally.reason,
      ...(tally.tieBrokenBy ? { tie_broken_by: tally.tieBrokenBy } : {}),
      ranking,
      runner_ups: ranking.slice(1),
      no_vote: namesOf(event, tally.noVote),
      ...(note ? { fairness_note: note } : {}),
      ...(partySize !== undefined ? { party_size: partySize } : {}),
      ask_organizer: `${tally.reason}. Book ${slot ?? "it"}${partySize ? ` for ${partySize}` : ""}?`,
    });
  }

  // ----- confirm_booking -----

  async confirmBooking(args: ConfirmBookingArgs): Promise<ToolResult> {
    const { event } = await this.mutate(args.event_id, (e, nowIso) => {
      assertStage(e, ["planning", "voting", "booked"], "confirm a booking");
      assertOrganizer(e, senderOf(args), "approve a booking");
      const restaurantName = args.restaurant_name.trim();
      if (!restaurantName) throw invalid("Which restaurant? restaurant_name is empty.");

      const slotId = (args.slot_id ?? e.chosenSlotId)?.trim().toUpperCase();
      if (!slotId) throw invalid("Which time is the booking for? Pass slot_id.");
      const slot = e.timeSlots.find((s) => s.id === slotId);
      if (!slot) {
        throw invalid(`There's no time option ${slotId}. The options are: ${e.timeSlots.map((s) => `${s.id}) ${s.label}`).join(" ") || "none"}.`);
      }
      const partySize = args.party_size ?? partySizeFor(e, slotId, nowIso);
      if (!Number.isSafeInteger(partySize) || partySize < 1) throw invalid("The party size must be at least 1.");
      const deposit = parseNonNegative(args.deposit, "deposit");

      e.chosenSlotId = slotId;
      e.booking = {
        restaurantName,
        slotId,
        startsAt: slot.startsAt,
        partySize,
        ...(args.confirmation?.trim() ? { confirmation: args.confirmation.trim() } : {}),
        ...(deposit > 0 ? { depositCents: deposit } : {}),
        ...(args.auto_gratuity ? { autoGratuity: true } : {}),
        ...(args.notes?.trim() ? { notes: args.notes.trim() } : {}),
      };
      return { event: transition(e, "booked", nowIso), data: null };
    });

    const b = event.booking!;
    const label = slotLabel(event, b.slotId);
    return this.ok(event, {
      booking: {
        restaurant_name: b.restaurantName,
        slot_id: b.slotId,
        label,
        starts_at: b.startsAt,
        party_size: b.partySize,
        ...(b.confirmation ? { confirmation: b.confirmation } : {}),
        ...(b.depositCents ? { deposit_cents: b.depositCents, deposit: formatCents(b.depositCents) } : {}),
        ...(b.autoGratuity ? { auto_gratuity: true } : {}),
        ...(b.notes ? { notes: b.notes } : {}),
      },
      announcement: `Booked! ${b.restaurantName}, ${label}. See you there.`,
      timers: {
        day_of_reminder_at: dayOfReminderAt(new Date(b.startsAt), this.timeZone).toISOString(),
        bill_question_at: billQuestionAt(new Date(b.startsAt)).toISOString(),
      },
    });
  }

  // ----- add_receipt -----

  async addReceipt(args: AddReceiptArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e, nowIso) => {
      // Only this dinner's organizer can add its receipt, so a photo can't land on someone else's dinner.
      assertOrganizer(e, senderOf(args), "add a receipt");
      assertStage(e, ["planning", "voting", "booked", "claiming"], "add a receipt");
      // A receipt before the table time is for some other meal (or the wrong dinner).
      if (e.stage === "booked") assertMealHappened(e, nowIso, "add a receipt");
      const fromStage = e.stage;
      const first = nextItemNumber(e.receipts);
      const items: LineItem[] = args.items.map((item, i) => ({
        number: first + i,
        description: item.description.trim(),
        amountCents: parseMoney(item.amount, `amount for "${item.description}"`),
      }));
      const subtotal = parseMoney(args.subtotal, "subtotal");
      const tax = parseNonNegative(args.tax, "tax");
      const tip = parseNonNegative(args.tip, "tip");
      const fees = parseNonNegative(args.fees, "fees");
      const discount = parseNonNegative(args.discount, "discount");
      const total = parseMoney(args.total, "total");
      const credit = parseNonNegative(args.deposit_credit, "deposit credit");
      const tipIncluded = args.tip_included ?? false;

      // The printed total is after the deposit credit, so it validates like a discount.
      const check = validateReceipt({
        items,
        subtotalCents: subtotal,
        taxCents: tax,
        tipCents: tip,
        feesCents: fees,
        discountCents: discount + credit,
        totalCents: total,
        tipIncluded,
      });
      if (!check.ok) {
        const note = credit && check.code === "TOTAL_MISMATCH" ? ` (The discount there includes the ${formatCents(credit)} deposit credit.)` : "";
        throw invalid(`${check.message}${note} Nothing was saved.`);
      }

      // Fo retrying the same receipt must not add it twice.
      const sig = (r: Pick<Receipt, "items" | "subtotalCents" | "taxCents" | "tipCents">) =>
        JSON.stringify([r.items.map((i) => [i.description, i.amountCents]), r.subtotalCents, r.taxCents, r.tipCents]);
      const existing = e.receipts.find((r) => sig(r) === sig({ items, subtotalCents: subtotal, taxCents: tax, tipCents: tip }));
      if (existing) return { event: e, data: { receipt: existing, duplicate: true, printedTotal: total, warnings: [] as string[], fromStage } };

      // buildSplitInput adds booking.depositCents back and expects receipt totals
      // net of it. So the deposit lives in exactly one place:
      //  - booking has it: fold the credit into discountCents (receipt stays as printed)
      //  - booking doesn't: store the gross total (printed + credit), no discount
      // Either way the shares sum to what dinner really cost, deposit counted once.
      const bookingDeposit = e.booking?.depositCents ?? 0;
      const creditedSoFar = e.receipts.reduce((acc, r) => acc + (r.depositCreditCents ?? 0), 0);
      let discountCents = discount;
      let totalCents = total;
      if (credit > 0) {
        if (bookingDeposit > 0) {
          const remaining = bookingDeposit - creditedSoFar;
          if (credit !== remaining) {
            throw invalid(
              `The receipt shows a ${formatCents(credit)} deposit credit but the booking recorded a ${formatCents(bookingDeposit)} deposit${creditedSoFar ? ` (${formatCents(creditedSoFar)} already credited on another receipt)` : ""}. Ask the organizer which is right. Nothing was saved.`,
            );
          }
          discountCents = discount + credit;
        } else {
          totalCents = total + credit;
        }
      }

      const receipt: Receipt = {
        id: `r${e.receipts.length + 1}`,
        items,
        subtotalCents: subtotal,
        taxCents: tax,
        tipCents: tip,
        feesCents: fees,
        discountCents,
        totalCents,
        tipIncluded,
        ...(credit ? { depositCreditCents: credit } : {}),
      };
      const warnings: string[] = [];
      if (e.booking?.autoGratuity && tip > 0 && !tipIncluded) {
        warnings.push(
          `The booking has auto gratuity, but this receipt also has a ${formatCents(tip)} tip that isn't marked as included. Check with the organizer that the group isn't tipping twice before anyone is asked to pay.`,
        );
      }
      e.receipts = [...e.receipts, receipt];
      return { event: transition(e, "claiming", nowIso), data: { receipt, duplicate: false, printedTotal: total, warnings, fromStage } };
    });

    const allItems = event.receipts.flatMap((r) => r.items);
    const toSplit = buildSplitInput(event).expectedTotalCents;
    const deposit = event.booking?.depositCents ?? 0;
    const r = data.receipt;
    return this.ok(event, {
      ...(data.duplicate ? { already_added: true } : {}),
      receipt_id: r.id,
      items: r.items.map(itemJson),
      item_count: allItems.length,
      receipt_total_cents: data.printedTotal,
      receipt_total: formatCents(data.printedTotal),
      ...(r.depositCreditCents ? { deposit_credit_cents: r.depositCreditCents, deposit_credit: formatCents(r.depositCreditCents) } : {}),
      ...(deposit ? { booking_deposit_cents: deposit, booking_deposit: formatCents(deposit) } : {}),
      total_to_split_cents: toSplit,
      total_to_split: formatCents(toSplit),
      item_list: itemList(allItems),
      ...(data.warnings.length ? { warnings: data.warnings } : {}),
    }, data.fromStage === "planning" || data.fromStage === "voting"
      ? `The ${data.fromStage === "planning" ? "time question" : "restaurant vote"} for this dinner is over: cancel any nudge or deadline actions you scheduled for it, and don't tally or announce anything from it.`
      : undefined);
  }

  // ----- set_attendees -----

  async setAttendees(args: SetAttendeesArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e) => {
      assertStage(e, ["claiming"], "set who came");
      if (args.people.length === 0) throw invalid("List at least one person who came.");
      const ids = new Set(args.people.map((ref) => requirePerson(e, ref).id));
      // Event order, so penny tie breaks never depend on how the list was typed.
      const attendeeIds = e.people.filter((p) => ids.has(p.id)).map((p) => p.id);
      const dropped = [...new Set(e.claims.map((c) => c.personId))].filter((id) => !ids.has(id));
      e.attendeeIds = attendeeIds;
      e.claims = e.claims.filter((c) => ids.has(c.personId));
      e.claimAnsweredIds = e.claimAnsweredIds.filter((id) => ids.has(id));
      e.treatedIds = e.treatedIds.filter((id) => ids.has(id));
      return { event: e, data: { dropped } };
    });
    const attendees = new Set(event.attendeeIds);
    const allItems = event.receipts.flatMap((r) => r.items);
    return this.ok(event, {
      attendees: namesOf(event, event.attendeeIds ?? []),
      not_attending: event.people.filter((p) => !attendees.has(p.id)).map((p) => p.name),
      ...(data.dropped.length ? { warnings: [`Removed claims from ${joinNames(namesOf(event, data.dropped))}, who isn't on the attendee list.`] } : {}),
      item_list: itemList(allItems),
    });
  }

  // ----- record_claims -----

  async recordClaims(args: RecordClaimsArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e, nowIso) => {
      assertStage(e, ["claiming", "paying"], "record claims");
      let ref: string;
      let items: { number: number; weight: number }[];
      if (args.claim !== undefined) {
        const parsed = parseClaimReply(args.claim);
        if (!parsed.ok) throw invalid(parsed.message);
        ref = parsed.name;
        items = parsed.items;
      } else if (args.person !== undefined && args.items !== undefined) {
        // An empty list would silently wipe what they claimed (seen in the sandbox after a retry).
        if (args.items.length === 0) throw invalid(`If ${args.person} had nothing, send claim "${args.person}: none". Otherwise list their items.`);
        ref = args.person;
        items = args.items.map((i) => ({ number: i.number, weight: i.weight ?? 1 }));
      } else {
        // Seen live: Fo sent person plus a plural "claims" string, which the schema drops.
        throw invalid(
          args.person !== undefined
            ? `Got person "${args.person}" but no items. Add items ([{ "number": 3 }]), or send only claim (singular): "Name: 3".`
            : 'Send either claim ("Maya: 1, 4") or person plus items.',
        );
      }
      const person = requirePerson(e, ref);
      if (!e.attendeeIds) throw invalid("Confirm who came with set_attendees before recording claims.");
      if (!e.attendeeIds.includes(person.id)) {
        throw invalid(`${person.name} isn't on the attendee list, so they can't claim items. If they came, update set_attendees first.`);
      }

      const known = new Set(e.receipts.flatMap((r) => r.items.map((i) => i.number)));
      const seen = new Set<number>();
      for (const item of items) {
        if (!Number.isSafeInteger(item.weight) || item.weight < 1) throw invalid(`Item ${item.number} needs a portion of 1 or more.`);
        if (seen.has(item.number)) throw invalid(`Item ${item.number} is listed twice. For a bigger portion use "${item.number}x2".`);
        seen.add(item.number);
      }
      const unknown = items.filter((i) => !known.has(i.number)).map((i) => i.number);
      if (unknown.length) {
        throw invalid(`There's no item ${unknown.join(", ")} on the receipt. Items are numbered 1 to ${Math.max(0, ...known)}.`);
      }

      const mine: Claim[] = items
        .map((i) => ({ personId: person.id, itemNumber: i.number, weight: i.weight }))
        .sort((a, b) => a.itemNumber - b.itemNumber);
      const before = e.claims.filter((c) => c.personId === person.id).sort((a, b) => a.itemNumber - b.itemNumber);
      const claimsChanged = JSON.stringify(before) !== JSON.stringify(mine);
      if (claimsChanged) e.claims = [...e.claims.filter((c) => c.personId !== person.id), ...mine];
      if (!e.claimAnsweredIds.includes(person.id)) e.claimAnsweredIds = [...e.claimAnsweredIds, person.id];

      let next = e;
      // A changed claim after totals went out is a dispute: back to claiming to recalculate.
      if (claimsChanged && next.stage === "paying") next = transition(next, "claiming", nowIso);
      // Items this save took away from them: record_claims replaces a person's whole list.
      const dropped = before.filter((b) => !mine.some((m) => m.itemNumber === b.itemNumber));
      return { event: next, data: { person, mine, dropped } };
    });

    const allItems = event.receipts.flatMap((r) => r.items);
    const attendeeIds = event.attendeeIds ?? [];
    const analysis = analyzeClaims(allItems, event.claims, attendeeIds, event.claimAnsweredIds);
    const byNumber = new Map(allItems.map((i) => [i.number, i]));
    const warnings: string[] = [];
    // "1, 2, ..., 10" from one person usually means "I shared everything", not "it was all mine".
    const others = attendeeIds.filter((id) => id !== data.person.id);
    if (allItems.length > 1 && others.length > 0 && data.mine.length === allItems.length) {
      const name = data.person.name;
      warnings.push(
        `${name} claimed all ${allItems.length} items. Before calculating, check with ${name}: did they share everything, or have it all to themselves? ` +
          `Any item someone else also claims is split with ${name}.` +
          (analysis.pendingAttendeeIds.length ? ` ${joinNames(namesOf(event, analysis.pendingAttendeeIds))} still need to claim their own items.` : ""),
      );
    }
    if (data.dropped.length) {
      const list = data.dropped.map((c) => `${c.itemNumber}) ${byNumber.get(c.itemNumber)?.description ?? "item"}`).join(", ");
      const merged = [...data.mine, ...data.dropped]
        .sort((a, b) => a.itemNumber - b.itemNumber)
        .map((c) => `${c.itemNumber}${c.weight > 1 ? `x${c.weight}` : ""}`)
        .join(", ");
      warnings.push(
        `This replaced ${data.person.name}'s earlier claims and removed ${list}. If this was an addition (they still had ${data.dropped.length > 1 ? "those" : "it"}), save their full list: claim "${data.person.name}: ${merged}".`,
      );
    }
    return this.ok(event, {
      person: { id: data.person.id, name: data.person.name },
      ...(warnings.length ? { warnings } : {}),
      claimed: data.mine.map((c) => ({
        number: c.itemNumber,
        description: byNumber.get(c.itemNumber)?.description,
        ...(c.weight !== 1 ? { weight: c.weight } : {}),
      })),
      answered: `${attendeeIds.length - analysis.pendingAttendeeIds.length} of ${attendeeIds.length}`,
      waiting_on: namesOf(event, analysis.pendingAttendeeIds),
      unclaimed_items: analysis.unclaimedItemNumbers.map((n) => itemJson(byNumber.get(n)!)),
      shared_items: analysis.sharedItems.map((s) => ({
        number: s.itemNumber,
        description: byNumber.get(s.itemNumber)?.description,
        claimed_by: namesOf(event, s.claimantIds),
      })),
    });
  }

  // ----- calculate_shares -----

  async calculateShares(args: CalculateSharesArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e, nowIso) => {
      assertStage(e, ["claiming", "paying"], "calculate shares");
      const overrides = args.unclaimed_policy === "split_evenly" || args.treated !== undefined;
      if (overrides) assertOrganizer(e, senderOf(args), "split unclaimed items evenly or set who's being treated");
      if (!e.attendeeIds) throw invalid("Confirm who came with set_attendees first.");

      // Running the split early gives anyone who hasn't claimed a $0 share.
      const allItems = e.receipts.flatMap((r) => r.items);
      const pendingIds = analyzeClaims(allItems, e.claims, e.attendeeIds, e.claimAnsweredIds).pendingAttendeeIds;
      if (pendingIds.length) {
        const who = joinNames(namesOf(e, pendingIds));
        throw new FoError(
          "CLAIMS_PENDING",
          `${e.attendeeIds.length - pendingIds.length} of ${e.attendeeIds.length} have claimed their items; still waiting on ${who}. ` +
            `Check their replies and record_claims for each one. If they really haven't answered, wait, or ask the organizer what ${who} had and record_claims for them ("${namesOf(e, pendingIds)[0]}: none" if nothing). Nothing was calculated.`,
        );
      }

      if (args.unclaimed_policy) e.unclaimedPolicy = args.unclaimed_policy;
      if (args.fees_split_evenly !== undefined) e.feesSplitEvenly = args.fees_split_evenly;
      if (args.treated !== undefined) {
        const ids = args.treated.map((ref) => requirePerson(e, ref));
        for (const p of ids) {
          if (!e.attendeeIds.includes(p.id)) throw invalid(`${p.name} isn't on the attendee list, so they can't be treated.`);
        }
        e.treatedIds = [...new Set(ids.map((p) => p.id))];
      }

      const split = computeSplit(buildSplitInput(e));
      if (!split.ok) throw invalid(splitErrorMessage(e, split.error));

      const rows = shareRows(e, split.shares);
      e.shares = split.shares;
      return { event: transition(e, "paying", nowIso), data: { rows, totalCents: split.totalCents } };
    });

    const { rows, totalCents } = data;
    const friends = rows.filter((r) => !r.isOrganizer);
    const own = rows.find((r) => r.isOrganizer);
    const summary =
      `Totals: ${friends.map((r) => `${r.person.name} ${formatCents(r.share.totalCents)}`).join(", ")}.` +
      (own ? ` Your own share: ${formatCents(own.share.totalCents)}.` : "") +
      ` Total ${formatCents(totalCents)}.`;
    return this.ok(event, {
      total_cents: totalCents,
      total: formatCents(totalCents),
      summary,
      ask_organizer: `${rows.length} of ${rows.length} claimed. ${summary} Send?`,
      shares: rows.map((r) => ({
        ...shareJson(event, r.share),
        ...(r.isOrganizer ? { is_organizer: true } : {}),
        ...(r.link ? { venmo_url: r.link.webUrl, venmo_app_url: r.link.appUrl } : {}),
      })),
      messages: messagesJson(friends),
    }, "Show the organizer the summary and send nothing until they say yes. On their yes, call send_totals (by_phone or by_email = the organizer's), then send each person their own message.");
  }

  // ----- send_totals -----

  async sendTotals(args: SendTotalsArgs): Promise<ToolResult> {
    const { event } = await this.mutate(args.event_id, (e, nowIso) => {
      if (e.stage === "settled" && e.totalsSentAt) return { event: e, data: undefined };
      assertOrganizer(e, senderOf(args), "send the totals");
      assertStage(e, ["paying"], "send the totals");
      return { event: { ...transition(e, "settled", nowIso), totalsSentAt: nowIso }, data: undefined };
    });
    const friends = shareRows(event, event.shares ?? []).filter((r) => !r.isOrganizer);
    return this.ok(
      event,
      {
        // Fo Squad never sends anything itself. Saying "sent" here once led Fo to report
        // totals as delivered when no email had gone out.
        delivered: false,
        messages: messagesJson(friends),
        tell_organizer_after_sending: `Sent: everyone has their total and your Venmo link. ${event.title} is all wrapped up.`,
      },
      "Nothing has been sent yet: Fo Squad doesn't send messages. Send each person their own message now, word for word, skipping anyone marked do_not_text. Only after they've actually gone out, tell the organizer tell_organizer_after_sending.",
    );
  }

  // ----- cover_bill -----

  async coverBill(args: CoverBillArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e, nowIso) => {
      if (e.organizerCovered && (e.stage === "settled" || !mealHappened(e, nowIso))) return { event: e, data: { early: e.stage !== "settled" } };
      assertOrganizer(e, senderOf(args), "cover the bill");
      if (e.stage === "settled") {
        throw new FoError(
          "WRONG_STAGE",
          `Totals for "${e.title}" already went out with Venmo links. Tell each friend it's covered; there's nothing to undo here.`,
        );
      }
      // Said up front (a birthday treat): note it and keep going, so the day-of reminder still goes out.
      if (!mealHappened(e, nowIso) && ["planning", "voting", "booked"].includes(e.stage)) {
        return { event: { ...e, organizerCovered: true, updatedAt: nowIso }, data: { early: true } };
      }
      assertStage(e, ["booked", "claiming", "paying"], "cover the bill");
      return { event: { ...transition(e, "settled", nowIso), organizerCovered: true }, data: { early: false } };
    });
    return this.ok(
      event,
      {
        covered: true,
        settled: event.stage === "settled",
        tell_organizer: data.early
          ? `Got it: ${event.title} is your treat. Nobody will be asked for money, and I'll close it out after.`
          : `Done: ${event.title} is on you, so nobody gets a payment request. Thanks for treating everyone!`,
      },
      "Don't message friends about money.",
    );
  }

  // ----- record_opt_out -----

  async recordOptOut(args: PersonArgs): Promise<ToolResult> {
    const { event, data } = await this.mutate(args.event_id, (e) => {
      const person = requirePerson(e, args.person);
      if (!person.optedOut) e.people = e.people.map((p) => (p.id === person.id ? { ...p, optedOut: true } : p));
      return { event: e, data: { person } };
    });
    return this.ok(event, {
      person: { id: data.person.id, name: data.person.name },
      opted_out: true,
      tell_organizer:
        channelOf(data.person) === "email"
          ? `${data.person.name} unsubscribed, so I won't email them again about "${event.title}".`
          : `${data.person.name} replied STOP, so I won't text them again about "${event.title}".`,
    });
  }

  // ----- get_status -----

  async getStatus(args: GetStatusArgs): Promise<ToolResult> {
    let event: DinnerEvent | undefined;
    const contact = args.phone?.trim() || args.email?.trim();
    if (args.event_id) event = await this.load(args.event_id);
    else if (contact) event = await this.store.findActiveByContact(contact);
    if (!event) {
      return {
        ok: true,
        found: false,
        next_action:
          "No active dinner for this number or email. If the organizer wants to plan one, call create_event; if they sent a receipt, ask who was there and create_event (no time slots) before add_receipt.",
      };
    }
    const status = getStatus(event, this.clock(), this.timeZone);
    const caller = contact ? resolvePerson(event, contact) : undefined;
    // Same person in several open dinners: say so, so a reply or receipt isn't pinned on the wrong one.
    const others = contact && !args.event_id ? await this.otherOpenDinners(contact, event.id) : [];
    return {
      ok: true,
      found: true,
      event_id: event.id,
      title: event.title,
      stage: event.stage,
      stage_number: status.stageNumber,
      ...(caller ? { caller: { id: caller.id, name: caller.name, is_organizer: caller.id === event.organizerId } } : {}),
      // A scheduled action or a friend's turn may be the first time Fo sees this
      // dinner, and most next steps involve texting the organizer.
      organizer: organizerJson(event),
      // Everyone, so a day-of reminder or "Booked!" text can reach attendees too.
      people: peopleJson(event),
      // Contacts included because a nudge or reminder may run in a fresh turn
      // (scheduled action) with no memory of the thread that had the numbers.
      pending: status.pending.map((p) => {
        const person = event.people.find((x) => x.id === p.id);
        return { ...p, ...(person ? contactJson(person) : {}) };
      }),
      details: status.details,
      ...(others.length ? { other_open_dinners: others } : {}),
      next_action: others.length
        ? `${status.nextAction} This contact is also in ${others.length} other open dinner${others.length > 1 ? "s" : ""} (other_open_dinners): make sure this message is about "${event.title}", and pass event_id from now on.`
        : status.nextAction,
    };
  }

  private async otherOpenDinners(contact: string, exceptId: string) {
    const normalized = tryNormalizeContact(contact);
    if (!normalized) return [];
    return (await this.store.list())
      .filter((e) => e.id !== exceptId && e.stage !== "settled" && e.people.some((p) => contactsOf(p).includes(normalized)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((e) => ({ event_id: e.id, title: e.title, stage: e.stage, updated_at: e.updatedAt }));
  }
}
