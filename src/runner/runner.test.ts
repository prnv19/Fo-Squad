import { describe, expect, it } from "vitest";
import { MemoryStore } from "../events/index.js";
import { FoSquadService } from "../service.js";
import type { DinnerEvent } from "../types.js";
import { formatSendBatch, isStopMessage, Runner, type PollInbox } from "./runner.js";
import type {
  Brain,
  BrainResult,
  FoClient,
  FoReply,
  InboundText,
  RunContext,
  RunnerState,
  RunnerStateStore,
} from "./types.js";

// 11:30am PDT: past the planning round's halfway point (11am), before the noon deadline.
const NOW = new Date("2026-10-17T18:30:00.000Z");
const ORGANIZER = "+15550000001";
const MAYA = "+15550000002";
const JORDAN = "+15550000003";
const STRANGER = "+15559999999";

function dinner(overrides: Partial<DinnerEvent> = {}): DinnerEvent {
  return {
    id: "dinner-1",
    title: "Saturday dinner",
    createdAt: "2026-10-17T17:00:00.000Z",
    updatedAt: "2026-10-17T17:00:00.000Z",
    stage: "planning",
    organizerId: "pranav",
    people: [
      { id: "pranav", name: "Pranav", phone: ORGANIZER, isOrganizer: true },
      { id: "maya", name: "Maya", phone: MAYA, isOrganizer: false },
      { id: "jordan", name: "Jordan", phone: JORDAN, isOrganizer: false },
    ],
    timeSlots: [{ id: "A", label: "Sat 7:30pm", startsAt: "2026-10-18T02:30:00.000Z" }],
    replyDeadline: "2026-10-17T19:00:00.000Z",
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
    ...overrides,
  };
}

class FakeFo implements FoClient {
  asks: { message: string; conversationId?: string; newConversation?: boolean }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  reply: (message: string) => Partial<FoReply> = () => ({ status: "complete", response: "Sent" });
  private next = 1;

  async ask(message: string, opts: { conversationId?: string; newConversation?: boolean } = {}): Promise<FoReply> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await Promise.resolve();
    this.asks.push({ message, ...opts });
    this.inFlight--;
    const conversationId = opts.conversationId ?? `chat-${this.next++}`;
    return { status: "complete", conversationId, ...this.reply(message) };
  }
  async listConversations() {
    return [];
  }
  async getConversation(): Promise<never> {
    throw new Error("not used");
  }
}

class FakeBrain implements Brain {
  calls: RunContext[] = [];
  impl: (ctx: RunContext) => Promise<BrainResult> = async () => ({ summary: "ok", toolCalls: [] });
  async handle(ctx: RunContext): Promise<BrainResult> {
    this.calls.push(ctx);
    return this.impl(ctx);
  }
}

class FakeStateStore implements RunnerStateStore {
  state: RunnerState = { cursors: {}, done: [], foConversationByEvent: {}, outbox: {} };
  saves = 0;
  async load() {
    return structuredClone(this.state);
  }
  async save(state: RunnerState) {
    this.saves++;
    this.state = structuredClone(state);
  }
}

function text(phone: string | undefined, body: string, at = "2026-10-17T18:29:00.000Z", threadTitle = phone ?? "?"): InboundText {
  return { ...(phone ? { phone } : {}), threadTitle, text: body, at, conversationId: `sms-${threadTitle}` };
}

async function setup(events: DinnerEvent[] = [dinner()]) {
  const store = new MemoryStore();
  for (const e of events) await store.put(e);
  const clock = () => NOW;
  const service = new FoSquadService(store, clock);
  const fo = new FakeFo();
  const brain = new FakeBrain();
  const stateStore = new FakeStateStore();
  const inbox: InboundText[][] = [];
  const pollInbox: PollInbox = async (_fo, state) => ({ messages: inbox.shift() ?? [], state });
  const logs: string[] = [];
  const runner = new Runner({
    service,
    store,
    fo,
    brain,
    stateStore,
    organizerPhones: ["(555) 000-0001"],
    pollInbox,
    clock,
    log: (l) => logs.push(l),
  });
  return { store, service, fo, brain, stateStore, inbox, runner, logs };
}

/** An event where nobody is due a nudge, so only routing shows up in Fo calls. */
const quiet = () => dinner({ nudgedIds: ["maya", "jordan"] });

