// Runs one edge case: seed a dinner straight to the right stage (free), then
// deliver the case's texts and let Claude-as-Fo handle them with the same
// coordinator, tools and prompt as the full sandbox. Persona replies come only
// from the case's reply rules; restaurant calls and receipts can be overridden.

import type Anthropic from "@anthropic-ai/sdk";
import { MemoryStore } from "../../events/index.js";
import { FoSquadService } from "../../service.js";
import {
  buildSystemPrompt,
  createFoCoordinator,
  DEFAULT_SANDBOX_MODEL,
  defaultRestaurantReply,
  estimateCostUsd,
  readStandingInstructions,
  type SandboxBackend,
  type SandboxPerson,
  type UsageTotals,
} from "../engine.js";
import { SimClock } from "../clock.js";
import type { SandboxBus, SandboxEvent } from "../events.js";
import { defaultScenario, DUMMY_RECEIPT, receiptText } from "../scenario.js";
import type { CaseHistory, EdgeArea, EdgeCase, SeedContext, SeedPerson, ToolCallRecord } from "./types.js";

export const DEFAULT_MAX_RUNS = 8;
const DEFAULT_WALL_CLOCK_MS = 10 * 60_000;

export interface RunEdgeCaseOptions {
  /** Required for the api backend. */
  anthropic?: Anthropic;
  /** Default api. */
  backend?: SandboxBackend;
  /** One bus per case: its history becomes the case's replay. */
  bus: SandboxBus;
  model?: string;
  timeZone?: string;
  city?: string;
  /** Real-time cap for this case. Default 10 minutes. */
  wallClockBudgetMs?: number;
  maxIterationsPerRun?: number;
  /** Defaults to docs/standing-instructions.md. */
  standingInstructions?: string;
  retryDelaysMs?: readonly number[];
  /** Real "now" the simulated week is derived from (the same Wednesday 10am start as the full sandbox). */
  now?: Date;
}

export interface EdgeCheckResult {
  description: string;
  passed: boolean;
  detail?: string;
}

