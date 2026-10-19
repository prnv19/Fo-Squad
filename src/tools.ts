// The single definition of every Fo Squad tool: name, description, input
// shape and which service method runs it. src/server.ts registers these with
// MCP and src/runner/actions.ts hands them to the headless brain, so the two
// can never drift apart. Descriptions are what the caller reads to decide when
// to call a tool, so they say when and what comes back.

import { z } from "zod";
import { isFoError } from "./events/index.js";
import { readPlaybook } from "./playbook.js";
import type { FoSquadService, ToolResult } from "./service.js";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape of the arguments (what MCP's registerTool takes). */
  inputShape: z.ZodRawShape;
  /** Whether by_phone or by_email (who sent the request) must be given. Absent: the tool takes neither. */
  sender?: "required" | "optional";
  /** Runs the service call. `args` must already be validated against inputShape. */
  run(service: FoSquadService, args: Record<string, unknown>): Promise<ToolResult>;
}

// Keeps each run() typed against its own shape, then erases to ToolDef for the list.
function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  inputShape: S;
  sender?: "required" | "optional";
  run: (service: FoSquadService, args: z.output<z.ZodObject<S>>) => Promise<ToolResult>;
}): ToolDef {
  return def as unknown as ToolDef;
}

const money = z.union([z.string(), z.number()]);
const eventId = z.string().min(1).describe("The dinner's event_id from create_event or get_status.");
const person = (what = "The person") =>
  z.string().min(1).describe(`${what}: person id ("maya"), name ("Maya"), phone number or email.`);
const byPhone = (what: string) =>
  z.string().min(1).describe(`Phone number the text came from. ${what} For an email, pass by_email instead.`);
const byEmail = (what: string) =>
  z.string().min(1).describe(`Email address the email came from. ${what} For a text, pass by_phone instead.`);
const phone = z.string().optional().describe("Phone number. Fo texts people who have one.");
const email = z.string().optional().describe("Email address. Fo emails people who have no phone (e.g. a work lunch).");
const slot = z.object({
  label: z.string().describe('What friends see, e.g. "Sat 7:30pm".'),
  starts_at: z.string().describe("ISO 8601 start time, e.g. 2026-10-24T19:30:00-07:00."),
});
const friend = z.object({ name: z.string(), phone, email }).describe("Needs a phone or an email.");
const organizerPick = z.object({
  restaurant_name: z.string(),
  firmness: z.enum(["locked", "suggested"]).describe('"locked" = set, only collect times; "suggested" = default, open to pushback.'),
});
const force = z.boolean().optional().describe("Decide now with whoever answered, without waiting for everyone or the deadline.");

