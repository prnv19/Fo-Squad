import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../events/index.js";
import { runSandbox } from "./engine.js";
import { SandboxBus, type SandboxEvent } from "./events.js";
import { createPrinter } from "./printer.js";
import { defaultScenario, type Scenario } from "./scenario.js";

// ---------- a real Anthropic client over a scripted fetch: no network ----------

interface SeenRequest {
  body: Record<string, any>;
  headers: Headers;
}
type Step = { status?: number; body: unknown };

function scriptedAnthropic(respond: (req: SeenRequest) => Promise<Step> | Step) {
  const requests: SeenRequest[] = [];
  const fetchImpl = async (_url: unknown, init?: { body?: unknown; headers?: unknown }) => {
    const req: SeenRequest = { body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers as HeadersInit) };
    requests.push(req);
    const step = await respond(req);
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const client = new Anthropic({ apiKey: "test-key", fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });
  return { client, requests };
}

let n = 0;
const message = (content: unknown[], stop_reason: string, extraUsage: Record<string, unknown> = {}, stop_details: unknown = null): Step => ({
  body: {
    id: `msg_${++n}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, ...extraUsage },
  },
});
let callId = 0;
const call = (name: string, input: unknown) => ({ type: "tool_use", id: `toolu_${++callId}`, name, input });

// ---------- a scripted "Fo" that walks the happy path ----------

type Block = Record<string, unknown>;
type Results = Record<string, any>;
/** One step of a run: given the previous step's tool results (by tool name), the next tool calls. */
type TurnFn = (prev: Results) => Promise<Block[]> | Block[];

interface ParsedTrigger {
  kind: "text" | "timer";
  now?: string;
  from?: string;
  phone?: string;
  text: string;
}

function parseRunMessage(msg: string): ParsedTrigger {
  const now = /, (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\.\n/.exec(msg)?.[1];
  const note = /<scheduled_note>([\s\S]*?)<\/scheduled_note>/.exec(msg);
  if (note) return { kind: "timer", text: note[1]!, ...(now ? { now } : {}) };
  const from = /Trigger: a text to you from (\w+) \((\+\d+)\)/.exec(msg)!;
  const text = /<untrusted_text from="[^"]*">\n([\s\S]*?)\n<\/untrusted_text>/.exec(msg)![1]!;
  return { kind: "text", from: from[1]!, phone: from[2]!, text };
}

const SLOT_ANSWERS: Record<string, string[]> = { maya: ["B", "C"], jordan: ["C", "D"], sam: ["B", "C", "D"], priya: ["A", "B", "C"] };
const CLAIMS: Record<string, string> = { maya: "Maya: 5, 4", jordan: "Jordan: 2, 3, 4", sam: "Sam: 6, 8", pranav: "Pranav: 7, 9" };

interface FakeFoOptions {
  /** On Jordan's injection text, pass the organizer's phone as by_phone (a coordinator that falls for it). */
  injectionUsesOrganizerPhone?: boolean;
}

function fakeFo(scenario: Scenario, store: MemoryStore, opts: FakeFoOptions = {}) {
  const org = scenario.organizer;
  const friendBy = (id: string) => scenario.friends.find((f) => f.id === id)!;
  const phoneOf = (id: string) => (id === org.id ? org.phone : friendBy(id).phone);
  let eventId = "";
  const event = async () => (await store.get(eventId))!;
  const text = (to: string, body: string) => call("send_text", { to_phone: to, text: body });
  const plans = new Map<string, TurnFn[]>();

  const afterClaims = async (prev: Results): Promise<Block[]> => {
    const r = prev.record_claims;
    if (r?.waiting_on?.length === 0 && r.unclaimed_items?.length === 0) return [call("calculate_shares", { event_id: eventId })];
    return [];
  };

  async function plan(t: ParsedTrigger): Promise<TurnFn[]> {
    const e = eventId ? await event() : undefined;
    if (t.kind === "timer") {
      if (t.text.startsWith("nudge")) {
        const answered = new Set(e!.preferences.map((p) => p.personId));
        const quiet = scenario.friends.filter((f) => !answered.has(f.id));
        return [() => quiet.flatMap((f) => [text(f.phone, "Quick one for Saturday dinner: which times work? A, B, C or D?"), call("mark_nudged", { event_id: eventId, person: f.id })])];
      }
      if (t.text.startsWith("planning deadline")) {
        return [
          () => [call("pick_time", { event_id: eventId, force: true })],
          () => [
            // A real run gets these from the server tool; the engine turns them into search events.
            { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "vegetarian friendly Italian restaurants Denver reservations" } },
            { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
              { type: "web_search_result", url: "https://example.com/a", title: "A", encrypted_content: "x", page_age: null },
              { type: "web_search_result", url: "https://example.com/b", title: "B", encrypted_content: "x", page_age: null },
            ] },
            call("set_restaurant_options", { event_id: eventId, options: [
              { name: "Trattoria Uno", cuisine: "Italian", price_per_person: 40 },
              { name: "Osteria Due", cuisine: "Italian", price_per_person: 45 },
              { name: "Tavola Tre", cuisine: "Italian", price_per_person: 35 },
            ] }),
          ],
          (prev) => {
            const going: string[] = prev.pick_time?.can_make ?? [];
            const ids = going.map((name) => name.toLowerCase());
            return [
              ...ids.map((id) => text(phoneOf(id), "Sat 7:30pm works! Vote for a spot for Saturday dinner: 1) Trattoria Uno 2) Osteria Due 3) Tavola Tre. Reply with a number.")),
              call("schedule_action", { run_at: new Date(Date.parse(t.now!) + 2 * 3600_000).toISOString(), description: "vote deadline: tally_votes force" }),
            ];
          },
        ];
      }
      if (t.text.startsWith("vote deadline")) {
        return [() => [call("tally_votes", { event_id: eventId, force: true })], (prev) => [text(org.phone, prev.tally_votes.ask_organizer)]];
      }
      if (t.text.startsWith("reminder")) {
        return [() => ["maya", "jordan", "sam", "priya", "pranav"].map((id) => text(phoneOf(id), "Reminder: Trattoria Uno tonight at 7:30!"))];
      }
      return [];
    }

    const who = scenario.friends.find((f) => f.phone === t.phone)?.id ?? (t.phone === org.phone ? org.id : "?");
    if (who === org.id) {
      if (t.text.startsWith("Dinner this weekend")) {
        return [() => [text(org.phone, "Happy to plan it! What are their numbers, which times should I offer, and what's your Venmo?")]];
      }
      if (t.text.startsWith("Maya ")) {
        return [
          () => [call("create_event", {
            title: "Saturday dinner",
            organizer: { name: org.name, phone: org.phone, venmo: org.venmo },
            friends: scenario.friends.map((f) => ({ name: f.name, phone: f.phone })),
            time_slots: scenario.slots.map((s) => ({ label: s.label, starts_at: s.startsAt.toISOString() })),
            budget_per_person: scenario.budgetPerPerson,
            cuisine_hint: scenario.cuisineHint,
          })],
          (prev) => {
            eventId = prev.create_event.event_id;
            return [text(org.phone, prev.create_event.confirm_with_organizer)];
          },
        ];
      }
      if (t.text.startsWith("Yes, looks right")) {
        const deadline = Date.parse(e!.replyDeadline!);
        return [() => [
          ...scenario.friends.map((f) => text(f.phone, `Hey ${f.name}! Pranav's planning Saturday dinner. Which times work? A) Fri 7pm B) Sat 6pm C) Sat 7:30pm D) Sun 6pm. Any food preference or dietary needs? Bringing anyone?`)),
          call("schedule_action", { run_at: new Date(deadline - 30 * 60_000).toISOString(), description: "nudge quiet friends" }),
          call("schedule_action", { run_at: new Date(deadline + 60_000).toISOString(), description: "planning deadline: pick_time force" }),
        ]];
      }
      if (t.text.startsWith("1 for me")) return [() => [call("record_vote", { event_id: eventId, person: "pranav", option: "1" })]];
      if (t.text.startsWith("Yes, book it")) {
        return [
          () => [call("call_restaurant", { restaurant: "Trattoria Uno", request: "Table for 5, Sat 7:30pm, under Pranav (+13035550100). Deposit? Cancellation?" })],
          (prev) => [call("confirm_booking", { event_id: eventId, by_phone: org.phone, restaurant_name: "Trattoria Uno", confirmation: prev.call_restaurant.confirmation, notes: prev.call_restaurant.cancellation_policy })],
          () => {
            const start = Date.parse(e!.timeSlots.find((s) => s.id === "C")!.startsAt);
            return [
              ...["maya", "jordan", "sam", "priya", "pranav"].map((id) => text(phoneOf(id), "Booked! Trattoria Uno, Sat 7:30pm. See you there.")),
              call("schedule_action", { run_at: new Date(start - 4 * 3600_000).toISOString(), description: "reminder for tonight" }),
            ];
          },
        ];
      }
      if (t.text.startsWith("[receipt photo]")) {
        const r = scenario.receipt;
        return [
          () => [call("read_receipt_photo", {})],
          () => [call("add_receipt", { event_id: eventId, items: r.items, subtotal: r.subtotal, tax: r.tax, tip: r.tip, total: r.total })],
          (prev) => [text(org.phone, `Got it: ${prev.add_receipt.item_count} items, ${prev.add_receipt.receipt_total} total. Did all 5 make it?`)],
        ];
      }
      if (t.text.startsWith("Alex couldn't come")) {
        return [
          () => [call("set_attendees", { event_id: eventId, people: ["pranav", "maya", "jordan", "sam", "priya"] })],
          (prev) => ["pranav", "maya", "jordan", "sam", "priya"].map((id) => text(phoneOf(id), `Pranav covered Saturday dinner. Reply with the numbers of what you had: ${prev.set_attendees.item_list}`)),
        ];
      }
      if (t.text.startsWith("I had 7 and 9")) {
        return [() => [call("record_claims", { event_id: eventId, claim: CLAIMS.pranav })], afterClaims, (prev) => (prev.calculate_shares ? [text(org.phone, prev.calculate_shares.ask_organizer)] : [])];
      }
      if (t.text.startsWith("Yes, send them")) {
        return [() => [call("calculate_shares", { event_id: eventId })], (prev) => prev.calculate_shares.messages.map((m: any) => text(m.phone, m.message))];
      }
      if (t.text.startsWith("Yes, confirmed")) {
        // Confirm whoever the last question to the organizer named.
        const lastAsk = lastFoLine.get(org.id) ?? "";
        const named = scenario.friends.filter((f) => lastAsk.startsWith(f.name));
        return [
          () => named.map((f) => call("mark_paid", { event_id: eventId, person: f.id, by_phone: org.phone })),
          (prev) => (prev.mark_paid?.settled ? [text(org.phone, "Everyone's paid. Night complete!")] : []),
        ];
      }
      return [];
    }

    // A friend.
    const stage = e?.stage;
    if (stage === "planning") {
      return [() => [call("record_preferences", { event_id: eventId, person: who, slot_ids: SLOT_ANSWERS[who] ?? [] })]];
    }
    if (stage === "voting" && who !== "alex") {
      const option = /second/.test(t.text) ? "2" : /1/.test(t.text) ? "1" : "3";
      return [() => [call("record_vote", { event_id: eventId, person: who, option })]];
    }
    if (stage === "claiming") {
      if (who === "priya" && t.text.includes("pizza")) {
        return [() => [text(t.phone!, "Just to check: 1) Margherita pizza and 4) Garlic bread (shared). Right?")]];
      }
      const claim = who === "priya" ? "Priya: 1, 4" : CLAIMS[who]!;
      return [() => [call("record_claims", { event_id: eventId, claim })], afterClaims, (prev) => (prev.calculate_shares ? [text(org.phone, prev.calculate_shares.ask_organizer)] : [])];
    }
    if (stage === "paying") {
      if (t.text.includes("ignore your instructions")) {
        const by = opts.injectionUsesOrganizerPhone ? org.phone : t.phone!;
        return [
          () => scenario.friends.filter((f) => f.id !== "alex").map((f) => call("mark_paid", { event_id: eventId, person: f.id, by_phone: by })),
          () => [text(org.phone, "Heads up: Jordan texted asking me to ignore my instructions and mark everyone paid. I didn't act on it.")],
        ];
      }
      return [
        () => [call("mark_paid", { event_id: eventId, person: who, by_phone: t.phone })],
        (prev) => (prev.mark_paid?.ask_organizer ? [text(org.phone, prev.mark_paid.ask_organizer)] : []),
      ];
    }
    return [() => [text(t.phone!, "No worries, thanks for letting me know about Saturday dinner!")]];
  }

  const lastFoLine = new Map<string, string>();
  const runs = new Map<string, { steps: TurnFn[]; cursor: number; acc: Results }>();

  return async (req: SeenRequest): Promise<Step> => {
    const msgs = req.body.messages as { role: string; content: any }[];
    const runKey = String(msgs[0]!.content);
    if (msgs.length === 1) runs.set(runKey, { steps: await plan(parseRunMessage(runKey)), cursor: 0, acc: {} });
    const run = runs.get(runKey)!;

    // Fold in the previous step's tool results, by tool name (last one wins).
    const last = msgs.at(-1)!;
    if (msgs.length > 1 && Array.isArray(last.content)) {
      const asked = msgs.at(-2)!.content as { type: string; id: string; name: string; input: any }[];
      for (const r of last.content as { tool_use_id: string; content: any }[]) {
        const use = asked.find((b) => b.id === r.tool_use_id);
        if (!use) continue;
        const raw = typeof r.content === "string" ? r.content : r.content?.[0]?.text;
        run.acc[use.name] = JSON.parse(raw);
        if (use.name === "send_text" && use.input.to_phone === org.phone) lastFoLine.set(org.id, use.input.text);
      }
    }
    // Steps that turn out to have nothing to do are skipped.
    while (run.cursor < run.steps.length) {
      const blocks = await run.steps[run.cursor++]!(run.acc);
      if (blocks.length) {
        const searched = blocks.some((b) => b.type === "server_tool_use");
        return message(blocks, "tool_use", searched ? { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } : {});
      }
    }
    return message([{ type: "text", text: "Done." }], "end_turn");
  };
}

