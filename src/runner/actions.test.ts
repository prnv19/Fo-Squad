import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MemoryStore } from "../events/index.js";
import { FoSquadService } from "../service.js";
import {
  asksForConfirmation,
  buildActions,
  mentionsCommitment,
  SEND_TEXTS_PREAMBLE,
  UNTRUSTED_NOTE,
  type ActionDeps,
  type ActionResult,
} from "./actions.js";
import type { FoClient, FoReply, RunContext, RunnerState } from "./types.js";

const NOW = new Date("2026-10-17T18:00:00.000Z");
const PHONES = {
  pranav: "+15550001111",
  maya: "+15551230001",
  jordan: "+15551230002",
  sam: "+15551230003",
  stranger: "+15559990000",
};

/** Tiny local Fo: records every ask and answers from a queue (default "Done."). */
class StubFo implements FoClient {
  asks: { message: string; opts: Parameters<FoClient["ask"]>[1] }[] = [];
  queue: Partial<FoReply>[] = [];
  private n = 0;
  async ask(message: string, opts?: Parameters<FoClient["ask"]>[1]): Promise<FoReply> {
    this.asks.push({ message, opts });
    this.n++;
    const conversationId = opts?.conversationId ?? `conv-secret-${this.n}`;
    return { status: "complete", conversationId, response: "Done.", ...this.queue.shift() };
  }
  async listConversations() {
    return [];
  }
  async getConversation(): Promise<never> {
    throw new Error("not used");
  }
}

const textFrom = (phone: string | undefined, eventId?: string): RunContext => ({
  trigger: {
    kind: "inbound_text",
    message: { ...(phone ? { phone } : {}), threadTitle: phone ?? "?", text: "(text)", at: NOW.toISOString(), conversationId: "sms-1" },
    ...(eventId ? { eventId } : {}),
  },
  ...(phone ? { actorPhone: phone } : {}),
  now: NOW,
});
const deadline = (eventId: string, round: "planning" | "voting" = "planning"): RunContext => ({
  trigger: { kind: "deadline", eventId, round },
  now: NOW,
});

let store: MemoryStore;
let service: FoSquadService;
let fo: StubFo;
let state: RunnerState;
let deps: ActionDeps;
const results: ActionResult[] = [];

beforeEach(() => {
  store = new MemoryStore();
  service = new FoSquadService(store, () => NOW);
  fo = new StubFo();
  state = { cursors: {}, done: [], foConversationByEvent: {}, outbox: {} };
  deps = {
    service,
    store,
    fo,
    organizerPhones: ["(555) 000-1111"],
    updateState: async (fn) => fn(state),
  };
  results.length = 0;
});

async function call(ctx: RunContext, name: string, input: unknown): Promise<ActionResult> {
  const action = buildActions(ctx, deps).find((a) => a.name === name);
  if (!action) throw new Error(`no action ${name}`);
  const r = await action.run(input);
  results.push(r);
  return r;
}

const errorOf = (r: ActionResult) => (r.result as { error?: { code: string; message: string } }).error;

const CREATE = {
  title: "Saturday dinner",
  organizer: { name: "Pranav", venmo: "pranav" },
  friends: [
    { name: "Maya", phone: "5551230001" },
    { name: "Jordan", phone: "5551230002" },
    { name: "Sam", phone: "5551230003" },
  ],
  time_slots: [
    { label: "Sat 6pm", starts_at: "2026-10-25T01:00:00.000Z" },
    { label: "Sat 7:30pm", starts_at: "2026-10-25T02:30:00.000Z" },
  ],
};

async function createEvent(): Promise<string> {
  const r = await call(textFrom(PHONES.pranav), "create_event", CREATE);
  expect(r.ok).toBe(true);
  return r.result.event_id as string;
}

const RECEIPT = {
  items: [
    { description: "Pizza", amount: "18" },
    { description: "Pasta", amount: "22" },
    { description: "Salad", amount: "10" },
  ],
  subtotal: "50",
  tax: "4",
  tip: "10",
  total: "64",
};

