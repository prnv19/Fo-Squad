// The always-on loop: poll Fo's SMS threads, route each inbound text to the
// brain (or handle STOP deterministically), send due nudges/reminders through
// Fo, then run due triggers through the brain. One tick at a time, and every
// Fo call strictly sequential, because Fo turns are slow and serial.

import { tryNormalizePhone, withEventLock, type EventStore } from "../events/index.js";
import type { FoSquadService } from "../service.js";
import type { DinnerEvent } from "../types.js";
import { asksForConfirmation, SEND_TEXTS_PREAMBLE } from "./actions.js";
import type { PollInboxOptions } from "./inbox.js";
import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_TIME_ZONE,
  dueWork,
  roundMarkers,
  type KeyedTrigger,
  type QuietHours,
} from "./timers.js";
import type {
  Brain,
  FoClient,
  FoReply,
  InboundText,
  RunnerState,
  RunnerStateStore,
  ScheduledSend,
  Trigger,
} from "./types.js";

export type PollInbox = (
  fo: FoClient,
  state: RunnerState,
  opts?: PollInboxOptions,
) => Promise<{ messages: InboundText[]; state: RunnerState }>;

/** The service calls the runner makes itself; the brain reaches the rest through its tools. */
export type RunnerService = Pick<FoSquadService, "markNudged" | "recordOptOut">;

/** Serialized read-modify-write of the runner state; saved before it resolves. Same shape as ActionDeps.updateState. */
export type StateUpdater = <T>(fn: (state: RunnerState) => T) => Promise<T>;

// Not a valid event id (":"), so it can't collide with an event's lock.
const STATE_LOCK = "fo-runner:state";

/**
 * The one way runner state is changed, shared by the loop and the brain's
 * tools so neither overwrites the other's changes. `fn` must be synchronous:
 * never hold the lock across a Fo or Claude call.
 */
export function serializedStateUpdater(store: RunnerStateStore): StateUpdater {
  return <T>(fn: (state: RunnerState) => T) =>
    withEventLock(STATE_LOCK, async () => {
      const state = await store.load();
      const result = fn(state);
      await store.save(state);
      return result;
    });
}

export interface RunnerOptions {
  service: RunnerService;
  store: EventStore;
  fo: FoClient;
  brain: Brain;
  stateStore: RunnerStateStore;
  /** Numbers allowed to start a new dinner by texting Fo. Anyone else needs an active event. */
  organizerPhones: string[];
  pollInbox: PollInbox;
  /** Pass the brain's updater so both serialize on the same lock. Default: built from stateStore. */
  updateState?: StateUpdater;
  /** Fo conversations left mid-turn; shared with the brain so neither starts a second turn on one. */
  busyConversations?: Set<string>;
  clock?: () => Date;
  intervalMs?: number;
  timeZone?: string;
  quietHours?: QuietHours;
  log?: (line: string) => void;
}

export interface TickReport {
  startedAt: string;
  /** True when the previous tick was still running, so this one did nothing. */
  skipped: boolean;
  inbound: number;
  /** Inbound texts handed to the brain. */
  routed: number;
  /** Inbound texts dropped (stranger, unknown thread). */
  ignored: number;
  optOuts: number;
  /** ScheduledSends Fo accepted. */
  sends: number;
  /** Fo turns used for scheduled sends (one per event with due sends). */
  foBatches: number;
  triggers: number;
  errors: string[];
}

export interface RunnerHealth {
  enabled: boolean;
  lastTickAt: string | null;
  lastError: string | null;
}

const SEND_YES = "Yes, please send them exactly as written. They are all people in this dinner.";

/**
 * The brain's exact-wording format (same preamble as send_texts), prefixed with
 * the dinner name so Fo's relay-mode settings recognize the instruction.
 */
export function formatSendBatch(title: string, messages: { name: string; phone: string; text: string }[]): string {
  const lines = messages.map((m, i) => `${i + 1}. To ${m.name} (${m.phone}): ${m.text}`);
  return `[Fo Squad: ${title}] ${SEND_TEXTS_PREAMBLE}\n${lines.join("\n")}`;
}

