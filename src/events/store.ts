import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Concession, DinnerEvent } from "../types.js";
import { FoError } from "./errors.js";
import { isValidEventId } from "./ids.js";
import { tryNormalizePhone } from "./people.js";

export interface EventStore {
  get(id: string): Promise<DinnerEvent | undefined>;
  put(event: DinnerEvent): Promise<void>;
  list(): Promise<DinnerEvent[]>;
  /** Most recently updated non-settled event that includes this phone number. */
  findActiveByPhone(phone: string): Promise<DinnerEvent | undefined>;
  getConcessions(): Promise<Concession[]>;
  putConcessions(concessions: Concession[]): Promise<void>;
}

function assertEventId(id: string): void {
  if (!isValidEventId(id)) {
    throw new FoError("INVALID_INPUT", `"${String(id)}" isn't a valid event id.`);
  }
}

function pickActiveByPhone(events: DinnerEvent[], phone: string): DinnerEvent | undefined {
  const normalized = tryNormalizePhone(phone);
  if (!normalized) return undefined;
  let best: DinnerEvent | undefined;
  for (const e of events) {
    if (e.stage === "settled" || !e.people.some((p) => p.phone === normalized)) continue;
    const diff = best ? Date.parse(e.updatedAt) - Date.parse(best.updatedAt) : 1;
    if (!best || diff > 0 || (diff === 0 && Date.parse(e.createdAt) > Date.parse(best.createdAt))) {
      best = e;
    }
  }
  return best;
}

/** In-process store. Copies on the way in and out so callers can't mutate stored state. */
export class MemoryStore implements EventStore {
  private events = new Map<string, DinnerEvent>();
  private concessions: Concession[] = [];

  async get(id: string): Promise<DinnerEvent | undefined> {
    assertEventId(id);
    const e = this.events.get(id);
    return e ? structuredClone(e) : undefined;
  }

  async put(event: DinnerEvent): Promise<void> {
    assertEventId(event.id);
    this.events.set(event.id, structuredClone(event));
  }

  async list(): Promise<DinnerEvent[]> {
    return [...this.events.values()].map((e) => structuredClone(e));
  }

  async findActiveByPhone(phone: string): Promise<DinnerEvent | undefined> {
    const e = pickActiveByPhone([...this.events.values()], phone);
    return e ? structuredClone(e) : undefined;
  }

  async getConcessions(): Promise<Concession[]> {
    return structuredClone(this.concessions);
  }

  async putConcessions(concessions: Concession[]): Promise<void> {
    this.concessions = structuredClone(concessions);
  }
}

/**
 * One JSON file per event under `dir/events/`, plus `dir/concessions.json`.
 * Writes go to a temp file and are renamed into place, so a crash mid-write
 * never leaves a half-written event behind.
 */
export class FileStore implements EventStore {
  private readonly eventsDir: string;
  private readonly concessionsFile: string;

  constructor(readonly dir: string) {
    this.eventsDir = path.join(dir, "events");
    this.concessionsFile = path.join(dir, "concessions.json");
  }

  private fileFor(id: string): string {
    assertEventId(id);
    return path.join(this.eventsDir, `${id}.json`);
  }

  private async writeAtomic(file: string, data: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async get(id: string): Promise<DinnerEvent | undefined> {
    return this.readJson<DinnerEvent>(this.fileFor(id));
  }

  async put(event: DinnerEvent): Promise<void> {
    await this.writeAtomic(this.fileFor(event.id), event);
  }

  async list(): Promise<DinnerEvent[]> {
    let names: string[];
    try {
      names = await readdir(this.eventsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const events: DinnerEvent[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!isValidEventId(id)) continue;
      const e = await this.readJson<DinnerEvent>(path.join(this.eventsDir, name));
      if (e) events.push(e);
    }
    return events;
  }

  async findActiveByPhone(phone: string): Promise<DinnerEvent | undefined> {
    return pickActiveByPhone(await this.list(), phone);
  }

  async getConcessions(): Promise<Concession[]> {
    return (await this.readJson<Concession[]>(this.concessionsFile)) ?? [];
  }

  async putConcessions(concessions: Concession[]): Promise<void> {
    await this.writeAtomic(this.concessionsFile, concessions);
  }
}

/**
 * FileStore when DATA_DIR is set, otherwise MemoryStore (state is lost on restart).
 * On Render or Fly, DATA_DIR must point at a mounted persistent disk/volume;
 * their container filesystems are wiped on every deploy and restart.
 */
export function createStore(env: NodeJS.ProcessEnv = process.env): EventStore {
  const dir = env.DATA_DIR?.trim();
  return dir ? new FileStore(dir) : new MemoryStore();
}

// Promise chain tail per key. Only serializes within one process, which is
// fine for a single server instance; multiple instances would need a real lock.
const lockTails = new Map<string, Promise<void>>();

/**
 * Runs `fn` after every earlier call with the same key has finished, so two
 * replies reported in parallel can't both read, modify and overwrite the event.
 * Any string works as a key ("concessions" for the fairness memory).
 */
export async function withEventLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockTails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => done);
  lockTails.set(id, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (lockTails.get(id) === tail) lockTails.delete(id);
  }
}

/** Locked read-modify-write: loads the event, applies `fn`, saves and returns the result. */
export async function updateEvent(
  store: EventStore,
  id: string,
  fn: (event: DinnerEvent) => DinnerEvent | Promise<DinnerEvent>,
): Promise<DinnerEvent> {
  return withEventLock(id, async () => {
    const current = await store.get(id);
    if (!current) {
      throw new FoError("NOT_FOUND", `I can't find a dinner with id "${id}".`);
    }
    const next = await fn(current);
    if (next.id !== id) throw new Error(`updateEvent changed the event id from ${id} to ${next.id}`);
    await store.put(next);
    return next;
  });
}