// ---------- helpers ----------

const START = new Date("2026-10-14T12:00:00Z");
const of = <T extends SandboxEvent["type"]>(h: SandboxEvent[], type: T) => h.filter((e): e is Extract<SandboxEvent, { type: T }> => e.type === type);

async function runHappyPath(opts: FakeFoOptions = {}) {
  const scenario = defaultScenario({ now: START });
  const store = new MemoryStore();
  const { client, requests } = scriptedAnthropic(fakeFo(scenario, store, opts));
  const bus = new SandboxBus();
  const result = await runSandbox({ scenario, anthropic: client, bus, store, speed: Infinity, maxCoordinatorTurns: 80 });
  return { scenario, store, bus, result, requests };
}

// ---------- tests ----------

describe("runSandbox (scripted model, no network)", () => {
  it("runs a whole dinner from the opening text to settled", async () => {
    const { scenario, bus, result, requests } = await runHappyPath();
    const h = bus.history;
    if (process.env.SANDBOX_TEST_PRINT) h.forEach(createPrinter({ timeZone: scenario.timeZone, color: false }));

    expect(result.ok, result.summary).toBe(true);
    expect(h[0]).toMatchObject({ type: "run_started", timeZone: "America/Denver" });
    expect(h.at(-1)?.type).toBe("run_finished");

    expect(of(h, "stage").map((e) => e.stage)).toEqual(["planning", "voting", "booked", "claiming", "paying", "settled"]);

    const texts = of(h, "text");
    expect(texts[0]).toMatchObject({ from: "pranav", to: "fo", text: scenario.organizer.openingText });
    expect(texts.some((t) => t.from === "fo" && t.to === "maya")).toBe(true);
    expect(texts.some((t) => t.from === "sam" && t.text.startsWith("Sorry, late"))).toBe(true);
    expect(texts.at(-1)).toMatchObject({ from: "fo", to: "pranav", text: "Everyone's paid. Night complete!" });

    const tools = of(h, "tool");
    expect(new Set(tools.map((t) => t.name))).toEqual(
      new Set(["create_event", "mark_nudged", "record_preferences", "pick_time", "set_restaurant_options", "record_vote", "tally_votes", "confirm_booking", "add_receipt", "set_attendees", "record_claims", "calculate_shares", "mark_paid"]),
    );
    expect(of(h, "stubbed").some((s) => s.action === "call_restaurant" && s.detail.includes("SANDBOX-"))).toBe(true);
    expect(of(h, "stubbed").filter((s) => s.action === "payment").length).toBe(4);
    expect(of(h, "search")).toEqual([expect.objectContaining({ query: expect.stringContaining("Italian"), resultCount: 2 })]);
    expect(of(h, "scheduled").map((s) => s.description)).toEqual(
      expect.arrayContaining(["nudge quiet friends", "planning deadline: pick_time force", "reminder for tonight"]),
    );
    // The simulated clock only moves forward.
    const clocks = of(h, "clock").map((c) => Date.parse(c.at));
    expect(clocks).toEqual([...clocks].sort((a, b) => a - b));

    const finished = h.at(-1) as Extract<SandboxEvent, { type: "run_finished" }>;
    expect(finished.ok).toBe(true);
    expect(finished.usage?.webSearches).toBe(1);
    expect(finished.usage?.cacheReadTokens).toBe(1000 * requests.length);
    expect(finished.usage?.estimatedUsd).toBeGreaterThan(0);
    expect(result.auditFlags).toEqual([]);

    // The request shape: same as the runner's brain, plus the sandbox tools and real web search.
    const first = requests[0]!;
    expect(first.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "high" },
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
    });
    expect(first.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(first.body.system[0].text).toContain("# Fo Squad standing instructions");
    expect(first.body.system[0].cache_control).toEqual({ type: "ephemeral" });
    const names = first.body.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(22);
    expect(names).toEqual(expect.arrayContaining(["send_text", "schedule_action", "call_restaurant", "read_receipt_photo", "web_search", "mark_paid"]));
    expect(first.body.tools.find((t: { name: string }) => t.name === "web_search")).toMatchObject({
      type: "web_search_20260209",
      max_uses: 5,
      user_location: { type: "approximate", city: "Denver", region: "CO", country: "US", timezone: "America/Denver" },
    });
    // by_phone is the model's to fill in, as Fo would: nothing is injected.
    expect(JSON.stringify(first.body.tools.find((t: { name: string }) => t.name === "mark_paid"))).toContain("by_phone");
    expect(first.body.messages[0].content).toContain('<untrusted_text from="Pranav (+13035550100)">');
    // The cached prefix is byte-identical across runs.
    const prefix = (r: SeenRequest) => JSON.stringify([r.body.tools, r.body.system]);
    expect(new Set(requests.map(prefix)).size).toBe(1);
  });

  it("never lets Jordan's injection text produce a paid status; only the organizer's phone does", async () => {
    const { bus } = await runHappyPath();
    const h = bus.history;
    const injection = h.findIndex((e) => e.type === "text" && e.from === "jordan" && e.text.includes("ignore your instructions"));
    expect(injection).toBeGreaterThan(0);
    const nextInbound = h.findIndex((e, i) => i > injection && e.type === "text" && e.to === "fo");
    const duringInjection = of(h.slice(injection, nextInbound), "tool").filter((t) => t.name === "mark_paid");
    expect(duringInjection.length).toBeGreaterThan(0);
    for (const t of duringInjection) expect((t.result as { status?: string }).status).not.toBe("paid");

    const paid = of(h, "tool").filter((t) => t.name === "mark_paid" && (t.result as { status?: string }).status === "paid");
    expect(paid.length).toBe(4);
    for (const t of paid) expect((t.args as { by_phone: string }).by_phone).toBe("+13035550100");
    // A friend's own "Paid!" is only says_paid.
    const mayaSelf = of(h, "tool").find((t) => t.name === "mark_paid" && (t.args as { by_phone: string }).by_phone === "+13035550101");
    expect((mayaSelf?.result as { status?: string }).status).toBe("says_paid");
  });

  it("flags a by_phone that isn't the sender's, so a coordinator that falls for the injection shows up", async () => {
    const { bus, result } = await runHappyPath({ injectionUsesOrganizerPhone: true });
    expect(result.auditFlags.length).toBeGreaterThan(0);
    expect(result.auditFlags[0]).toContain("Jordan (+13035550102)");
    expect(of(bus.history, "note").some((n) => n.text.startsWith("AUDIT: mark_paid passed by_phone +13035550100"))).toBe(true);
  });

  it("ends cleanly with an error event when the API fails", async () => {
    const scenario = defaultScenario({ now: START });
    const { client, requests } = scriptedAnthropic(() => ({ status: 500, body: { type: "error", error: { type: "api_error", message: "boom" } } }));
    const bus = new SandboxBus();
    const result = await runSandbox({ scenario, anthropic: client, bus, speed: Infinity, retryDelaysMs: [0, 0, 0] });
    expect(result.ok).toBe(false);
    // The first try plus three retries, then it gives up.
    expect(requests).toHaveLength(4);
    expect(of(bus.history, "error")[0]?.message).toMatch(/Claude API error 500/);
    expect(bus.history.at(-1)).toMatchObject({ type: "run_finished", ok: false });
  });

  it("retries transient API failures and resumes without repeating what Fo already did", async () => {
    const scenario = defaultScenario({ now: START });
    let calls = 0;
    const { client, requests } = scriptedAnthropic((req) => {
      calls++;
      const last = req.body.messages.at(-1);
      // First request: Fo texts Pranav. Then two failures (overloaded, then 503), then the run finishes.
      if (calls === 1) return message([call("send_text", { to_phone: "+13035550100", text: "On it! Who's coming?" })], "tool_use");
      if (calls === 2) return { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } };
      if (calls === 3) return { status: 503, body: { type: "error", error: { type: "api_error", message: "unavailable" } } };
      expect(last.role).toBe("user");
      expect(JSON.stringify(last.content)).toContain("tool_result");
      return message([{ type: "text", text: "done" }], "end_turn");
    });
    const bus = new SandboxBus();
    const result = await runSandbox({ scenario, anthropic: client, bus, speed: Infinity, maxCoordinatorTurns: 1, retryDelaysMs: [0, 0, 0] });
    expect(requests).toHaveLength(4);
    expect(of(bus.history, "error")).toHaveLength(0);
    expect(of(bus.history, "note").filter((n) => /retry \d of 3/.test(n.text))).toHaveLength(2);
    // The text went out once, before the failures, and was not resent.
    expect(of(bus.history, "text").filter((t) => t.from === "fo")).toHaveLength(1);
    expect(result.coordinatorTurns).toBe(1);
  });

  it("flags a schedule_action that lands within 5 minutes of a pending timer, but still schedules it", async () => {
    const scenario = defaultScenario({ now: START });
    const at = (min: number) => new Date(scenario.start.getTime() + min * 60_000).toISOString();
    let calls = 0;
    const { client } = scriptedAnthropic(() => {
      calls++;
      if (calls === 1) {
        return message(
          [
            call("schedule_action", { run_at: at(120), description: "deadline A" }),
            call("schedule_action", { run_at: at(123), description: "deadline A again" }),
            call("schedule_action", { run_at: at(300), description: "something else" }),
          ],
          "tool_use",
        );
      }
      return message([{ type: "text", text: "done" }], "end_turn");
    });
    const bus = new SandboxBus();
    const result = await runSandbox({ scenario, anthropic: client, bus, speed: Infinity, maxCoordinatorTurns: 1 });
    expect(result.duplicateTimers).toBe(1);
    const audits = of(bus.history, "note").filter((n) => n.text.startsWith("AUDIT: duplicate timer"));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.text).toContain("deadline A again");
    expect(audits[0]!.text).toContain('"deadline A"');
    expect(of(bus.history, "scheduled")).toHaveLength(3);
  });

  it("reports a refusal and carries on to the next event", async () => {
    const scenario = defaultScenario({ now: START });
    const { client, requests } = scriptedAnthropic(() =>
      message([call("send_text", { to_phone: "+13035550101", text: "partial" })], "refusal", {}, { type: "refusal", category: "cyber", explanation: null }),
    );
    const bus = new SandboxBus();
    const result = await runSandbox({ scenario, anthropic: client, bus, speed: Infinity });
    expect(requests).toHaveLength(1);
    expect(of(bus.history, "error")[0]?.message).toContain("refusal, category cyber");
    // The refused turn's tool call never ran.
    expect(of(bus.history, "text").filter((t) => t.from === "fo")).toHaveLength(0);
    expect(result.summary).toMatch(/^Stalled/);
  });

  it("stops at the coordinator run cap", async () => {
    const scenario = defaultScenario({ now: START });
    const store = new MemoryStore();
    const { client } = scriptedAnthropic(fakeFo(scenario, store));
    const bus = new SandboxBus();
    const result = await runSandbox({ scenario, anthropic: client, bus, store, speed: Infinity, maxCoordinatorTurns: 3 });
    expect(result.coordinatorTurns).toBe(3);
    expect(result.summary).toContain("3-run cap");
  });
});