export const TOOLS: readonly ToolDef[] = [
  defineTool({
    name: "create_event",
    title: "Create a dinner",
    description:
      "Call when the organizer asks to plan a dinner or lunch, or sends a receipt with no active dinner (omit time_slots for a split-only night). Give each person a phone (Fo texts them) or an email (Fo emails them). Returns event_id, people with ids, contacts and channel, and time slots A, B, C...; confirm the list with the organizer before messaging anyone.",
    inputShape: {
      title: z.string().min(1).describe('Short name used in every message, e.g. "Saturday dinner".'),
      organizer: z
        .object({
          name: z.string(),
          phone,
          email,
          venmo: z.string().optional().describe("Organizer's Venmo username, used for pay links."),
        })
        .describe("Needs a phone or an email: whatever they reached you from."),
      friends: z.array(friend).min(1),
      time_slots: z.array(slot).optional().describe("3 or 4 options; ids are assigned A, B, C... Omit for a split-only night."),
      budget_per_person: money.optional().describe('Dollars, e.g. "50".'),
      cuisine_hint: z.string().optional(),
      reply_deadline: z.string().optional().describe("ISO time. Defaults to 2 hours from now."),
      organizer_pick: organizerPick.optional(),
      separate_dinner: z
        .boolean()
        .optional()
        .describe("Split-only night (no time_slots) while the organizer has another open dinner: true only once they said the receipt is from a different meal."),
    },
    run: (service, args) => service.createEvent(args),
  }),
  defineTool({
    name: "update_event",
    title: "Organizer edits",
    description:
      "Organizer-only edits: new time_slots after pick_time finds no overlap (clears slot answers and reopens planning), fix a phone number or email, add or remove friends, change the pick, Venmo handle or deadline. Returns what changed plus the updated people and slots.",
    inputShape: {
      event_id: eventId,
      by_phone: byPhone("Must be the organizer's number.").optional(),
      by_email: byEmail("Must be the organizer's email.").optional(),
      time_slots: z.array(slot).optional().describe("Replaces every time option."),
      organizer_pick: organizerPick.optional(),
      organizer_venmo: z.string().optional(),
      reply_deadline: z.string().optional().describe("ISO time in the future."),
      fix_phone: z.object({ person: z.string(), phone: z.string() }).optional(),
      fix_email: z.object({ person: z.string(), email: z.string() }).optional(),
      add_friends: z.array(friend).optional(),
      remove_friends: z.array(z.string()).optional().describe("People to remove (id, name, phone or email)."),
    },
    sender: "required",
    run: (service, args) => service.updateEvent(args),
  }),
  defineTool({
    name: "record_preferences",
    title: "Save a round 1 answer",
    description:
      "Call for each friend's reply to the times and food question. Latest reply wins until the deadline; after that it returns PLAN_LOCKED, so tell them the plan is set. Returns what was saved and who is still pending.",
    inputShape: {
      event_id: eventId,
      person: person(),
      slot_ids: z.array(z.string()).describe('Letters they can make, e.g. ["B", "C"]. Empty if none work.'),
      any_time: z.boolean().optional().describe('"Any time works".'),
      cuisines: z.array(z.string()).optional(),
      avoid_cuisines: z.array(z.string()).optional(),
      dietary: z.array(z.string()).optional().describe('Hard needs, e.g. ["vegetarian", "nut allergy"].'),
      budget: money.optional().describe("Private per-person budget in dollars. Never shared."),
      plus_ones: z.number().int().min(0).optional(),
    },
    run: (service, args) => service.recordPreferences(args),
  }),
  defineTool({
    name: "mark_nudged",
    title: "Record a nudge",
    description:
      "Call right after nudging a quiet friend during Planning or Voting, so nobody gets nudged twice. Returns everyone nudged so far.",
    inputShape: { event_id: eventId, person: person() },
    run: (service, args) => service.markNudged(args),
  }),
  defineTool({
    name: "pick_time",
    title: "Pick the time",
    description:
      "Call when everyone answered, or at the deadline (force: true to decide early). If the best time leaves someone out, the first call locks nothing and returns status check_shift with ask_to_shift: a private question for each person who'd miss out; record their answers, then call again. Once decided, returns the slot, who can and can't make it, party_size, the winning cuisine, hard_constraints every restaurant must meet, and any fairness_note; status no_overlap means ask the organizer for new times via update_event.",
    inputShape: {
      event_id: eventId,
      force,
      skip_shift_check: z
        .boolean()
        .optional()
        .describe("Only when the organizer says to decide now: lock the best time without asking (or waiting on) whoever would miss out."),
    },
    run: (service, args) => service.pickTime(args),
  }),
  defineTool({
    name: "set_restaurant_options",
    title: "Open the restaurant vote",
    description:
      "Call after pick_time with the shortlist (usually three restaurants with a table at the chosen time). Saves them as options 1, 2, 3 and opens voting; options that break a hard constraint come back under rejected and are left off the ballot.",
    inputShape: {
      event_id: eventId,
      options: z
        .array(
          z.object({
            name: z.string(),
            cuisine: z.string().optional(),
            price_per_person: money.optional().describe("Estimated dollars per person."),
            notes: z.string().optional(),
          }),
        )
        .min(1),
    },
    run: (service, args) => service.setRestaurantOptions(args),
  }),
  defineTool({
    name: "record_vote",
    title: "Save a vote",
    description:
      "Call for each restaurant vote reply. Latest vote wins. Returns the vote and who hasn't voted yet.",
    inputShape: {
      event_id: eventId,
      person: person("The voter"),
      option: z.string().min(1).describe('Option number ("1") or restaurant name.'),
    },
    run: (service, args) => service.recordVote(args),
  }),
  defineTool({
    name: "tally_votes",
    title: "Count the votes",
    description:
      "Call when everyone voted, or with force: true to decide with the votes in. Returns the winner, reason (\"Luigi's won 4 to 2\"), ranked runner_ups to try if the winner is full, party_size and any fairness_note; ties go to the organizer.",
    inputShape: { event_id: eventId, force },
    run: (service, args) => service.tallyVotes(args),
  }),
  defineTool({
    name: "confirm_booking",
    title: "Confirm the booking",
    description:
      "Call only after the organizer says yes and the table is booked; by_phone (or by_email) must be the organizer's. Records the restaurant, slot, party size, deposit and auto gratuity (used by the split) and moves the dinner to Booked.",
    inputShape: {
      event_id: eventId,
      by_phone: byPhone("Must be the organizer's number.").optional(),
      by_email: byEmail("Must be the organizer's email.").optional(),
      restaurant_name: z.string().min(1),
      slot_id: z.string().optional().describe("Defaults to the slot pick_time chose."),
      party_size: z.number().int().min(1).optional().describe("Defaults to the party size pick_time computed."),
      confirmation: z.string().optional(),
      deposit: money.optional().describe("Deposit the organizer paid, in dollars."),
      auto_gratuity: z.boolean().optional().describe("Restaurant adds gratuity automatically (large party)."),
      notes: z.string().optional().describe("Cancellation policy and anything else worth remembering."),
    },
    sender: "required",
    run: (service, args) => service.confirmBooking(args),
  }),
  defineTool({
    name: "add_receipt",
    title: "Add a receipt",
    description:
      "Call with every line item from the receipt photo, before texting any friend. Organizer only (by_phone or by_email = whoever sent the receipt, which must be this dinner's organizer). Checks items sum to the subtotal and the parts sum to the total; on a mismatch nothing is saved and the error says by how much. Returns numbered items, the item_list to send friends and any warnings; call once per receipt.",
    inputShape: {
      event_id: eventId,
      items: z
        .array(z.object({ description: z.string(), amount: money.describe("Line total in dollars; negative for comps.") }))
        .min(1),
      subtotal: money,
      tax: money,
      tip: money.describe("Tip, or a printed service charge/gratuity (then also set tip_included)."),
      fees: money.optional().describe("Other printed fees (delivery, kitchen, card). A service charge or gratuity goes in tip, not here."),
      discount: money.optional().describe("Positive dollars off the bill. Never put a deposit credit here."),
      total: money.describe("Printed total, after any deposit credit."),
      tip_included: z.boolean().optional().describe("Service charge or gratuity already printed on the receipt."),
      deposit_credit: money.optional().describe("Deposit credit printed on the receipt, in dollars."),
      by_phone: byPhone("The organizer's number (who sent the receipt).").optional(),
      by_email: byEmail("The organizer's email (who sent the receipt).").optional(),
    },
    sender: "required",
    run: (service, args) => service.addReceipt(args),
  }),
  defineTool({
    name: "set_attendees",
    title: "Set who came",
    description:
      "Call after the organizer confirms who actually came, including the organizer if they ate. Only attendees can claim items. Returns attendees and the numbered item list.",
    inputShape: {
      event_id: eventId,
      people: z.array(z.string()).min(1).describe("Everyone who came (ids, names, phones or emails)."),
    },
    run: (service, args) => service.setAttendees(args),
  }),
  defineTool({
    name: "record_claims",
    title: "Save what someone had",
    description:
      'Call for each attendee\'s item reply, as claim "Maya: 1, 4" ("Maya: 1, 4x2" for a double portion, "Maya: none" if nothing) or person plus items. Shared item ("a third of the knots", "half the pie"): list it for each person who had some, and the server splits it among them evenly; never send a fraction. Use a weight only for uneven sharing, in whole portions (2 of 3 slices = 4x2 for them, 4 for the other). Replaces that person\'s claims; in Paying it reopens claiming for a dispute. Returns unclaimed items, shared items to flag and who hasn\'t answered.',
    inputShape: {
      event_id: eventId,
      claim: z.string().optional().describe('Fixed format "Name: 1, 4".'),
      person: person("Who had the items").optional(),
      items: z
        .array(
          z.object({
            number: z.number().int().min(1),
            weight: z.number().int().min(1).optional().describe("Whole portions when sharing unevenly. Leave out for an even share."),
          }),
        )
        .optional(),
    },
    run: (service, args) => service.recordClaims(args),
  }),
  defineTool({
    name: "calculate_shares",
    title: "Run the split",
    description:
      "Call when everyone answered, and again after a dispute. Returns each share, a summary for the organizer and a ready-to-send private message with Venmo link per friend. Sends nothing: show the organizer the summary and text friends only after they say yes.",
    inputShape: {
      event_id: eventId,
      by_phone: byPhone("Required (organizer's number) when using split_evenly or treated.").optional(),
      by_email: byEmail("Required (organizer's email) when using split_evenly or treated.").optional(),
      unclaimed_policy: z.enum(["block", "split_evenly"]).optional(),
      treated: z.array(z.string()).optional().describe("People being treated (birthday); their share moves onto everyone else."),
      fees_split_evenly: z.boolean().optional().describe("Split fees evenly instead of by subtotal."),
    },
    sender: "optional",
    run: (service, args) => service.calculateShares(args),
  }),
  defineTool({
    name: "cover_bill",
    title: "Organizer covers the bill",
    description:
      "Call when the organizer says it's their treat: asked after the dinner, or said up front (a birthday treat). Organizer only (by_phone or by_email). Before the meal it's noted and the plan carries on with no bill question; after the meal it closes the dinner with no split and no payment requests. Not once totals went out.",
    inputShape: {
      event_id: eventId,
      by_phone: byPhone("Must be the organizer's number.").optional(),
      by_email: byEmail("Must be the organizer's email.").optional(),
    },
    sender: "required",
    run: (service, args) => service.coverBill(args),
  }),
  defineTool({
    name: "send_totals",
    title: "Send the totals",
    description:
      "Call when the organizer says yes to the totals from calculate_shares. Organizer only (by_phone or by_email). Returns each friend's ready-to-send message with their Venmo link. It sends nothing itself: send each message yourself, then tell the organizer. The dinner is then finished; payments aren't tracked.",
    inputShape: {
      event_id: eventId,
      by_phone: byPhone("Must be the organizer's number.").optional(),
      by_email: byEmail("Must be the organizer's email.").optional(),
    },
    sender: "required",
    run: (service, args) => service.sendTotals(args),
  }),
  defineTool({
    name: "record_opt_out",
    title: "Friend replied STOP",
    description:
      "Call when a friend replies STOP to a text or asks to unsubscribe from emails. Never message them again. Returns a message to pass to the organizer.",
    inputShape: { event_id: eventId, person: person() },
    run: (service, args) => service.recordOptOut(args),
  }),
  defineTool({
    name: "get_playbook",
    title: "Read the rules",
    description:
      "Call once before you start or continue any dinner or lunch, and follow what it says. Returns the full standing instructions: every stage, message templates, timers, and how to handle disputes, opt-outs and texts versus emails.",
    inputShape: {},
    run: async () => ({ ok: true, playbook: readPlaybook() }),
  }),
  defineTool({
    name: "get_status",
    title: "Where things stand",
    description:
      "Call whenever unsure what to do. With event_id, or with the phone (text) or email (email) of whoever messaged you to find their active dinner. Returns the stage, who is pending with their contact and channel, and next_action; found: false means no active dinner for that number or email.",
    inputShape: {
      event_id: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
    },
    run: (service, args) => service.getStatus(args),
  }),];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/** Every tool but get_playbook, for callers that already put the playbook in the model's prompt (runner, sandbox). */
export const WORK_TOOLS: readonly ToolDef[] = TOOLS.filter((t) => t.name !== "get_playbook");

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export interface ServiceCallOutcome {
  result: ToolResult;
  isError: boolean;
}

/** Runs a service call and maps errors: FoError messages are safe to relay, anything else is not. */
export async function runServiceCall(name: string, fn: () => Promise<ToolResult>): Promise<ServiceCallOutcome> {
  try {
    return { result: await fn(), isError: false };
  } catch (err) {
    if (isFoError(err)) {
      return { result: { ok: false, error: { code: err.code, message: err.message } }, isError: true };
    }
    console.error(`[fo-squad] ${name} failed:`, err);
    return {
      result: {
        ok: false,
        error: {
          code: "INTERNAL",
          message: "Something went wrong on the Fo Squad server. Nothing was changed by this call; try again in a moment or tell the organizer.",
        },
      },
      isError: true,
    };
  }
}
