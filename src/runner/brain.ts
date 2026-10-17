// ClaudeBrain: one stateless Claude run per RunContext. System prompt + tool
// list are a fixed prefix (cached); the run message carries the trigger, the
// current get_status and recent sends. Claude acts only through the actions
// built for this run, which bind approvals to ctx.actorPhone in code.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { z } from "zod";
import type { EventStore } from "../events/index.js";
import type { FoSquadService } from "../service.js";
import { buildActions, type Action } from "./actions.js";
import { buildRunMessage, SYSTEM_PROMPT, type OutboxLine } from "./prompt.js";
import type { Brain, BrainResult, FoClient, RunContext, RunnerState, RunnerStateStore } from "./types.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
// Non-streaming: each iteration yields a whole message.
type RunnerParams = Anthropic.Beta.Messages.BetaToolRunnerParams & { stream: false };

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
const OUTBOX_LINES_IN_PROMPT = 10;

export interface ClaudeBrainOptions {
  anthropic: Anthropic;
  service: FoSquadService;
  store: EventStore;
  fo: FoClient;
  stateStore: RunnerStateStore;
  /** Phones allowed to start a dinner (env ORGANIZER_PHONES). */
  organizerPhones: readonly string[];
  model?: string;
  /** Cap on model turns (API requests) per run. */
  maxIterations?: number;
  /** Passed to each Fo turn. */
  foTimeoutMs?: number;
  /** Wait before the one retry after a rate limit, when the API gives no retry-after. */
  retryDelayMs?: number;
  /**
   * Serialized read-modify-write of runner state. Pass the runner loop's
   * updater so both take the same lock; default: the brain's own, over stateStore.
   */
  updateState?: <T>(fn: (state: RunnerState) => T) => Promise<T>;
  /** Fo conversations left mid-turn, shared with the runner loop. */
  busyConversations?: Set<string>;
  log?: (line: string) => void;
}

type ToolCallLog = BrainResult["toolCalls"];

export class ClaudeBrain implements Brain {
  private readonly anthropic: Anthropic;
  private readonly service: FoSquadService;
  private readonly store: EventStore;
  private readonly fo: FoClient;
  private readonly stateStore: RunnerStateStore;
  private readonly organizerPhones: readonly string[];
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly foTimeoutMs: number | undefined;
  private readonly retryDelayMs: number;
  private readonly log: (line: string) => void;

  /** Per-event run lock: tail of the queue for each key. */
  private readonly locks = new Map<string, Promise<void>>();
  /** State writes are serialized so concurrent runs don't overwrite each other. */
  private stateChain: Promise<unknown> = Promise.resolve();
  /** Fo conversations left mid-turn; outlives runs so the next run doesn't talk over Fo. */
  readonly busyConversations: Set<string>;
  /** Public so the runner loop can share it (and its lock) instead of racing it. */
  readonly updateState: <T>(fn: (state: RunnerState) => T) => Promise<T>;

  constructor(opts: ClaudeBrainOptions) {
    this.anthropic = opts.anthropic;
    this.service = opts.service;
    this.store = opts.store;
    this.fo = opts.fo;
    this.stateStore = opts.stateStore;
    this.organizerPhones = opts.organizerPhones;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxIterations = opts.maxIterations ?? 20;
    this.foTimeoutMs = opts.foTimeoutMs;
    this.retryDelayMs = opts.retryDelayMs ?? 5000;
    this.log = opts.log ?? ((line) => console.error(`[runner/brain] ${line}`));
    this.busyConversations = opts.busyConversations ?? new Set<string>();
    this.updateState = opts.updateState ?? ((fn) => this.ownUpdateState(fn));
  }

  async handle(ctx: RunContext): Promise<BrainResult> {
    const eventId = await this.resolveEventId(ctx);
    const key = eventId ? `event:${eventId}` : `actor:${ctx.actorPhone ?? triggerFallbackKey(ctx)}`;
    return this.locked(key, () => this.run(ctx, eventId));
  }

  // ---------- one run ----------

  private async run(ctx: RunContext, eventId: string | undefined): Promise<BrainResult> {
    const toolCalls: ToolCallLog = [];
    const status = await this.snapshot(ctx, eventId);
    const outbox: OutboxLine[] = eventId
      ? await this.updateState((s) => (s.outbox[eventId] ?? []).slice(-OUTBOX_LINES_IN_PROMPT))
      : [];

    const actions = buildActions(ctx, {
      service: this.service,
      store: this.store,
      fo: this.fo,
      updateState: (fn) => this.updateState(fn),
      organizerPhones: this.organizerPhones,
      busyConversations: this.busyConversations,
      ...(this.foTimeoutMs !== undefined ? { foTimeoutMs: this.foTimeoutMs } : {}),
    });

    let params: RunnerParams = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      stream: false,
      // Explicit breakpoint on the static prefix (tools + system) so it is
      // shared across runs; top-level cache_control covers the growing loop.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      cache_control: { type: "ephemeral" },
      // Money and privacy: don't take the medium default.
      output_config: { effort: "high" },
      // A classifier refusal is retried server-side on the recommended model.
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      tools: actions.map((a) => toRunnable(a, toolCalls)),
      messages: [{ role: "user", content: buildRunMessage(ctx, status, outbox) }],
      max_iterations: this.maxIterations,
    };

