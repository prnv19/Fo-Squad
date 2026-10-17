import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerState, RunnerStateStore } from "./types.js";

export const OUTBOX_CAP_PER_EVENT = 20;
export const DONE_CAP = 5_000;

export function emptyRunnerState(): RunnerState {
  return { cursors: {}, done: [], foConversationByEvent: {}, outbox: {} };
}

/** Fills in fields missing from older or hand-edited state files. */
function normalize(raw: Partial<RunnerState> | undefined): RunnerState {
  const base = emptyRunnerState();
  if (!raw || typeof raw !== "object") return base;
  return {
    cursors: raw.cursors && typeof raw.cursors === "object" ? raw.cursors : base.cursors,
    done: Array.isArray(raw.done) ? raw.done : base.done,
    foConversationByEvent:
      raw.foConversationByEvent && typeof raw.foConversationByEvent === "object"
        ? raw.foConversationByEvent
        : base.foConversationByEvent,
    outbox: raw.outbox && typeof raw.outbox === "object" ? raw.outbox : base.outbox,
  };
}

/** Copy with the outbox and done list trimmed to their caps, oldest dropped first. */
export function capRunnerState(state: RunnerState): RunnerState {
  const next = structuredClone(normalize(state));
  for (const [eventId, entries] of Object.entries(next.outbox)) {
    if (entries.length > OUTBOX_CAP_PER_EVENT) next.outbox[eventId] = entries.slice(-OUTBOX_CAP_PER_EVENT);
  }
  if (next.done.length > DONE_CAP) next.done = next.done.slice(-DONE_CAP);
  return next;
}

export class MemoryRunnerStateStore implements RunnerStateStore {
  private state: RunnerState = emptyRunnerState();

  async load(): Promise<RunnerState> {
    return structuredClone(this.state);
  }

  async save(state: RunnerState): Promise<void> {
    this.state = capRunnerState(state);
  }
}

/** `dir/runner-state.json`, written via temp file + rename so a crash never leaves half a file. */
export class FileRunnerStateStore implements RunnerStateStore {
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = path.join(dir, "runner-state.json");
  }

  async load(): Promise<RunnerState> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyRunnerState();
      throw err;
    }
    // A corrupt file must stop the runner: starting from empty would forget
    // what was already sent and text people twice.
    try {
      return normalize(JSON.parse(text) as Partial<RunnerState>);
    } catch (err) {
      throw new Error(`Runner state file ${this.file} is not valid JSON: ${(err as Error).message}`);
    }
  }

  async save(state: RunnerState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(capRunnerState(state), null, 2), "utf8");
      await rename(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

/** File-backed when DATA_DIR is set (same directory as the event store), else in memory. */
export function createRunnerStateStore(env: NodeJS.ProcessEnv = process.env): RunnerStateStore {
  const dir = env.DATA_DIR?.trim();
  return dir ? new FileRunnerStateStore(dir) : new MemoryRunnerStateStore();
}