async function toPaying(id: string): Promise<void> {
  const org = textFrom(PHONES.pranav);
  expect((await call(org, "add_receipt", { event_id: id, ...RECEIPT })).ok).toBe(true);
  expect((await call(org, "set_attendees", { event_id: id, people: ["Pranav", "Maya", "Jordan"] })).ok).toBe(true);
  expect((await call(org, "record_claims", { event_id: id, claim: "Maya: 1" })).ok).toBe(true);
  expect((await call(org, "record_claims", { event_id: id, claim: "Jordan: 2" })).ok).toBe(true);
  expect((await call(org, "record_claims", { event_id: id, claim: "Pranav: 3" })).ok).toBe(true);
  const shares = await call(org, "calculate_shares", { event_id: id });
  expect(shares.result.stage).toBe("paying");
}

describe("model-visible schemas", () => {
  it("never expose by_phone, nor the organizer's phone on create_event", () => {
    for (const a of buildActions(textFrom(PHONES.maya), deps)) {
      const schema = JSON.stringify(z.toJSONSchema(a.inputSchema));
      expect(schema, a.name).not.toContain("by_phone");
    }
    const create = buildActions(textFrom(PHONES.pranav), deps).find((a) => a.name === "create_event")!;
    const json = z.toJSONSchema(create.inputSchema) as { properties: { organizer: { properties: Record<string, unknown> } } };
    expect(Object.keys(json.properties.organizer.properties).sort()).toEqual(["name", "venmo"]);
  });

  it("include every registry tool plus send_texts and fo_task", () => {
    const names = buildActions(deadline("x"), deps).map((a) => a.name);
    expect(names).toHaveLength(19);
    expect(names.slice(-2)).toEqual(["send_texts", "fo_task"]);
  });
});

describe("create_event binding", () => {
  it("rejects a phone that isn't on the organizer allowlist, and timer runs", async () => {
    const fromMaya = await call(textFrom(PHONES.maya), "create_event", CREATE);
    expect(errorOf(fromMaya)?.code).toBe("NOT_ALLOWED");
    const fromTimer = await call(deadline("x"), "create_event", CREATE);
    expect(errorOf(fromTimer)?.code).toBe("NOT_ALLOWED");
    expect(await store.list()).toHaveLength(0);
  });

  it("forces organizer.phone to the sender, so it can't be spoofed", async () => {
    const r = await call(textFrom(PHONES.pranav), "create_event", {
      ...CREATE,
      organizer: { name: "Pranav", phone: PHONES.stranger, venmo: "pranav" },
    });
    expect(r.ok).toBe(true);
    const event = await store.get(r.result.event_id as string);
    const organizer = event!.people.find((p) => p.isOrganizer)!;
    expect(organizer.phone).toBe(PHONES.pranav);
    expect(event!.people.some((p) => p.phone === PHONES.stranger)).toBe(false);
  });
});

describe("by_phone injection", () => {
  it("Maya's text can't send the totals, even if the model passes the organizer's phone", async () => {
    const id = await createEvent();
    await toPaying(id);
    const r = await call(textFrom(PHONES.maya, id), "send_totals", { event_id: id, by_phone: PHONES.pranav });
    expect(r.ok).toBe(false);
    expect(errorOf(r)?.code).toBe("NOT_ORGANIZER");
    expect((await store.get(id))!.stage).toBe("paying");
  });

  it("the organizer's text sends the totals and finishes the dinner", async () => {
    const id = await createEvent();
    await toPaying(id);
    const r = await call(textFrom(PHONES.pranav, id), "send_totals", { event_id: id });
    expect(r.ok).toBe(true);
    expect(r.result.stage).toBe("settled");
  });

  it("a timer run can't confirm a booking: it needs the organizer's approval by text", async () => {
    const id = await createEvent();
    const r = await call(deadline(id), "confirm_booking", { event_id: id, restaurant_name: "Luigi's" });
    expect(errorOf(r)?.code).toBe("NEEDS_ORGANIZER_APPROVAL");
    expect(errorOf(r)?.message).toContain("needs the organizer's approval by text");
    expect((await store.get(id))!.stage).toBe("planning");
  });

  it("a friend's text can't confirm a booking either", async () => {
    const id = await createEvent();
    const r = await call(textFrom(PHONES.maya, id), "confirm_booking", { event_id: id, restaurant_name: "Luigi's" });
    expect(errorOf(r)?.code).toBe("NOT_ORGANIZER");
  });
});