export interface EdgeCaseResult {
  id: string;
  title: string;
  area: EdgeArea;
  planRef: string;
  critical: boolean;
  passed: boolean;
  checks: EdgeCheckResult[];
  /** Coordinator runs used. */
  runs: number;
  usage: UsageTotals;
  estimatedUsd: number;
  history: SandboxEvent[];
  stopReason: string;
  duplicateTimers: number;
  auditFlags: string[];
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const emptyUsage = (): UsageTotals => ({ inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, webSearches: 0, requests: 0 });

let cachedInstructions: string | undefined;

export async function runEdgeCase(c: EdgeCase, opts: RunEdgeCaseOptions): Promise<EdgeCaseResult> {
  const { anthropic, backend, bus } = opts;
  const startedAt = Date.now();
  const historyStart = bus.history.length;
  const scenario = defaultScenario({
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    ...(opts.city ? { city: opts.city } : {}),
  });
  const tz = scenario.timeZone;
  const maxRuns = c.maxRuns ?? DEFAULT_MAX_RUNS;
  const budgetMs = opts.wallClockBudgetMs ?? DEFAULT_WALL_CLOCK_MS;

  const cast: SeedPerson[] = [
    { id: scenario.organizer.id, name: scenario.organizer.name, phone: scenario.organizer.phone, isOrganizer: true },
    ...scenario.friends.map((f) => ({ id: f.id, name: f.name, phone: f.phone, isOrganizer: false })),
  ];
  const people: SandboxPerson[] = cast.map((p) => ({ id: p.id, name: p.name, phone: p.phone, role: p.isOrganizer ? "organizer" : "friend" }));

  // Seeding runs before the simulated clock exists, so the service reads a plain offset until then.
  let seedMs = scenario.start.getTime();
  let clock: SimClock | undefined;
  const store = new MemoryStore();
  const service = new FoSquadService(store, () => (clock ? clock.now() : new Date(seedMs)));

  bus.emit({
    type: "run_started",
    at: new Date(seedMs).toISOString(),
    scenario: `Edge case: ${c.title}`,
    timeZone: tz,
    people: people.map((p) => ({ id: p.id, name: p.name, role: p.role })),
  });
  bus.emit({
    type: "note",
    at: new Date(seedMs).toISOString(),
    text: `Edge case ${c.id} (${c.area}${c.critical ? ", critical" : ""}; plan: ${c.planRef}). The dinner is seeded straight to this stage; restaurant calls, bookings and payments are stubbed.`,
  });

  const finish = (checks: EdgeCheckResult[], runs: number, usage: UsageTotals, stopReason: string, extra: { duplicateTimers?: number; auditFlags?: string[] } = {}): EdgeCaseResult => {
    const passed = checks.length > 0 && checks.every((k) => k.passed);
    const at = (clock ? clock.now() : new Date(seedMs)).toISOString();
    for (const k of checks) {
      bus.emit({ type: "note", at, text: `CHECK ${k.passed ? "PASS" : "FAIL"}: ${k.description}${k.detail ? ` (${clip(k.detail, 400)})` : ""}` });
    }
    const estimatedUsd = estimateCostUsd(usage);
    const failed = checks.filter((k) => !k.passed).length;
    bus.emit({
      type: "run_finished",
      at,
      ok: passed,
      summary: `${passed ? "PASS" : "FAIL"}: ${checks.length - failed}/${checks.length} checks passed. ${stopReason} ${runs} coordinator run(s).`,
      usage: {
        inputTokens: usage.inputTokens + usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        webSearches: usage.webSearches,
        estimatedUsd,
      },
    });
    return {
      id: c.id,
      title: c.title,
      area: c.area,
      planRef: c.planRef,
      critical: c.critical,
      passed,
      checks,
      runs,
      usage,
      estimatedUsd,
      history: bus.history.slice(historyStart),
      stopReason,
      duplicateTimers: extra.duplicateTimers ?? 0,
      auditFlags: extra.auditFlags ?? [],
    };
  };

  // ---------- validate and seed (no Claude yet) ----------

  const known = new Set(people.map((p) => p.id));
  const unknown = [...c.inbound.map((s) => s.from), ...(c.replies ?? []).map((r) => r.to)].filter((id) => !known.has(id));
  if (unknown.length) {
    return finish([{ description: "Case setup", passed: false, detail: `Unknown person id(s): ${[...new Set(unknown)].join(", ")}` }], 0, emptyUsage(), "Not run: bad case setup.");
  }

  let eventId: string;
  try {
    const ctx: SeedContext = {
      service,
      now: () => new Date(seedMs),
      advanceMinutes: (m) => {
        seedMs += Math.max(0, m) * 60_000;
      },
      people: cast.map((p) => ({ ...p })),
      timeZone: tz,
    };
    ({ eventId } = await c.seed(ctx));
    if (!(await store.get(eventId))) throw new Error(`seed returned event ${eventId}, which isn't in the store`);
  } catch (err) {
    return finish([{ description: "Seed the dinner", passed: false, detail: errorText(err) }], 0, emptyUsage(), "Not run: seeding failed.");
  }

  const simClock = new SimClock(new Date(seedMs), { bus });
  clock = simClock;
  const now = () => simClock.nowIso();
  bus.emit({ type: "clock", at: now() });

  // ---------- the coordinator, wired to this case's personas and stubs ----------

  const toolCalls: ToolCallRecord[] = [];
  let restaurantName = (await store.get(eventId))?.booking?.restaurantName ?? "Restaurant";
  const rules = c.replies ?? [];
  const fired = rules.map(() => false);

  const coordinator = createFoCoordinator({
    ...(anthropic ? { anthropic } : {}),
    ...(backend ? { backend } : {}),
    bus,
    clock: simClock,
    store,
    service,
    people,
    systemPrompt: buildSystemPrompt(scenario, opts.standingInstructions ?? (cachedInstructions ??= readStandingInstructions())),
    city: scenario.city,
    country: scenario.country,
    timeZone: tz,
    model: opts.model ?? DEFAULT_SANDBOX_MODEL,
    maxTurns: maxRuns,
    maxIterationsPerRun: opts.maxIterationsPerRun ?? 20,
    startedAt,
    wallClockBudgetMs: budgetMs,
    ...(opts.retryDelaysMs ? { retryDelaysMs: opts.retryDelaysMs } : {}),
    onFoText: (person, text) => {
      // First unfired matching rule only, so repeated asks walk through the rules in order.
      const i = rules.findIndex((r, idx) => {
        if (fired[idx] || r.to !== person.id) return false;
        r.when.lastIndex = 0;
        return r.when.test(text);
      });
      if (i < 0) return;
      fired[i] = true;
      const rule = rules[i]!;
      const at = new Date(simClock.now().getTime() + (rule.afterMinutes ?? 1) * 60_000);
      simClock.schedule(at, () => coordinator.deliver(person.id, rule.reply), `${person.name} replies`, { announce: false });
    },
    callRestaurant: (restaurant, request, callNumber) => {
      const override = c.stubs?.callRestaurant;
      if (override) {
        const said = override(restaurant, request);
        bus.emit({ type: "stubbed", at: now(), action: "call_restaurant", detail: `${restaurant}: ${clip(request, 400)} -> ${clip(said, 400)}` });
        return { ok: true, restaurant, outcome: said };
      }
      const reply = defaultRestaurantReply(restaurant, callNumber);
      bus.emit({ type: "stubbed", at: now(), action: "call_restaurant", detail: `${restaurant}: ${clip(request, 400)} -> ${String(reply.confirmation)}` });
      return reply;
    },
    readReceipt: () => {
      const custom = c.stubs?.receiptText;
      if (custom !== undefined) {
        bus.emit({ type: "note", at: now(), text: "Fo read the receipt photo (this case's receipt text)." });
        return { ok: true, lines: custom };
      }
      bus.emit({ type: "note", at: now(), text: `Fo read the receipt photo (dummy receipt: ${DUMMY_RECEIPT.items.length} items, $${DUMMY_RECEIPT.total}).` });
      return { ok: true, lines: receiptText(DUMMY_RECEIPT, restaurantName) };
    },
    onTool: (o) => {
      toolCalls.push({ name: o.name, args: o.args, ok: o.ok, result: o.result, triggeredBy: o.trigger?.kind === "text" ? o.trigger.personId : "timer" });
    },
  });

  await coordinator.checkStages(eventId);

  let at = simClock.now().getTime();
  for (const step of c.inbound) {
    at += (step.afterMinutes ?? 1) * 60_000;
    const name = coordinator.person(step.from)?.name ?? step.from;
    simClock.schedule(new Date(at), () => coordinator.deliver(step.from, step.text), `${name} texts`, { announce: false });
  }

  // ---------- the loop ----------

  let stopReason: string | undefined;
  while (!stopReason) {
    await coordinator.idle();
    const booking = (await store.get(eventId))?.booking;
    if (booking) restaurantName = booking.restaurantName;
    const fatal = coordinator.fatal();
    const pending = simClock.pending().length;
    if (fatal) stopReason = `Stopped on an error: ${clip(fatal, 200)}`;
    else if (coordinator.turns() >= maxRuns && pending) stopReason = `Stopped at the ${maxRuns}-run cap with ${pending} item(s) pending.`;
    else if (Date.now() - startedAt > budgetMs) stopReason = `Stopped at the ${Math.round(budgetMs / 60_000)}-minute wall-clock cap.`;
    else if (!(await simClock.advanceToNext())) stopReason = "Done: nothing left pending.";
  }

  // ---------- grade ----------

  const usage = coordinator.usage;
  const runs = coordinator.turns();
  const extra = { duplicateTimers: coordinator.duplicateTimers.length, auditFlags: [...coordinator.auditFlags] };
  const finalEvent = await store.get(eventId);
  if (!finalEvent) return finish([{ description: "Read the final dinner", passed: false, detail: `Event ${eventId} disappeared from the store.` }], runs, usage, stopReason, extra);

  const events = bus.history.slice(historyStart);
  const texts = events.flatMap((e) => (e.type === "text" && e.from === "fo" ? [{ to: e.to, text: e.text }] : []));
  const history: CaseHistory = {
    events,
    toolCalls,
    textsTo: (personId) => texts.filter((t) => t.to === personId).map((t) => t.text),
    allTexts: () => texts.map((t) => ({ ...t })),
    finalEvent,
    stubbed: events.flatMap((e) => (e.type === "stubbed" ? [{ action: e.action, detail: e.detail }] : [])),
    duplicateTimers: coordinator.duplicateTimers.map((d) => ({ ...d })),
    auditFlags: [...coordinator.auditFlags],
  };

  const checks: EdgeCheckResult[] = [];
  const fatal = coordinator.fatal();
  if (fatal) checks.push({ description: "Coordinator ran without an API error", passed: false, detail: fatal });
  for (const check of c.checks) {
    try {
      const out = check.test(history);
      if (out === true) checks.push({ description: check.description, passed: true });
      else checks.push({ description: check.description, passed: false, detail: typeof out === "string" ? out : `check returned ${String(out)}` });
    } catch (err) {
      checks.push({ description: check.description, passed: false, detail: `check threw: ${errorText(err)}` });
    }
  }
  return finish(checks, runs, usage, stopReason, extra);
}

// ---------- the suite ----------

export interface SuiteOptions {
  concurrency: number;
  /** Stop starting new cases once finished cases have cost this much (estimate). */
  maxUsd: number;
  runCase: (c: EdgeCase) => Promise<EdgeCaseResult>;
  onResult?: (result: EdgeCaseResult, progress: { done: number; total: number; totalUsd: number }) => void;
}

export interface SuiteResult {
  /** In the order the cases were given. */
  results: EdgeCaseResult[];
  /** Not started because of the cost cap. */
  skipped: EdgeCase[];
  totalUsd: number;
}

export async function runSuite(cases: EdgeCase[], opts: SuiteOptions): Promise<SuiteResult> {
  const results = new Map<number, EdgeCaseResult>();
  let next = 0;
  let totalUsd = 0;
  let done = 0;

  const worker = async () => {
    while (next < cases.length && totalUsd < opts.maxUsd) {
      const index = next++;
      const c = cases[index]!;
      let result: EdgeCaseResult;
      try {
        result = await opts.runCase(c);
      } catch (err) {
        result = {
          id: c.id,
          title: c.title,
          area: c.area,
          planRef: c.planRef,
          critical: c.critical,
          passed: false,
          checks: [{ description: "Run the case", passed: false, detail: errorText(err) }],
          runs: 0,
          usage: emptyUsage(),
          estimatedUsd: 0,
          history: [],
          stopReason: "Crashed.",
          duplicateTimers: 0,
          auditFlags: [],
        };
      }
      results.set(index, result);
      totalUsd += result.estimatedUsd;
      done++;
      opts.onResult?.(result, { done, total: cases.length, totalUsd });
    }
  };

  const workers = Math.max(1, Math.min(Math.floor(opts.concurrency) || 1, cases.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return {
    results: [...results.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r),
    skipped: cases.filter((_, i) => !results.has(i)),
    totalUsd: Math.round(totalUsd * 10_000) / 10_000,
  };
}
