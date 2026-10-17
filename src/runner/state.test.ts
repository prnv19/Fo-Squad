import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DONE_CAP,
  FileRunnerStateStore,
  MemoryRunnerStateStore,
  OUTBOX_CAP_PER_EVENT,
  createRunnerStateStore,
  emptyRunnerState,
} from "./state.js";
import type { RunnerState } from "./types.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "fo-runner-state-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function sample(): RunnerState {
  return {
    cursors: { c1: { lastAt: "2026-10-17T18:00:00.000Z", lastIndex: 3 } },
    done: ["nudge:planning:maya"],
    foConversationByEvent: { ev1: "conv-chat-1" },
    outbox: { ev1: [{ at: "2026-10-17T18:01:00.000Z", to: "+15551230001", text: "hi" }] },
  };
}

function oversized(): RunnerState {
  const s = emptyRunnerState();
  s.done = Array.from({ length: DONE_CAP + 10 }, (_, i) => `k${i}`);
  s.outbox.ev1 = Array.from({ length: 25 }, (_, i) => ({ at: `t${i}`, to: "+15551230001", text: `m${i}` }));
  s.outbox.ev2 = [{ at: "t", to: "x", text: "only" }];
  return s;
}

describe.each([
  ["memory", () => new MemoryRunnerStateStore()],
  ["file", () => new FileRunnerStateStore(path.join(tmp, "nested", "data"))],
])("%s runner state store", (_name, make) => {
  it("starts empty", async () => {
    expect(await make().load()).toEqual(emptyRunnerState());
  });

  it("round-trips state", async () => {
    const store = make();
    await store.save(sample());
    expect(await store.load()).toEqual(sample());
  });

  it("does not share references with callers", async () => {
    const store = make();
    const s = sample();
    await store.save(s);
    s.done.push("mutated");
    const loaded = await store.load();
    loaded.done.push("also mutated");
    expect((await store.load()).done).toEqual(["nudge:planning:maya"]);
  });

  it("caps outbox per event and done, dropping the oldest", async () => {
    const store = make();
    await store.save(oversized());
    const loaded = await store.load();
    expect(loaded.done).toHaveLength(DONE_CAP);
    expect(loaded.done[0]).toBe("k10");
    expect(loaded.done.at(-1)).toBe(`k${DONE_CAP + 9}`);
    expect(loaded.outbox.ev1).toHaveLength(OUTBOX_CAP_PER_EVENT);
    expect(loaded.outbox.ev1?.[0]?.text).toBe("m5");
    expect(loaded.outbox.ev2).toHaveLength(1);
  });
});

describe("FileRunnerStateStore", () => {
  it("writes runner-state.json atomically with no temp files left", async () => {
    const store = new FileRunnerStateStore(tmp);
    await store.save(sample());
    expect(await readdir(tmp)).toEqual(["runner-state.json"]);
    expect(JSON.parse(await readFile(path.join(tmp, "runner-state.json"), "utf8"))).toEqual(sample());
  });

  it("fills in missing fields from older files", async () => {
    await writeFile(path.join(tmp, "runner-state.json"), JSON.stringify({ done: ["a"] }));
    expect(await new FileRunnerStateStore(tmp).load()).toEqual({ ...emptyRunnerState(), done: ["a"] });
  });

  it("refuses to start from a corrupt file rather than forgetting what was sent", async () => {
    await writeFile(path.join(tmp, "runner-state.json"), "{not json");
    await expect(new FileRunnerStateStore(tmp).load()).rejects.toThrow(/not valid JSON/);
  });
});

describe("createRunnerStateStore", () => {
  it("uses a file store when DATA_DIR is set, memory otherwise", () => {
    expect(createRunnerStateStore({ DATA_DIR: tmp })).toBeInstanceOf(FileRunnerStateStore);
    expect(createRunnerStateStore({ DATA_DIR: "  " })).toBeInstanceOf(MemoryRunnerStateStore);
    expect(createRunnerStateStore({})).toBeInstanceOf(MemoryRunnerStateStore);
  });
});
