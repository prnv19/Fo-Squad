// Simulated clock and scheduler. Nothing waits on real time: the engine pops
// the earliest pending item, jumps the clock to it and runs it, so a 2-hour
// reply deadline passes as fast as the coordinator can work.

import type { SandboxBus } from "./events.js";

export interface ScheduledItem {
  id: number;
  runAt: Date;
  description: string;
}

interface Entry extends ScheduledItem {
  fn: () => unknown;
}

export interface SimClockOptions {
  bus?: SandboxBus;
  /** Called before the clock jumps forward, e.g. to pace a live viewer. */
  onAdvance?: (fromMs: number, toMs: number) => Promise<void> | void;
}

export class SimClock {
  private nowMs: number;
  private seq = 0;
  private queue: Entry[] = [];
  private readonly bus: SandboxBus | undefined;
  private readonly onAdvance: SimClockOptions["onAdvance"];

  constructor(start: Date, opts: SimClockOptions = {}) {
    this.nowMs = start.getTime();
    this.bus = opts.bus;
    this.onAdvance = opts.onAdvance;
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /**
   * Runs `fn` at `runAt` (or now, if that's in the past). Items at the same
   * time run in the order they were scheduled. `announce: false` keeps
   * engine-internal items (persona replies) out of the `scheduled` events,
   * which are for Fo's own timers.
   */
  schedule(runAt: Date, fn: () => unknown, description: string, opts: { announce?: boolean } = {}): number {
    const at = new Date(Math.max(runAt.getTime(), this.nowMs));
    const id = ++this.seq;
    this.queue.push({ id, runAt: at, description, fn });
    if (opts.announce !== false) {
      this.bus?.emit({ type: "scheduled", at: this.nowIso(), runAt: at.toISOString(), description });
    }
    return id;
  }

  cancel(id: number): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => e.id !== id);
    return this.queue.length !== before;
  }

  pending(): ScheduledItem[] {
    return this.sorted().map(({ id, runAt, description }) => ({ id, runAt, description }));
  }

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  /** Jumps to the next item and runs it. Returns false when nothing is left. */
  async advanceToNext(): Promise<boolean> {
    const next = this.sorted()[0];
    if (!next) return false;
    this.queue = this.queue.filter((e) => e.id !== next.id);
    const target = next.runAt.getTime();
    if (target > this.nowMs) {
      await this.onAdvance?.(this.nowMs, target);
      this.nowMs = target;
      this.bus?.emit({ type: "clock", at: this.nowIso() });
    }
    await next.fn();
    return true;
  }

  private sorted(): Entry[] {
    return [...this.queue].sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.id - b.id);
  }
}