    let turns = 0;
    let retried = false;
    for (;;) {
      const runner = this.anthropic.beta.messages.toolRunner(params);
      try {
        let last: BetaMessage | undefined;
        for await (const message of runner) {
          last = message;
          turns++;
        }
        return this.finish(last, toolCalls, turns);
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError && !retried) {
          retried = true;
          // Resume from where the loop got to, so tools that already ran
          // (texts already sent) are not run again.
          params = {
            ...params,
            messages: [...runner.params.messages],
            max_iterations: Math.max(1, this.maxIterations - turns),
          };
          const wait = retryAfterMs(err) ?? this.retryDelayMs;
          this.log(`rate limited; retrying once in ${wait}ms`);
          await sleep(wait);
          continue;
        }
        return this.failure(err, toolCalls);
      }
    }
  }

  private finish(last: BetaMessage | undefined, toolCalls: ToolCallLog, turns: number): BrainResult {
    if (!last) return { summary: "Failed: Claude returned no message.", toolCalls };
    const text = last.content
      .flatMap((b) => (b.type === "text" ? [b.text.trim()] : []))
      .filter(Boolean)
      .join(" ");

    switch (last.stop_reason) {
      case "refusal": {
        // The runner never executes tool calls from a refused turn, so nothing
        // partial goes out; earlier tool calls in this run were complete.
        const category = last.stop_details?.category ?? "unspecified";
        this.log(`refusal (category ${category}) after ${toolCalls.length} tool calls`);
        return { summary: `Claude declined this run (refusal, category ${category}). Nothing further was sent.`, toolCalls };
      }
      case "max_tokens":
        this.log("hit max_tokens; the cut-off turn was not executed");
        return { summary: "Stopped: Claude's reply hit max_tokens. The unfinished step was not executed.", toolCalls };
      case "tool_use":
        this.log(`hit the ${this.maxIterations}-turn cap`);
        return {
          summary: `Stopped after ${turns} model turns (cap ${this.maxIterations}) with work left.${text ? ` Last note: ${clip(text)}` : ""}`,
          toolCalls,
        };
      default:
        return { summary: text ? clip(text) : "Done (no summary from Claude).", toolCalls };
    }
  }

  private failure(err: unknown, toolCalls: ToolCallLog): BrainResult {
    let what: string;
    if (err instanceof Anthropic.APIError) {
      what = `Claude API error${err.status ? ` ${err.status}` : ""} (${err.constructor.name}): ${err.message}`;
    } else {
      what = `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.log(what);
    const done = toolCalls.length ? ` ${toolCalls.length} tool calls had already run.` : " No tools ran.";
    return { summary: `Failed: ${clip(what)}.${done}`, toolCalls };
  }

  // ---------- context ----------

  private async resolveEventId(ctx: RunContext): Promise<string | undefined> {
    const t = ctx.trigger;
    if (t.kind !== "inbound_text") return t.eventId;
    if (t.eventId) return t.eventId;
    if (!ctx.actorPhone) return undefined;
    try {
      return (await this.store.findActiveByPhone(ctx.actorPhone))?.id;
    } catch {
      return undefined;
    }
  }

  private async snapshot(ctx: RunContext, eventId: string | undefined): Promise<unknown> {
    try {
      if (eventId) {
        // With the phone too, the status says who the sender is in this dinner.
        const byPhone = ctx.actorPhone ? await this.service.getStatus({ phone: ctx.actorPhone }) : undefined;
        if (byPhone && byPhone.event_id === eventId) return byPhone;
        return await this.service.getStatus({ event_id: eventId });
      }
      return undefined;
    } catch (err) {
      return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  }

  // ---------- plumbing ----------

  private ownUpdateState<T>(fn: (state: RunnerState) => T): Promise<T> {
    const next = this.stateChain.then(async () => {
      const state = await this.stateStore.load();
      const before = JSON.stringify(state);
      const result = fn(state);
      if (JSON.stringify(state) !== before) await this.stateStore.save(state);
      return result;
    });
    this.stateChain = next.catch(() => undefined);
    return next;
  }

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => mine);
    this.locks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

/**
 * Wraps an Action for the SDK tool runner; ok: false results go back as
 * is_error. Built by hand rather than with betaZodTool (which works with our
 * zod 4) for two reasons: its reused: "ref" output turns repeated tiny schemas
 * into $defs the model has to chase, and Action.run already validates with a
 * friendlier error and records failed calls.
 */
function toRunnable(action: Action, toolCalls: ToolCallLog): BetaRunnableTool<Record<string, unknown>> {
  return {
    type: "custom",
    name: action.name,
    description: action.description,
    input_schema: z.toJSONSchema(action.inputSchema) as Anthropic.Beta.Messages.BetaTool.InputSchema,
    parse: (input: unknown) => input as Record<string, unknown>,
    run: async (args) => {
      const r = await action.run(args);
      toolCalls.push({ name: action.name, ok: r.ok });
      const text = JSON.stringify(r.result);
      if (!r.ok) throw new ToolError(text);
      return text;
    },
  };
}

function triggerFallbackKey(ctx: RunContext): string {
  return ctx.trigger.kind === "inbound_text" ? `conversation:${ctx.trigger.message.conversationId}` : "unknown";
}

function retryAfterMs(err: InstanceType<typeof Anthropic.RateLimitError>): number | undefined {
  const raw = err.headers?.get("retry-after");
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 60_000) : undefined;
}

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
