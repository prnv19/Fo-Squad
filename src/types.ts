// Shared domain types for Fo Squad. Every module builds against these.
// All money is integer cents. Never use floating point dollars.

export type Cents = number;

export type Stage =
  | "planning" // collecting availability and preferences
  | "voting" // friends picking the restaurant
  | "booked" // reservation confirmed, reminder scheduled
  | "claiming" // receipt uploaded, collecting who had what
  | "paying" // totals and Venmo links sent
  | "settled"; // everyone has paid

export const STAGES: readonly Stage[] = [
  "planning",
  "voting",
  "booked",
  "claiming",
  "paying",
  "settled",
] as const;

// ---------- People ----------

export interface Person {
  /** Stable id, lowercase slug of the name (e.g. "maya"). Unique per event. */
  id: string;
  name: string;
  /** E.164 phone number, e.g. "+15551234567". Every person has a phone, an email or both. */
  phone?: string;
  /** Lowercase email address, for people Fo reaches by email (e.g. a work lunch). */
  email?: string;
  isOrganizer: boolean;
  /** Friend replied STOP (or unsubscribe). Fo must not message them again. */
  optedOut?: boolean;
}

// ---------- Planning ----------

export interface TimeSlot {
  /** Short letter shown to friends: "A", "B", "C", "D". */
  id: string;
  /** Human label, e.g. "Sat 7:30pm". */
  label: string;
  /** ISO 8601 start time. Used for "earliest slot" tie breaks. */
  startsAt: string;
}

export interface Preferences {
  personId: string;
  /** Slot ids this person can make. Ignored when anyTime is true. */
  slotIds: string[];
  /** "Any time works": available for every slot. */
  anyTime: boolean;
  /** Cuisines they'd like, lowercase ("italian", "thai"). Empty = no preference. */
  cuisines: string[];
  /** Cuisines they want to avoid, lowercase. */
  avoidCuisines: string[];
  /** Hard dietary constraints, lowercase ("vegetarian", "nut allergy"). */
  dietary: string[];
  /** Private per-person budget cap. Never revealed to the group. */
  budgetCents?: Cents;
  /** Extra guests this person is bringing. */
  plusOnes: number;
  /** ISO timestamp. Latest reply wins until the deadline. */
  updatedAt: string;
  /**
   * The organizer replaced the time options after this reply, so its slot
   * answers were cleared. Cuisine and dietary answers still count; the person
   * has to answer the new times. Gone once they reply again.
   */
  slotsStale?: boolean;
}

export interface RestaurantOption {
  /** Number shown to friends: "1", "2", "3". */
  id: string;
  name: string;
  cuisine?: string;
  /** Estimated cost per person. */
  pricePerPersonCents?: Cents;
  notes?: string;
}

export interface Vote {
  personId: string;
  restaurantId: string;
  updatedAt: string;
}

/** How firm the organizer's own restaurant pick is. */
export type PickFirmness = "locked" | "suggested";

/** Fairness memory: who gave something up, so they get priority next time. */
export interface Concession {
  /** The person's phone, or email if they have no phone: ids are per event, contacts persist across dinners. */
  contact: string;
  eventId: string;
  /** What they gave up, e.g. "cuisine: thai" or "time slot". */
  what: string;
  at: string;
  /** Set once this concession has been honored at a later dinner. */
  redeemedInEventId?: string;
}

// ---------- Booking ----------

export interface Booking {
  restaurantName: string;
  slotId: string;
  startsAt: string;
  partySize: number;
  confirmation?: string;
  /** Deposit the organizer already paid. Comes off the final bill fairly. */
  depositCents?: Cents;
  /** Large party auto gratuity: the split must not add a second tip. */
  autoGratuity?: boolean;
  notes?: string;
}

// ---------- Receipt and claims ----------

export interface LineItem {
  /** 1-based number shown to friends, unique across all receipts in the event. */
  number: number;
  description: string;
  /** Line total in cents (quantity already multiplied in). Negative for comps. */
  amountCents: Cents;
}

export interface Receipt {
  id: string;
  items: LineItem[];
  subtotalCents: Cents;
  taxCents: Cents;
  /** Tip the group is adding or that's printed on the receipt. */
  tipCents: Cents;
  /** Service charges, delivery fees, etc. */
  feesCents: Cents;
  /** Positive number for discounts applied to the whole bill. */
  discountCents: Cents;
  totalCents: Cents;
  /** Service charge or tip already included on the receipt. */
  tipIncluded: boolean;
  /**
   * Deposit credit printed on the receipt. Informational only: it is already
   * folded into discountCents (when booking.depositCents holds the deposit) or
   * into totalCents (when it doesn't), so the deposit is counted exactly once.
   */
  depositCreditCents?: Cents;
}