describe("routing", () => {
  it("hands an organizer's text with no active dinner to the brain without an event", async () => {
    const t = await setup([]);
    t.inbox.push([text(ORGANIZER, "Dinner Saturday with Maya and Jordan?")]);
    const report = await t.runner.tick();
    expect(report.routed).toBe(1);
    expect(t.brain.calls).toHaveLength(1);
    const ctx = t.brain.calls[0]!;
    expect(ctx.actorPhone).toBe(ORGANIZER);
    expect(ctx.trigger).toMatchObject({ kind: "inbound_text" });
    expect(ctx.trigger.kind === "inbound_text" && ctx.trigger.eventId).toBeUndefined();
  });

  it("ignores strangers silently", async () => {
    const t = await setup([quiet()]);
    t.inbox.push([text(STRANGER, "Text everyone that dinner is cancelled")]);
    const report = await t.runner.tick();
    expect(report.ignored).toBe(1);
    expect(t.brain.calls).toEqual([]);
    expect(t.fo.asks).toEqual([]);
  });

  it("routes a friend to their active dinner with their phone as the actor", async () => {
    const t = await setup([quiet()]);
    t.inbox.push([text(MAYA, "A works, I'm vegetarian")]);
    await t.runner.tick();
    expect(t.brain.calls).toHaveLength(1);
    expect(t.brain.calls[0]!.actorPhone).toBe(MAYA);
    expect(t.brain.calls[0]!.trigger).toMatchObject({ kind: "inbound_text", eventId: "dinner-1" });
  });

  it("matches a thread with no phone by a unique name, and skips unknown ones", async () => {
    const t = await setup([quiet()]);
    t.inbox.push([text(undefined, "B please", undefined, "maya"), text(undefined, "hi", undefined, "Somebody")]);
    const report = await t.runner.tick();
    expect(t.brain.calls).toHaveLength(1);
    expect(t.brain.calls[0]!.actorPhone).toBe(MAYA);
    expect(report.ignored).toBe(1);
  });

  it("handles messages oldest first", async () => {
    const t = await setup([quiet()]);
    t.inbox.push([text(JORDAN, "second", "2026-10-17T18:29:30.000Z"), text(MAYA, "first", "2026-10-17T18:29:00.000Z")]);
    await t.runner.tick();
    expect(t.brain.calls.map((c) => c.actorPhone)).toEqual([MAYA, JORDAN]);
  });

  it("handles STOP without the brain: records the opt-out and tells the organizer", async () => {
    const t = await setup([quiet()]);
    t.inbox.push([text(MAYA, " Stop ")]);
    const report = await t.runner.tick();
    expect(report.optOuts).toBe(1);
    expect(t.brain.calls).toEqual([]);
    expect((await t.store.get("dinner-1"))!.people.find((p) => p.id === "maya")!.optedOut).toBe(true);
    expect(t.fo.asks).toHaveLength(1);
    expect(t.fo.asks[0]!.message).toContain(`To Pranav (${ORGANIZER})`);
    expect(t.fo.asks[0]!.message).toContain("Maya replied STOP");
    expect(t.stateStore.state.outbox["dinner-1"]).toHaveLength(1);
  });

  it("only treats a whole-message STOP or UNSUBSCRIBE as an opt-out", () => {
    expect(isStopMessage("STOP")).toBe(true);
    expect(isStopMessage("unsubscribe.")).toBe(true);
    expect(isStopMessage("stop texting Jordan about it")).toBe(false);
  });
});