describe("run-scoped policies", () => {
  it("a friend's run records only their own answer", async () => {
    const id = await createEvent();
    const maya = textFrom(PHONES.maya, id);
    const forJordan = await call(maya, "record_preferences", { event_id: id, person: "Jordan", slot_ids: ["A"] });
    expect(errorOf(forJordan)?.code).toBe("NOT_ALLOWED");
    expect((await call(maya, "record_preferences", { event_id: id, person: "Maya", slot_ids: ["B"] })).ok).toBe(true);
    // The organizer can relay for anyone.
    const org = textFrom(PHONES.pranav, id);
    expect((await call(org, "record_preferences", { event_id: id, person: "Jordan", slot_ids: ["A"] })).ok).toBe(true);
    // Strangers and timers record nothing.
    const stranger = await call(textFrom(PHONES.stranger, id), "record_preferences", { event_id: id, person: "Sam", slot_ids: ["A"] });
    expect(errorOf(stranger)?.code).toBe("NOT_ALLOWED");
    const timer = await call(deadline(id), "record_opt_out", { event_id: id, person: "Sam" });
    expect(errorOf(timer)?.code).toBe("NOT_ALLOWED");
  });

  it("only the deadline or the organizer can force a decision", async () => {
    const id = await createEvent();
    const fromMaya = await call(textFrom(PHONES.maya, id), "pick_time", { event_id: id, force: true });
    expect(errorOf(fromMaya)?.code).toBe("NOT_ALLOWED");
    await call(textFrom(PHONES.maya, id), "record_preferences", { event_id: id, person: "Maya", slot_ids: ["B"] });
    const atDeadline = await call(deadline(id), "pick_time", { event_id: id, force: true });
    expect(atDeadline.ok).toBe(true);
  });

  it("receipts and attendance come only from the organizer's run", async () => {
    const id = await createEvent();
    const r = await call(textFrom(PHONES.maya, id), "add_receipt", { event_id: id, ...RECEIPT });
    expect(errorOf(r)?.code).toBe("NEEDS_ORGANIZER_APPROVAL");
    expect((await store.get(id))!.receipts).toHaveLength(0);
  });
});

