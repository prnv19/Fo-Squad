import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Concession, DinnerEvent } from "../types.js";
import { createEvent } from "./factory.js";
import { createStore, FileStore, MemoryStore, updateEvent, withEventLock, type EventStore } from "./store.js";

const T0 = "2026-10-17T18:00:00.000Z";

function makeEvent(id: string, phones: string[] = ["5551230001"], now = T0): DinnerEvent {
  return createEvent(
    {
      title: id,
      organizer: { name: "Pranav", phone: "5550001111" },
      friends: phones.map((phone, i) => ({ name: `Friend ${i}`, phone })),
      timeSlots: [{ label: "Sat 7pm", startsAt: "2026-10-24T01:00:00.000Z" }],
    },
    { now, id },
  );
}

const concessions: Concession[] = [{ phone: "+15551230001", eventId: "a", what: "cuisine: thai", at: T0 }];

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "fo-squad-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const stores: [string, () => EventStore][] = [
  ["MemoryStore", () => new MemoryStore()],
  ["FileStore", () => new FileStore(path.join(tmp, "data"))],
];

describe.each(stores)("%s", (_name, make) => {
  it("round trips events", async () => {
    const store = make();
    expect(await store.get("nope")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    const e = makeEvent("evt-1");
    await store.put(e);
    expect(await store.get("evt-1")).toEqual(e);
    await store.put({ ...e, stage: "voting" });
    expect((await store.get("evt-1"))?.stage).toBe("voting");
    expect((await store.list()).map((x) => x.id)).toEqual(["evt-1"]);
  });

  it("returns copies, not live references", async () => {
    const store = make();
    const e = makeEvent("evt-1");
    await store.put(e);
    e.title = "mutated";
    const got = await store.get("evt-1");
    got!.people.length = 0;
    expect((await store.get("evt-1"))?.title).toBe("evt-1");
    expect((await store.get("evt-1"))?.people).toHaveLength(2);
  });

  it("round trips concessions", async () => {
    const store = make();
    expect(await store.getConcessions()).toEqual([]);
    await store.putConcessions(concessions);
    expect(await store.getConcessions()).toEqual(concessions);
  });

  it("findActiveByPhone picks the latest non-settled event with that phone", async () => {
    const store = make();
    await store.put(makeEvent("old", ["5551230001"], "2026-10-01T00:00:00.000Z"));
    await store.put({ ...makeEvent("newer", ["5551230001"], "2026-10-10T00:00:00.000Z") });
    await store.put({ ...makeEvent("newest-settled", ["5551230001"], "2026-10-15T00:00:00.000Z"), stage: "settled" });
    await store.put(makeEvent("other", ["5559990000"], "2026-10-16T00:00:00.000Z"));
    expect((await store.findActiveByPhone("(555) 123-0001"))?.id).toBe("newer");
    // The organizer is in every event, so their latest active one wins.
    expect((await store.findActiveByPhone("+15550001111"))?.id).toBe("other");
    expect(await store.findActiveByPhone("5557777777")).toBeUndefined();
    expect(await store.findActiveByPhone("garbage")).toBeUndefined();
  });

  it.each(["../escape", "a/b", "..", "", "x".repeat(65), "evt.json", "a\\b", "%2e%2e"])(
    "rejects unsafe id %j",
    async (id) => {
      const store = make();
      await expect(store.get(id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(store.put({ ...makeEvent("ok"), id })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    },
  );
});

describe("FileStore", () => {
  it("creates directories lazily and writes one JSON file per event", async () => {
    const dir = path.join(tmp, "nested", "data");
    const store = new FileStore(dir);
    expect(await store.list()).toEqual([]);
    await store.put(makeEvent("evt-1"));
    await store.putConcessions(concessions);
    expect(await readdir(path.join(dir, "events"))).toEqual(["evt-1.json"]);
    expect((await readdir(dir)).sort()).toEqual(["concessions.json", "events"]);
  });

  it("persists across instances", async () => {
    const dir = path.join(tmp, "data");
    await new FileStore(dir).put(makeEvent("evt-1"));
    expect((await new FileStore(dir).get("evt-1"))?.id).toBe("evt-1");
  });

  it("ignores stray files when listing", async () => {
    const dir = path.join(tmp, "data");
    const store = new FileStore(dir);
    await store.put(makeEvent("evt-1"));
    await mkdir(path.join(dir, "events"), { recursive: true });
    await writeFile(path.join(dir, "events", "evt-1.json.123.abcd.tmp"), "{");
    await writeFile(path.join(dir, "events", "notes.txt"), "hi");
    expect((await store.list()).map((e) => e.id)).toEqual(["evt-1"]);
  });
});

describe("createStore", () => {
  it("uses FileStore when DATA_DIR is set", () => {
    expect(createStore({ DATA_DIR: tmp })).toBeInstanceOf(FileStore);
    expect(createStore({})).toBeInstanceOf(MemoryStore);
    expect(createStore({ DATA_DIR: "  " })).toBeInstanceOf(MemoryStore);
  });
});

describe("withEventLock", () => {
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 5));

  it.each(stores)("serializes read-modify-write on %s (no lost writes)", async (_name, make) => {
    const store = make();
    await store.put(makeEvent("evt-1"));
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    await Promise.all(
      ids.map((id) =>
        updateEvent(store, "evt-1", async (e) => {
          await tick();
          return { ...e, nudgedIds: [...e.nudgedIds, id] };
        }),
      ),
    );
    const final = await store.get("evt-1");
    expect(final?.nudgedIds.sort()).toEqual([...ids].sort());
  });

  it("loses writes without the lock (sanity check for the test above)", async () => {
    const store = new MemoryStore();
    await store.put(makeEvent("evt-1"));
    await Promise.all(
      ["a", "b", "c"].map(async (id) => {
        const e = (await store.get("evt-1"))!;
        await tick();
        await store.put({ ...e, nudgedIds: [...e.nudgedIds, id] });
      }),
    );
    expect((await store.get("evt-1"))?.nudgedIds.length).toBeLessThan(3);
  });

  it("runs in order and keeps going after a failure", async () => {
    const order: string[] = [];
    const a = withEventLock("k", async () => {
      await tick();
      order.push("a");
      throw new Error("boom");
    });
    const b = withEventLock("k", async () => {
      order.push("b");
      return 2;
    });
    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe(2);
    expect(order).toEqual(["a", "b"]);
  });

  it("doesn't block different keys", async () => {
    let release!: () => void;
    const blocker = withEventLock("one", () => new Promise<void>((r) => (release = r)));
    await expect(withEventLock("two", async () => "ok")).resolves.toBe("ok");
    release();
    await blocker;
  });

  it("updateEvent throws NOT_FOUND for missing events", async () => {
    await expect(updateEvent(new MemoryStore(), "missing", (e) => e)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