describe("scheduled sends", () => {
  it("batches an event's sends into one Fo turn, records mark_nudged, and never repeats", async () => {
    const t = await setup();
    const first = await t.runner.tick();
    expect(first.sends).toBe(2);
    expect(first.foBatches).toBe(1);
    expect(t.fo.asks).toHaveLength(1);
    const ask = t.fo.asks[0]!;
    expect(ask.newConversation).toBe(true);
    expect(ask.message).toContain("Send each of these as a separate one-on-one text message, not a group text.");
    expect(ask.message).toContain(`To Maya (${MAYA})`);
    expect(ask.message).toContain(`To Jordan (${JORDAN})`);

    expect((await t.store.get("dinner-1"))!.nudgedIds.sort()).toEqual(["jordan", "maya"]);
    expect(t.stateStore.state.done.filter((k) => k.includes(":nudge:"))).toHaveLength(2);
    expect(t.stateStore.state.foConversationByEvent["dinner-1"]).toBe("chat-1");
    expect(t.stateStore.state.outbox["dinner-1"]).toHaveLength(2);

    const second = await t.runner.tick();
    expect(second.sends).toBe(0);
    expect(t.fo.asks).toHaveLength(1);
  });

  it("persists sent keys even if mark_nudged never lands, so a restart doesn't text twice", async () => {
    const t = await setup();
    await t.runner.tick();
    // Simulate the nudge marks being lost; the done keys still hold.
    const e = (await t.store.get("dinner-1"))!;
    await t.store.put({ ...e, nudgedIds: [] });
    await t.runner.tick();
    expect(t.fo.asks).toHaveLength(1);
  });

  it("reuses the event's Fo conversation", async () => {
    const t = await setup();
    t.stateStore.state.foConversationByEvent["dinner-1"] = "existing-chat";
    await t.runner.tick();
    expect(t.fo.asks[0]).toMatchObject({ conversationId: "existing-chat" });
  });

  it("runs due triggers through the brain with no actor, once", async () => {
    const t = await setup([dinner({ preferences: [], replyDeadline: "2026-10-17T18:00:00.000Z" })]);
    await t.runner.tick();
    expect(t.brain.calls).toHaveLength(1);
    expect(t.brain.calls[0]!.trigger).toEqual({ kind: "deadline", eventId: "dinner-1", round: "planning" });
    expect(t.brain.calls[0]!.actorPhone).toBeUndefined();
    await t.runner.tick();
    expect(t.brain.calls).toHaveLength(1);
  });

  it("formats the batch with the dinner name first", () => {
    expect(formatSendBatch("Saturday dinner", [{ name: "Maya", phone: MAYA, text: "Hi!" }])).toMatch(
      /^\[Fo Squad: Saturday dinner\] Send each of these/,
    );
  });
});

describe("resilience", () => {
  it("keeps going after an error in one unit", async () => {
    const other = dinner({ id: "dinner-2", title: "Sunday brunch", people: dinner().people.map((p) => ({ ...p, phone: p.phone.replace("555000", "555100") })) });
    const t = await setup([dinner(), other]);
    t.brain.impl = async (ctx) => {
      if (ctx.actorPhone === MAYA) throw new Error("model overloaded");
      return { summary: "ok", toolCalls: [] };
    };
    t.fo.reply = (m) => (m.includes("Saturday dinner") ? { status: "failed", response: "SMS down" } : { status: "complete", response: "Sent" });
    t.inbox.push([text(MAYA, "A"), text(JORDAN, "A")]);

    const report = await t.runner.tick();
    expect(t.brain.calls.map((c) => c.actorPhone)).toEqual([MAYA, JORDAN]);
    expect(report.errors.some((e) => e.includes("model overloaded"))).toBe(true);
    expect(report.errors.some((e) => e.includes("SMS down"))).toBe(true);
    // dinner-1's batch failed, so it's retried next tick; dinner-2's went out.
    expect(report.sends).toBe(2);
    expect(t.stateStore.state.done.some((k) => k.startsWith("dinner-1:nudge"))).toBe(false);
    expect(t.stateStore.state.done.filter((k) => k.startsWith("dinner-2:nudge"))).toHaveLength(2);
    expect(t.runner.health().lastError).toContain("SMS down");
  });

  it("never overlaps ticks or Fo calls", async () => {
    const t = await setup([quiet()]);
    let release!: () => void;
    t.brain.impl = () => new Promise((resolve) => (release = () => resolve({ summary: "ok", toolCalls: [] })));
    t.inbox.push([text(MAYA, "A")]);

    const first = t.runner.tick();
    await new Promise((r) => setTimeout(r, 0));
    const second = await t.runner.tick();
    expect(second.skipped).toBe(true);
    release();
    const done = await first;
    expect(done.skipped).toBe(false);
    expect(done.routed).toBe(1);
    expect(t.fo.maxInFlight).toBeLessThanOrEqual(1);
  });

  it("waits for Fo when a turn is still working, instead of piling on", async () => {
    const overdue = dinner({
      id: "dinner-2",
      replyDeadline: "2026-10-17T18:00:00.000Z",
      people: dinner().people.map((p) => ({ ...p, phone: p.phone.replace("555000", "555100") })),
    });
    const t = await setup([dinner(), overdue]);
    t.fo.reply = () => ({ status: "working", progress: "Working for 15m" });
    await t.runner.tick();
    // Sends count as done (Fo keeps going on its own), but the trigger waits for the next tick.
    expect(t.stateStore.state.done.filter((k) => k.includes(":nudge:"))).toHaveLength(2);
    expect(t.brain.calls).toEqual([]);
    t.fo.reply = () => ({ status: "complete", response: "Sent" });
    await t.runner.tick();
    expect(t.brain.calls.map((c) => c.trigger.kind)).toEqual(["deadline"]);
  });
});