const STOP_RE = /^\s*(stop|unsubscribe)[\s.!]*$/i;
const OUTBOX_KEEP = 20;
/** A trigger that keeps failing is given up after this many tries, so it can't burn a Claude call every minute. */
const MAX_TRIGGER_ATTEMPTS = 3;

export function isStopMessage(text: string): boolean {
  return STOP_RE.test(text);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Runner {
  private readonly service: RunnerService;
  private readonly store: EventStore;
  private readonly fo: FoClient;
  private readonly brain: Brain;
  private readonly update: StateUpdater;
  private readonly busy: Set<string>;
  private readonly organizerPhones: Set<string>;
  private readonly pollInbox: PollInbox;
  private readonly clock: () => Date;
  private readonly intervalMs: number;
  private readonly timeZone: string;
  private readonly quietHours: QuietHours;
  private readonly log: (line: string) => void;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<TickReport> | undefined;
  private readonly triggerAttempts = new Map<string, number>();
  private lastTickAt: string | null = null;
  private lastError: string | null = null;

  constructor(opts: RunnerOptions) {
    this.service = opts.service;
    this.store = opts.store;
    this.fo = opts.fo;
    this.brain = opts.brain;
    this.update = opts.updateState ?? serializedStateUpdater(opts.stateStore);
    this.busy = opts.busyConversations ?? new Set();
    this.organizerPhones = new Set(
      opts.organizerPhones.map((p) => tryNormalizePhone(p)).filter((p): p is string => !!p),
    );
    this.pollInbox = opts.pollInbox;
    this.clock = opts.clock ?? (() => new Date());
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
    this.quietHours = opts.quietHours ?? DEFAULT_QUIET_HOURS;
    this.log = opts.log ?? ((line) => console.error(`[fo-runner] ${line}`));
  }

  start(): void {
    if (this.timer) return;
    const run = () => {
      this.tick().catch((err) => this.log(`tick crashed: ${errorText(err)}`));
    };
    this.timer = setInterval(run, this.intervalMs);
    // Don't hold the process open just for the runner (the HTTP server does that).
    this.timer.unref?.();
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  health(): RunnerHealth {
    return { enabled: true, lastTickAt: this.lastTickAt, lastError: this.lastError };
  }

  /** One pass of the loop. If the previous tick is still running, returns a skipped report. */
  async tick(): Promise<TickReport> {
    if (this.running) {
      return { ...emptyReport(this.clock()), skipped: true };
    }
    this.running = this.runTick();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async runTick(): Promise<TickReport> {
    const now = this.clock();
    const report = emptyReport(now);
    const fail = (where: string, err: unknown) => {
      const line = `${where}: ${errorText(err)}`;
      report.errors.push(line);
      this.log(line);
    };

    // a. Load state and poll. Cursors are saved before handling, so a crash
    // mid-handling drops a text rather than replaying it into a second set of texts.
    let messages: InboundText[] = [];
    try {
      const snapshot = await this.update((s) => structuredClone(s));
      const polled = await this.pollInbox(this.fo, snapshot, { now: this.clock, log: this.log });
      messages = polled.messages;
      await this.update((s) => {
        s.cursors = polled.state.cursors;
      });
    } catch (err) {
      fail("poll inbox", err);
    }

    // b. Inbound texts, oldest first.
    const ordered = [...messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    report.inbound = ordered.length;
    let foBusy = false;
    for (const message of ordered) {
      try {
        foBusy = (await this.handleInbound(message, report)) || foBusy;
      } catch (err) {
        fail(`inbound from ${message.phone ?? message.threadTitle}`, err);
      }
    }

    // c. Timers.
    let events: DinnerEvent[] = [];
    let due: ReturnType<typeof dueWork> = { sends: [], triggers: [] };
    try {
      events = (await this.store.list()).filter((e) => e.stage !== "settled");
      const state = await this.update((s) => {
        s.done.push(...roundMarkers(events, s, now));
        return structuredClone(s);
      });
      due = dueWork(events, state, now, { timeZone: this.timeZone, quietHours: this.quietHours });
    } catch (err) {
      fail("timers", err);
    }

    const byEvent = new Map<string, ScheduledSend[]>();
    for (const send of due.sends) byEvent.set(send.eventId, [...(byEvent.get(send.eventId) ?? []), send]);
    for (const [eventId, sends] of byEvent) {
      // Fo is still mid-turn: wait for the next tick rather than pile on.
      if (foBusy) break;
      const event = events.find((e) => e.id === eventId);
      if (!event) continue;
      try {
        foBusy = (await this.sendBatch(event, sends, now, report)) || foBusy;
      } catch (err) {
        fail(`sends for ${eventId}`, err);
      }
    }

    for (const trigger of due.triggers) {
      if (foBusy) break;
      try {
        await this.runTrigger(trigger, now, report);
        await this.update((s) => void s.done.push(trigger.key));
        this.triggerAttempts.delete(trigger.key);
      } catch (err) {
        const attempts = (this.triggerAttempts.get(trigger.key) ?? 0) + 1;
        this.triggerAttempts.set(trigger.key, attempts);
        fail(`trigger ${trigger.key} (attempt ${attempts})`, err);
        if (attempts >= MAX_TRIGGER_ATTEMPTS) {
          this.log(`giving up on ${trigger.key} after ${attempts} attempts`);
          this.triggerAttempts.delete(trigger.key);
          await this.update((s) => void s.done.push(trigger.key)).catch((e) => fail("save state", e));
        }
      }
    }

    this.lastTickAt = report.startedAt;
    if (report.errors.length > 0) this.lastError = report.errors.at(-1) ?? null;
    return report;
  }

  /** Returns true when Fo was left mid-turn (so later Fo work this tick must wait). */
  private async handleInbound(message: InboundText, report: TickReport): Promise<boolean> {
    const now = this.clock();
    let phone = message.phone ? tryNormalizePhone(message.phone) : undefined;
    if (!phone) {
      phone = await this.phoneByThreadName(message.threadTitle);
      if (!phone) {
        report.ignored++;
        this.log(`ignored text in "${message.threadTitle}": can't tell who sent it`);
        return false;
      }
    }
    const event = await this.store.findActiveByContact(phone);

    if (isStopMessage(message.text)) {
      if (!event) {
        report.ignored++;
        this.log(`STOP from ${phone} with no active dinner; nothing to record`);
        return false;
      }
      return this.optOut(event, phone, report);
    }

    if (event) {
      report.routed++;
      const trigger: Trigger = { kind: "inbound_text", message, eventId: event.id };
      const result = await this.brain.handle({ trigger, actorPhone: phone, now });
      this.log(`[${event.id}] ${result.summary}`);
      return false;
    }

    if (this.organizerPhones.has(phone)) {
      report.routed++;
      const result = await this.brain.handle({ trigger: { kind: "inbound_text", message }, actorPhone: phone, now });
      this.log(`[new] ${result.summary}`);
      return false;
    }

    // Strangers must never be able to make Fo text people.
    report.ignored++;
    this.log(`ignored text from ${phone}: no active dinner and not an organizer`);
    return false;
  }

  /** A unique case-insensitive match of the thread title against people in active dinners. */
  private async phoneByThreadName(title: string): Promise<string | undefined> {
    const name = title.trim().toLowerCase();
    if (!name) return undefined;
    const phones = new Set<string>();
    for (const e of await this.store.list()) {
      if (e.stage === "settled") continue;
      for (const p of e.people) if (p.phone && p.name.trim().toLowerCase() === name) phones.add(p.phone);
    }
    return phones.size === 1 ? [...phones][0] : undefined;
  }

  private async optOut(event: DinnerEvent, phone: string, report: TickReport): Promise<boolean> {
    const result = await this.service.recordOptOut({ event_id: event.id, person: phone });
    report.optOuts++;
    const person = event.people.find((p) => p.phone === phone);
    const organizer = event.people.find((p) => p.id === event.organizerId);
    this.log(`[${event.id}] ${person?.name ?? phone} opted out`);
    // The relay only texts, so an organizer without a phone can't be told here.
    if (!organizer?.phone || organizer.optedOut || organizer.phone === phone) return false;
    const notice =
      typeof result.tell_organizer === "string"
        ? result.tell_organizer
        : `${person?.name ?? phone} replied STOP, so I won't text them again about "${event.title}".`;
    const reply = await this.askFo(event, formatSendBatch(event.title, [{ name: organizer.name, phone: organizer.phone, text: notice }]));
    if (reply.status === "failed") {
      throw new Error(`opt-out saved, but Fo couldn't tell the organizer: ${reply.response ?? "no details"}`);
    }
    await this.recordOutbox(event.id, this.clock(), [{ to: organizer.name, text: notice }]);
    return reply.status === "working";
  }

  /** One Fo turn for all of an event's due sends. Returns true when Fo was left mid-turn. */
  private async sendBatch(event: DinnerEvent, sends: ScheduledSend[], now: Date, report: TickReport): Promise<boolean> {
    const messages = sends.flatMap((s) => s.to.map((to) => ({ name: to.name, phone: to.phone, text: s.text })));
    if (messages.length === 0) return false;
    const reply = await this.askFo(event, formatSendBatch(event.title, messages));
    report.foBatches++;
    if (reply.status === "failed") {
      throw new Error(`Fo couldn't send: ${reply.response ?? "no details"}`);
    }
    // "working" after the client's timeout: Fo keeps going on its own, so count
    // the texts as sent. Retrying would risk texting everyone twice.
    await this.update((s) => {
      s.done.push(...sends.map((x) => x.key));
      appendOutbox(s, event.id, now, messages.map((m) => ({ to: m.name, text: m.text })));
    });
    report.sends += sends.length;

    for (const send of sends) {
      if (send.kind !== "nudge") continue;
      for (const to of send.to) {
        try {
          await this.service.markNudged({ event_id: event.id, person: to.personId });
        } catch (err) {
          const line = `mark_nudged ${to.personId} on ${event.id}: ${errorText(err)}`;
          report.errors.push(line);
          this.log(line);
        }
      }
    }
    if (reply.status === "working") this.log(`[${event.id}] Fo still working on the sends; pausing Fo work this tick`);
    return reply.status === "working";
  }

  /** One turn in the event's Fo conversation (a new one if there's none or it's mid-turn), plus one yes if Fo asks to confirm. */
  private async askFo(event: DinnerEvent, message: string): Promise<FoReply> {
    const known = await this.update((s) => s.foConversationByEvent[event.id]);
    const usable = known && !this.busy.has(known) ? known : undefined;
    let reply = await this.fo.ask(message, usable ? { conversationId: usable } : { newConversation: true });
    if (reply.conversationId && reply.conversationId !== usable) {
      await this.update((s) => {
        s.foConversationByEvent[event.id] = reply.conversationId;
      });
    }
    // Every recipient is a member of this dinner who hasn't opted out, so one yes is safe.
    if (reply.status === "complete" && asksForConfirmation(reply.response)) {
      reply = await this.fo.ask(SEND_YES, { conversationId: reply.conversationId });
    }
    if (reply.status === "working") this.busy.add(reply.conversationId);
    else this.busy.delete(reply.conversationId);
    return reply;
  }

  private async recordOutbox(eventId: string, at: Date, entries: { to: string; text: string }[]): Promise<void> {
    await this.update((s) => appendOutbox(s, eventId, at, entries));
  }

  private async runTrigger(trigger: KeyedTrigger, now: Date, report: TickReport): Promise<void> {
    const { key: _key, ...plain } = trigger;
    const result = await this.brain.handle({ trigger: plain as Trigger, now });
    report.triggers++;
    this.log(`[${trigger.eventId}] ${trigger.kind}: ${result.summary}`);
  }
}

function appendOutbox(state: RunnerState, eventId: string, at: Date, entries: { to: string; text: string }[]): void {
  const list = [...(state.outbox[eventId] ?? []), ...entries.map((e) => ({ at: at.toISOString(), ...e }))];
  state.outbox[eventId] = list.slice(-OUTBOX_KEEP);
}

function emptyReport(now: Date): TickReport {
  return {
    startedAt: now.toISOString(),
    skipped: false,
    inbound: 0,
    routed: 0,
    ignored: 0,
    optOuts: 0,
    sends: 0,
    foBatches: 0,
    triggers: 0,
    errors: [],
  };
}