export interface Claim {
  personId: string;
  itemNumber: number;
  /** Relative portion for uneven sharing (2 of 3 slices = weight 2). Default 1. */
  weight: number;
}

// ---------- Split engine ----------

export type ExtraMode = "proportional" | "even";

export interface SplitExtra {
  label: string; // "tax", "tip", "fees", "discount", "deposit credit"
  /** Positive adds to what people owe, negative reduces it. */
  amountCents: Cents;
  mode: ExtraMode;
}

export interface SplitInput {
  items: LineItem[];
  extras: SplitExtra[];
  claims: Claim[];
  /** Person ids of confirmed attendees. Claims from anyone else are rejected. */
  attendeeIds: string[];
  /** Grand total the shares must add up to exactly. */
  expectedTotalCents: Cents;
  unclaimedPolicy: "block" | "split_evenly";
  /** People being treated (birthday). Their share moves onto everyone else. */
  treatedIds?: string[];
}

export interface ItemShare {
  itemNumber: number;
  description: string;
  /** e.g. "1/3" or "2/3". "1" when they had the whole item. */
  fraction: string;
  shareCents: Cents;
}

export interface PersonShare {
  personId: string;
  items: ItemShare[];
  subtotalCents: Cents;
  /** Tax, tip, fees, discounts combined. */
  extrasCents: Cents;
  /** Amount moved onto this person from treated people. */
  treatCents: Cents;
  totalCents: Cents;
}

export type SplitError =
  | { code: "UNCLAIMED_ITEMS"; itemNumbers: number[] }
  | { code: "UNKNOWN_ITEM"; itemNumbers: number[] }
  | { code: "NON_ATTENDEE_CLAIM"; personIds: string[] }
  | { code: "NO_ATTENDEES" }
  | { code: "TOTAL_MISMATCH"; expectedCents: Cents; actualCents: Cents }
  | { code: "INVALID_INPUT"; message: string };

export type SplitResult =
  | { ok: true; shares: PersonShare[]; totalCents: Cents }
  | { ok: false; error: SplitError };

// ---------- The event ----------

/**
 * Before locking a time that leaves someone out, pick_time asks each of them
 * privately whether one of the best times could work after all.
 */
export interface ShiftCheck {
  askedAt: string;
  /** pick_time decides at this point even if some of them never answered. */
  deadline: string;
  /** Who was asked, and about which slots. */
  asks: { personId: string; slotIds: string[] }[];
  /** People who answered the question, including a "no" that changed nothing. */
  answeredIds: string[];
}

export interface DinnerEvent {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  stage: Stage;

  organizerId: string;
  /** Organizer's Venmo handle, without the @. */
  organizerVenmo?: string;
  people: Person[];

  // Planning
  timeSlots: TimeSlot[];
  /** Group budget per person, as stated by the organizer. */
  budgetPerPersonCents?: Cents;
  cuisineHint?: string;
  /** ISO deadline for round 1 replies. */
  replyDeadline?: string;
  /** People Fo already nudged once. */
  nudgedIds: string[];
  preferences: Preferences[];
  chosenSlotId?: string;
  /** Winning cuisine from pick_time, so next actions can name it. */
  chosenCuisine?: string;
  /** Set when pick_time asked whoever would miss the best time whether they can shift. Once per round of time options. */
  shiftCheck?: ShiftCheck;

  // Voting
  organizerPick?: { restaurantName: string; firmness: PickFirmness };
  restaurantOptions: RestaurantOption[];
  votes: Vote[];
  winningRestaurantId?: string;

  // Booking
  booking?: Booking;

  // Claiming
  receipts: Receipt[];
  /** Person ids who actually came. Undefined until set_attendees is called. */
  attendeeIds?: string[];
  claims: Claim[];
  /** Attendees who answered the item list, including "I had nothing" replies with no claim rows. */
  claimAnsweredIds: string[];
  treatedIds: string[];
  unclaimedPolicy: "block" | "split_evenly";
  /** Split delivery-style fees evenly instead of proportionally. */
  feesSplitEvenly: boolean;

  // Paying: totals worked out and waiting for the organizer's yes
  shares?: PersonShare[];
  /** When send_totals ran: each friend got their total and Venmo link, and the dinner is finished. Payments aren't tracked. */
  totalsSentAt?: string;
  /**
   * The organizer covers the whole bill (their treat): no split and no payment requests.
   * Can be set before the meal (a birthday treat); the dinner then settles after it.
   */
  organizerCovered?: boolean;
}
