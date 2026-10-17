import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { SandboxBus } from "../events.js";
import { runEdgeCase, runSuite, type EdgeCaseResult } from "./harness.js";
import type { CaseHistory, EdgeCase, SeedContext } from "./types.js";

// ---------- a real Anthropic client over a scripted fetch: no network ----------

type Body = Record<string, any>;
type Step = { status?: number; body: unknown };

let n = 0;
const message = (content: unknown[], stop_reason: string): Step => ({
  body: {
    id: `msg_${++n}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});
const call = (name: string, input: unknown) => ({ type: "tool_use", id: `toolu_${++n}`, name, input });
const done = () => message([{ type: "text", text: "done" }], "end_turn");

interface Wake {
  /** Person id who texted, or undefined for a timer. */
  from?: string;
  text: string;
  /** 0 for the first request of a run, then 1, 2, ... */
  turn: number;
}

const PHONE_TO_ID: Record<string, string> = {
  "+13035550100": "pranav",
  "+13035550101": "maya",
  "+13035550102": "jordan",
  "+13035550103": "sam",
  "+13035550104": "priya",
  "+13035550105": "alex",
};

/** `step` returns the tool calls for this turn, or nothing to end the run. */
function scriptedFo(step: (w: Wake) => unknown[] | undefined) {
  const requests: Body[] = [];
  const fetchImpl = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Body;
    requests.push(body);
    const first = String(body.messages[0].content);
    const phone = /Trigger: a text to you from \w+ \((\+\d+)\)/.exec(first)?.[1];
    const text = phone
      ? /<untrusted_text from="[^"]*">\n([\s\S]*?)\n<\/untrusted_text>/.exec(first)![1]!
      : (/<scheduled_note>([\s\S]*?)<\/scheduled_note>/.exec(first)?.[1] ?? "");
    const turn = (body.messages.length - 1) / 2;
    const calls = step({ ...(phone ? { from: PHONE_TO_ID[phone] } : {}), text, turn });
    const res = calls?.length ? message(calls, "tool_use") : done();
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const client = new Anthropic({ apiKey: "test-key", fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });
  return { client, requests };
}

// ---------- a toy case seeded to voting ----------

const NOW = new Date("2026-10-14T12:00:00Z");
const MAYA = "+13035550101";

async function seedVoting(ctx: SeedContext): Promise<{ eventId: string }> {
  const org = ctx.people.find((p) => p.isOrganizer)!;
  const friends = ctx.people.filter((p) => !p.isOrganizer);
  const day = (d: number) => new Date(ctx.now().getTime() + d * 86_400_000).toISOString();
  const created = await ctx.service.createEvent({
    title: "Saturday dinner",
    organizer: { name: org.name, phone: org.phone, venmo: "pranav-sandbox" },
    friends: friends.map((f) => ({ name: f.name, phone: f.phone })),
    time_slots: [
      { label: "Fri 7pm", starts_at: day(2) },
      { label: "Sat 7pm", starts_at: day(3) },
    ],
  });
  const eventId = created.event_id as string;
  for (const f of friends) await ctx.service.recordPreferences({ event_id: eventId, person: f.id, slot_ids: ["B"] });
  ctx.advanceMinutes(30);
  await ctx.service.pickTime({ event_id: eventId, force: true });
  await ctx.service.setRestaurantOptions({
    event_id: eventId,
    options: [{ name: "Trattoria Uno" }, { name: "Osteria Due" }, { name: "Tavola Tre" }],
  });
  return { eventId };
}

function toyCase(over: Partial<EdgeCase> = {}): EdgeCase {
  return {
    id: "toy-vote",
    title: "Maya votes",
    area: "voting",
    planRef: "toy",
    critical: true,
    seed: seedVoting,
    inbound: [{ from: "maya", text: "2 please" }],
    checks: [],
    ...over,
  };
}

/** The usual Fo: record the vote, thank them, stop. */
function votingFo(eventId: () => string) {
  return scriptedFo((w) => {
    if (w.turn === 0 && w.from) return [call("record_vote", { event_id: eventId(), person: w.from, option: w.text.match(/\d/)?.[0] ?? "1" })];
    if (w.turn === 1 && w.from) return [call("send_text", { to_phone: Object.entries(PHONE_TO_ID).find(([, id]) => id === w.from)![0], text: "Got your vote!" })];
    return undefined;
  });
}

const run = (c: EdgeCase, client: Anthropic) => runEdgeCase(c, { anthropic: client, bus: new SandboxBus(), now: NOW, retryDelaysMs: [0, 0, 0] });

describe("runEdgeCase", () => {
  it("seeds to voting, delivers the text, and passes checks on the outcome", async () => {
    let eventId = "";
    const seed = async (ctx: SeedContext) => {
      const r = await seedVoting(ctx);
      eventId = r.eventId;
      return r;
    };
    const { client, requests } = votingFo(() => eventId);
    const result = await run(
      toyCase({
        seed,
        checks: [
          {
            description: "Maya's vote is recorded for option 2",
            test: (h) => (h.finalEvent.votes.some((v) => v.personId === "maya" && v.restaurantId === "2") ? true : `votes: ${JSON.stringify(h.finalEvent.votes)}`),
          },
          { description: "Fo thanked Maya", test: (h) => (h.textsTo("maya").length === 1 ? true : `texts: ${h.textsTo("maya").length}`) },
          {
            description: "record_vote ran in Maya's run",
            test: (h) => (h.toolCalls.some((t) => t.name === "record_vote" && t.ok && t.triggeredBy === "maya") ? true : "no record_vote from maya"),
          },
        ],
      }),
      client,
    );
    expect(result.checks).toEqual([
      { description: "Maya's vote is recorded for option 2", passed: true },
      { description: "Fo thanked Maya", passed: true },
      { description: "record_vote ran in Maya's run", passed: true },
    ]);
    expect(result.passed).toBe(true);
    expect(result.runs).toBe(1);
    expect(requests).toHaveLength(3);
    // Same system prompt and tools as the full sandbox, and by_phone isn't injected anywhere.
    expect(requests[0]!.system[0].text).toMatch(/^You are Fo, a texting assistant/);
    expect(requests[0]!.tools.map((t: Body) => t.name)).toEqual(expect.arrayContaining(["record_vote", "send_text", "schedule_action", "call_restaurant", "read_receipt_photo", "web_search"]));
    expect(requests[0]!.messages[0].content).toContain('<untrusted_text from="Maya (+13035550101)">\n2 please\n</untrusted_text>');
    expect(result.usage.requests).toBe(3);
    expect(result.estimatedUsd).toBeGreaterThan(0);
    const types = result.history.map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(result.history).toContainEqual(expect.objectContaining({ type: "stage", stage: "voting" }));
    expect(types.at(-1)).toBe("run_finished");
  });

  it("reports a failing check with its detail, and a throwing check as a failure", async () => {
    const { client } = scriptedFo(() => undefined);
    const result = await run(
      toyCase({
        checks: [
          { description: "Fo texted Maya", test: (h) => (h.textsTo("maya").length > 0 ? true : "Fo never texted Maya") },
          {
            description: "explodes",
            test: () => {
              throw new Error("kaboom");
            },
          },
          { description: "still voting", test: (h) => (h.finalEvent.stage === "voting" ? true : h.finalEvent.stage) },
        ],
      }),
      client,
    );
    expect(result.passed).toBe(false);
    expect(result.checks).toEqual([
      { description: "Fo texted Maya", passed: false, detail: "Fo never texted Maya" },
      { description: "explodes", passed: false, detail: "check threw: kaboom" },
      { description: "still voting", passed: true },
    ]);
    expect(result.history.some((e) => e.type === "note" && e.text === "CHECK FAIL: Fo texted Maya (Fo never texted Maya)")).toBe(true);
  });

  it("stops at maxRuns", async () => {
    const { client, requests } = scriptedFo(() => undefined);
    const result = await run(
      toyCase({
        maxRuns: 2,
        inbound: [
          { from: "maya", text: "one" },
          { from: "jordan", text: "two", afterMinutes: 5 },
          { from: "sam", text: "three", afterMinutes: 5 },
        ],
      }),
      client,
    );
    expect(result.runs).toBe(2);
    expect(requests).toHaveLength(2);
    expect(result.stopReason).toContain("2-run cap");
    expect(result.history.filter((e) => e.type === "text" && e.to === "fo").map((e) => (e as { text: string }).text)).toEqual(["one", "two"]);
  });

  it("fires each reply rule once, first match in order, after its delay", async () => {
    const { client } = scriptedFo((w) => {
      if (w.turn > 0) return undefined;
      if (w.from === "pranav") return [call("send_text", { to_phone: MAYA, text: "Please vote: 1, 2 or 3" })];
      if (w.from === "maya" && w.text === "1") return [call("send_text", { to_phone: MAYA, text: "Can you vote again?" })];
      if (w.from === "maya" && w.text === "actually 3") return [call("send_text", { to_phone: MAYA, text: "Vote noted, thanks" })];
      return undefined;
    });
    let seen: CaseHistory | undefined;
    const result = await run(
      toyCase({
        inbound: [{ from: "pranav", text: "Remind Maya to vote", afterMinutes: 2 }],
        replies: [
          { to: "maya", when: /vote/i, reply: "1", afterMinutes: 10 },
          { to: "jordan", when: /vote/i, reply: "never sent" },
          { to: "maya", when: /vote/i, reply: "actually 3" },
        ],
        checks: [{ description: "capture", test: (h) => ((seen = h), true) }],
      }),
      client,
    );
    const inbound = result.history.flatMap((e) => (e.type === "text" && e.to === "fo" ? [{ from: e.from, text: e.text, at: e.at }] : []));
    expect(inbound.map((t) => `${t.from}: ${t.text}`)).toEqual(["pranav: Remind Maya to vote", "maya: 1", "maya: actually 3"]);
    expect(Date.parse(inbound[1]!.at) - Date.parse(inbound[0]!.at)).toBe(10 * 60_000);
    expect(Date.parse(inbound[2]!.at) - Date.parse(inbound[1]!.at)).toBe(60_000);
    expect(result.runs).toBe(3);
    expect(seen!.textsTo("maya")).toEqual(["Please vote: 1, 2 or 3", "Can you vote again?", "Vote noted, thanks"]);
    expect(seen!.allTexts()).toHaveLength(3);
  });

  it("uses the case's restaurant call and receipt stubs", async () => {
    const { client } = scriptedFo((w) => {
      if (w.turn === 0) return [call("call_restaurant", { restaurant: "Trattoria Uno", request: "Table for 6 Sat 7pm" }), call("read_receipt_photo", {})];
      return undefined;
    });
    let seen: CaseHistory | undefined;
    await run(
      toyCase({
        inbound: [{ from: "pranav", text: "Book Trattoria Uno" }],
        stubs: {
          callRestaurant: (restaurant, request) => `Fully booked at 7pm (${restaurant}; asked: ${request}).`,
          receiptText: "1. Soup $5\nTotal $5",
        },
        checks: [{ description: "capture", test: (h) => ((seen = h), true) }],
      }),
      client,
    );
    const callRec = seen!.toolCalls.find((t) => t.name === "call_restaurant")!;
    expect(callRec).toMatchObject({ ok: true, triggeredBy: "pranav", result: { outcome: "Fully booked at 7pm (Trattoria Uno; asked: Table for 6 Sat 7pm)." } });
    expect(seen!.toolCalls.find((t) => t.name === "read_receipt_photo")).toMatchObject({ ok: true, result: { lines: "1. Soup $5\nTotal $5" } });
    expect(seen!.stubbed).toEqual([{ action: "call_restaurant", detail: "Trattoria Uno: Table for 6 Sat 7pm -> Fully booked at 7pm (Trattoria Uno; asked: Table for 6 Sat 7pm)." }]);
  });

  it("lets Fo's timers fire, records them as triggeredBy timer, and counts duplicate timers", async () => {
    let eventId = "";
    const { client } = scriptedFo((w) => {
      if (w.turn > 0) return undefined;
      if (w.from) {
        return [
          call("schedule_action", { run_at: "2026-10-23T12:00:00-06:00", description: "vote deadline" }),
          call("schedule_action", { run_at: "2026-10-23T12:02:00-06:00", description: "vote deadline again" }),
        ];
      }
      return [call("tally_votes", { event_id: eventId, force: true })];
    });
    let seen: CaseHistory | undefined;
    const result = await run(
      toyCase({
        seed: async (ctx) => {
          const r = await seedVoting(ctx);
          eventId = r.eventId;
          return r;
        },
        checks: [{ description: "capture", test: (h) => ((seen = h), true) }],
      }),
      client,
    );
    expect(result.duplicateTimers).toBe(1);
    expect(seen!.duplicateTimers).toHaveLength(1);
    expect(result.runs).toBe(3);
    expect(seen!.toolCalls.filter((t) => t.name === "tally_votes").map((t) => t.triggeredBy)).toEqual(["timer", "timer"]);
    expect(result.stopReason).toBe("Done: nothing left pending.");
  });

  it("fails cleanly when seeding throws or the case names an unknown person", async () => {
    const { client, requests } = scriptedFo(() => undefined);
    const bad = await run(
      toyCase({
        seed: async () => {
          throw new Error("no such stage");
        },
      }),
      client,
    );
    expect(bad).toMatchObject({ passed: false, runs: 0, checks: [{ description: "Seed the dinner", passed: false, detail: "no such stage" }] });
    const unknown = await run(toyCase({ inbound: [{ from: "zed", text: "hi" }] }), client);
    expect(unknown.checks[0]).toMatchObject({ passed: false, detail: "Unknown person id(s): zed" });
    expect(requests).toHaveLength(0);
  });

  it("fails the case when the API keeps failing", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
    const client = new Anthropic({ apiKey: "test-key", fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });
    const result = await run(toyCase({ checks: [{ description: "trivially true", test: () => true }] }), client);
    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({ description: "Coordinator ran without an API error", passed: false });
    expect(result.stopReason).toMatch(/^Stopped on an error/);
  });
});

// ---------- the suite runner ----------

function fakeResult(c: EdgeCase, usd: number): EdgeCaseResult {
  return {
    id: c.id,
    title: c.title,
    area: c.area,
    planRef: c.planRef,
    critical: c.critical,
    passed: true,
    checks: [],
    runs: 1,
    usage: { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, webSearches: 0, requests: 1 },
    estimatedUsd: usd,
    history: [],
    stopReason: "Done",
    duplicateTimers: 0,
    auditFlags: [],
  };
}

describe("runSuite", () => {
  const cases = ["a", "b", "c", "d", "e"].map((id) => toyCase({ id }));

  it("stops starting cases once the finished ones cost the cap, and reports the rest as skipped", async () => {
    const started: string[] = [];
    const suite = await runSuite(cases, {
      concurrency: 1,
      maxUsd: 15,
      runCase: async (c) => {
        started.push(c.id);
        return fakeResult(c, 10);
      },
    });
    expect(started).toEqual(["a", "b"]);
    expect(suite.results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(suite.skipped.map((c) => c.id)).toEqual(["c", "d", "e"]);
    expect(suite.totalUsd).toBe(20);
  });

  it("bounds concurrency, keeps the given order, and turns a crash into a failed result", async () => {
    let inFlight = 0;
    let peak = 0;
    const progress: number[] = [];
    const suite = await runSuite(cases, {
      concurrency: 2,
      maxUsd: 100,
      runCase: async (c) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, c.id === "a" ? 20 : 1));
        inFlight--;
        if (c.id === "c") throw new Error("crashed");
        return fakeResult(c, 1);
      },
      onResult: (_r, p) => progress.push(p.done),
    });
    expect(peak).toBe(2);
    expect(suite.results.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(suite.results[2]).toMatchObject({ passed: false, checks: [{ detail: "crashed" }] });
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect(suite.skipped).toEqual([]);
  });
});