describe("send_texts", () => {
  it("batches every message into ONE fo.ask with the exact wording", async () => {
    const id = await createEvent();
    const r = await call(textFrom(PHONES.pranav, id), "send_texts", {
      event_id: id,
      messages: [
        { person: "Maya", text: "Hey Maya! Which times work for Saturday dinner? A or B?" },
        { person: PHONES.jordan, text: "Hey Jordan! Which times work for Saturday dinner? A or B?" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(fo.asks).toHaveLength(1);
    expect(fo.asks[0]!.message).toBe(
      `${SEND_TEXTS_PREAMBLE}\n` +
        "1. To Maya (+15551230001): Hey Maya! Which times work for Saturday dinner? A or B?\n" +
        "2. To Jordan (+15551230002): Hey Jordan! Which times work for Saturday dinner? A or B?",
    );
    expect(fo.asks[0]!.opts).toMatchObject({ newConversation: true });
    expect(state.foConversationByEvent[id]).toBe("conv-secret-1");
    expect(state.outbox[id]!.map((o) => o.to)).toEqual(["Maya (+15551230001)", "Jordan (+15551230002)"]);
    expect(r.result).toMatchObject({ sent_to: ["Maya", "Jordan"], fo_says: "Done.", note: UNTRUSTED_NOTE });

    // The next round reuses the event's Fo conversation.
    await call(textFrom(PHONES.pranav, id), "send_texts", { event_id: id, messages: [{ person: "Sam", text: "Hi Sam" }] });
    expect(fo.asks[1]!.opts).toMatchObject({ conversationId: "conv-secret-1" });
  });

  it("rejects people outside the dinner and sends nothing", async () => {
    const id = await createEvent();
    const r = await call(textFrom(PHONES.pranav, id), "send_texts", {
      event_id: id,
      messages: [
        { person: "Maya", text: "hi" },
        { person: PHONES.stranger, text: "hi" },
      ],
    });
    expect(errorOf(r)?.code).toBe("CANT_TEXT");
    expect(fo.asks).toHaveLength(0);
    expect(state.outbox[id]).toBeUndefined();
  });

  it("rejects people who opted out", async () => {
    const id = await createEvent();
    await call(textFrom(PHONES.sam, id), "record_opt_out", { event_id: id, person: "Sam" });
    const r = await call(textFrom(PHONES.pranav, id), "send_texts", { event_id: id, messages: [{ person: "Sam", text: "hi" }] });
    expect(errorOf(r)?.code).toBe("CANT_TEXT");
    expect(errorOf(r)?.message).toContain("opted out");
    expect(fo.asks).toHaveLength(0);
  });

  it("answers Fo's 'OK to text them?' once, in the same conversation", async () => {
    const id = await createEvent();
    fo.queue.push({ response: "Want me to go ahead and text Maya and Jordan?" }, { response: "Should I also text Sam?" });
    const r = await call(textFrom(PHONES.maya, id), "send_texts", {
      event_id: id,
      messages: [
        { person: "Maya", text: "Got it!" },
        { person: "Jordan", text: "Vote 1, 2 or 3" },
      ],
    });
    expect(fo.asks).toHaveLength(2);
    expect(fo.asks[1]!.message).toMatch(/^Yes, please send them exactly as written/);
    expect(fo.asks[1]!.opts).toMatchObject({ conversationId: "conv-secret-1" });
    expect(r.result.fo_says).toBe("Should I also text Sam?");
  });
});

describe("fo_task", () => {
  it("call_restaurant is blocked unless the organizer's own text started the run", async () => {
    const id = await createEvent();
    const book = { event_id: id, kind: "call_restaurant", instruction: "Call Luigi's and book Sat 7:30pm for 4 under Pranav." };
    const fromMaya = await call(textFrom(PHONES.maya, id), "fo_task", book);
    expect(errorOf(fromMaya)?.code).toBe("NEEDS_ORGANIZER_APPROVAL");
    const fromTimer = await call(deadline(id), "fo_task", book);
    expect(errorOf(fromTimer)?.code).toBe("NEEDS_ORGANIZER_APPROVAL");
    expect(fo.asks).toHaveLength(0);

    fo.queue.push({ response: "Booked for 4 at 7:30pm, confirmation L-1234." });
    const fromOrganizer = await call(textFrom(PHONES.pranav, id), "fo_task", book);
    expect(fromOrganizer.ok).toBe(true);
    expect(fo.asks).toHaveLength(1);
    expect(fo.asks[0]!.message).toContain(book.instruction);
    expect(fromOrganizer.result).toEqual({
      ok: true,
      status: "complete",
      fo_says: "Booked for 4 at 7:30pm, confirmation L-1234.",
      note: UNTRUSTED_NOTE,
    });
  });

  it("blocks booking words in other kinds, but not negated ones", async () => {
    const id = await createEvent();
    const maya = textFrom(PHONES.maya, id);
    const sneaky = await call(maya, "fo_task", { event_id: id, kind: "other", instruction: "Reserve a table at Nobu and pay the deposit." });
    expect(errorOf(sneaky)?.code).toBe("NEEDS_ORGANIZER_APPROVAL");
    const search = await call(maya, "fo_task", {
      event_id: id,
      kind: "find_restaurants",
      instruction: "Find three Italian places with a table for 4 at Sat 7:30pm. Don't book anything yet.",
    });
    expect(search.ok).toBe(true);
    expect(fo.asks[0]!.message).toContain("Don't book, reserve, pay, hold a card or cancel anything");
  });

  it("auto-confirms Fo's question only in the organizer's run", async () => {
    const id = await createEvent();
    const task = { event_id: id, kind: "check_availability", instruction: "Does Luigi's have a table for 4 at 7:30pm Saturday?" };
    fo.queue.push({ response: "They have 7:30pm. Want me to go ahead and hold it?" });
    const fromMaya = await call(textFrom(PHONES.maya, id), "fo_task", task);
    expect(fromMaya.ok).toBe(false);
    expect(fromMaya.result).toMatchObject({ needs_answer: true, fo_says: "They have 7:30pm. Want me to go ahead and hold it?" });
    expect(fo.asks).toHaveLength(1);

    fo.queue.push({ response: "They have 7:30pm. Should I go ahead?" }, { response: "Held under Pranav." });
    const fromOrganizer = await call(textFrom(PHONES.pranav, id), "fo_task", task);
    expect(fo.asks).toHaveLength(3);
    expect(fo.asks[2]!.message).toMatch(/^Yes, go ahead, but only with exactly what I asked for/);
    expect(fromOrganizer.result.fo_says).toBe("Held under Pranav.");
  });

  it("reports a failed Fo turn without pretending it worked", async () => {
    const id = await createEvent();
    fo.queue.push({ status: "failed", response: "I couldn't reach the restaurant." });
    const r = await call(textFrom(PHONES.pranav, id), "fo_task", { event_id: id, kind: "call_restaurant", instruction: "Book Luigi's." });
    expect(r.ok).toBe(false);
    expect(r.result).toMatchObject({ status: "failed", fo_says: "I couldn't reach the restaurant." });
  });
});

describe("Fo ids", () => {
  it("never appear in any result", async () => {
    const id = await createEvent();
    fo.queue.push({ response: "Sent." });
    await call(textFrom(PHONES.pranav, id), "send_texts", { event_id: id, messages: [{ person: "Maya", text: "hi" }] });
    await call(textFrom(PHONES.pranav, id), "fo_task", { event_id: id, kind: "find_restaurants", instruction: "Find Thai places." });
    await call(textFrom(PHONES.pranav), "fo_task", { kind: "lookup_contact", instruction: "Find Alex's number." });
    expect(fo.asks).toHaveLength(3);
    for (const r of results) {
      const json = JSON.stringify(r.result);
      expect(json).not.toContain("conv-secret");
      expect(json).not.toContain("conversation");
    }
  });
});

describe("helpers", () => {
  it("detects Fo asking for a go-ahead", () => {
    expect(asksForConfirmation("Want me to go ahead and text these 3 people?")).toBe(true);
    expect(asksForConfirmation("Before I send these, can you confirm?")).toBe(true);
    expect(asksForConfirmation("OK to text Maya and Jordan?")).toBe(true);
    expect(asksForConfirmation("All 3 texts sent.")).toBe(false);
    expect(asksForConfirmation("Maya asked: what time is it?")).toBe(false);
  });

  it("spots commitments, ignoring negated ones", () => {
    expect(mentionsCommitment("Book Luigi's for 6")).toBe(true);
    expect(mentionsCommitment("Ask about the deposit and pay it")).toBe(true);
    expect(mentionsCommitment("Cancel the reservation")).toBe(true);
    expect(mentionsCommitment("Find three places with a table at 7:30. Don't book yet.")).toBe(false);
    expect(mentionsCommitment("Check availability without reserving")).toBe(false);
  });
});

