import { describe, expect, it } from "vitest";
import { FakeFoClient } from "./fo/fake.js";
import { FO_TURN_WINDOW, phoneFromTitle, pollInbox } from "./inbox.js";
import { emptyRunnerState } from "./state.js";
import type { FoClient, RunnerState } from "./types.js";

function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 17, 18, minute)).toISOString();
}

describe("pollInbox", () => {
  it("does not replay history on first sight, then emits new turns exactly once", async () => {
    const fo = new FakeFoClient();
    fo.addInbound("+1 (555) 123-0001", "old message", at(0));
    fo.addOutbound("+1 (555) 123-0001", "old reply", at(1));

    const first = await pollInbox(fo, emptyRunnerState());
    expect(first.messages).toEqual([]);
    expect(Object.keys(first.state.cursors)).toHaveLength(1);

    const id = fo.addInbound("+1 (555) 123-0001", "I'm in for Saturday", at(2));
    const second = await pollInbox(fo, first.state);
    expect(second.messages).toEqual([
      { phone: "+15551230001", threadTitle: "+1 (555) 123-0001", text: "I'm in for Saturday", at: at(2), conversationId: id },
    ]);

    const third = await pollInbox(fo, second.state);
    expect(third.messages).toEqual([]);
  });

  it("does not mutate the input state", async () => {
    const fo = new FakeFoClient();
    fo.addInbound("Maya", "hi", at(0));
    const state = emptyRunnerState();
    const snapshot = structuredClone(state);
    await pollInbox(fo, state);
    expect(state).toEqual(snapshot);
  });

  it("skips Fo's own turns but advances past them", async () => {
    const fo = new FakeFoClient();
    fo.addInbound("Maya", "hi", at(0));
    const { state } = await pollInbox(fo, emptyRunnerState());

    fo.addOutbound("Maya", "Want Thai or sushi?", at(1));
    fo.addInbound("Maya", "thai", at(2));
    fo.addOutbound("Maya", "Got it", at(3));
    const r1 = await pollInbox(fo, state);
    expect(r1.messages.map((m) => m.text)).toEqual(["thai"]);

    fo.addOutbound("Maya", "Reminder: dinner at 7", at(4));
    const r2 = await pollInbox(fo, r1.state);
    expect(r2.messages).toEqual([]);
  });

  it("treats a conversation that starts empty as new from its first turn", async () => {
    const fo: FoClient = {
      ask: async () => ({ status: "complete", conversationId: "c" }),
      listConversations: async () => [{ conversationId: "c", title: "Jordan", channel: "sms" }],
      getConversation: async () => ({ conversation: { conversationId: "c", title: "Jordan", channel: "sms" }, turns }),
    };
    let turns: { role: string; text: string; at?: string }[] = [];
    const first = await pollInbox(fo, emptyRunnerState());
    turns = [{ role: "user", text: "hey", at: at(1) }];
    const second = await pollInbox(fo, first.state);
    expect(second.messages.map((m) => m.text)).toEqual(["hey"]);
  });

  it("ignores non-sms channels unless asked", async () => {
    const fo = new FakeFoClient();
    fo.addInbound("Maya", "seed", at(0));
    fo.addInbound("maya@example.com", "seed", at(0), "email");
    await fo.ask("plan dinner"); // creates a chat conversation
    const { state } = await pollInbox(fo, emptyRunnerState());
    expect(Object.keys(state.cursors)).toHaveLength(1);

    fo.addInbound("Maya", "sms text", at(5));
    fo.addInbound("maya@example.com", "email text", at(5), "email");
    await fo.ask("another chat");
    const r = await pollInbox(fo, state);
    expect(r.messages.map((m) => m.text)).toEqual(["sms text"]);

    const both = await pollInbox(fo, emptyRunnerState(), { channels: ["sms", "email"] });
    expect(Object.keys(both.state.cursors)).toHaveLength(2);
  });

  it("returns messages oldest first across conversations", async () => {
    const fo = new FakeFoClient();
    fo.addInbound("Maya", "seed", at(0));
    fo.addInbound("Jordan", "seed", at(0));
    const { state } = await pollInbox(fo, emptyRunnerState());
    fo.addInbound("Maya", "maya 1", at(1));
    fo.addInbound("Jordan", "jordan 2", at(2));
    fo.addInbound("Maya", "maya 3", at(3));
    const r = await pollInbox(fo, state);
    expect(r.messages.map((m) => m.text)).toEqual(["maya 1", "jordan 2", "maya 3"]);
  });

  it("handles the 40-turn window sliding past the cursor (timestamps)", async () => {
    const fo = new FakeFoClient();
    for (let i = 0; i < FO_TURN_WINDOW; i++) fo.addInbound("Maya", `old ${i}`, at(i));
    const { state } = await pollInbox(fo, emptyRunnerState());

    // 45 new turns: the last processed turn is no longer in the window.
    for (let i = 0; i < 45; i++) fo.addInbound("Maya", `new ${i}`, at(100 + i));
    const r = await pollInbox(fo, state);
    expect(r.messages).toHaveLength(FO_TURN_WINDOW);
    expect(r.messages[0]?.text).toBe("new 5");
    expect(r.messages.at(-1)?.text).toBe("new 44");

    fo.addInbound("Maya", "after", at(200));
    const r2 = await pollInbox(fo, r.state);
    expect(r2.messages.map((m) => m.text)).toEqual(["after"]);
  });

  it("finds its place by trailing text when there are no timestamps, even as the window slides", async () => {
    const fo = new FakeFoClient({ omitTimestamps: true });
    for (let i = 0; i < FO_TURN_WINDOW; i++) fo.addInbound("Maya", `old ${i}`);
    const { state } = await pollInbox(fo, emptyRunnerState());
    expect(state.cursors[Object.keys(state.cursors)[0]!]?.lastAt).toBeUndefined();

    fo.addInbound("Maya", "ok");
    fo.addOutbound("Maya", "Noted");
    fo.addInbound("Maya", "ok");
    const r = await pollInbox(fo, state);
    expect(r.messages.map((m) => m.text)).toEqual(["ok", "ok"]);
    expect(r.messages[0]?.at).toBeTruthy();

    fo.addInbound("Maya", "ok");
    const r2 = await pollInbox(fo, r.state);
    expect(r2.messages.map((m) => m.text)).toEqual(["ok"]);
    expect((await pollInbox(fo, r2.state)).messages).toEqual([]);
  });

  it("resyncs without replaying when it can't find its place", async () => {
    const fo = new FakeFoClient({ omitTimestamps: true });
    for (let i = 0; i < FO_TURN_WINDOW; i++) fo.addInbound("Maya", `old ${i}`);
    const { state } = await pollInbox(fo, emptyRunnerState());
    for (let i = 0; i < FO_TURN_WINDOW + 5; i++) fo.addInbound("Maya", `new ${i}`);
    const logs: string[] = [];
    const r = await pollInbox(fo, state, { log: (m) => logs.push(m) });
    expect(r.messages).toEqual([]);
    expect(logs[0]).toMatch(/Lost my place/);
    fo.addInbound("Maya", "next");
    expect((await pollInbox(fo, r.state)).messages.map((m) => m.text)).toEqual(["next"]);
  });

  it("resolves the phone from the title, or leaves it for the runner to match by name", async () => {
    const fo = new FakeFoClient();
    fo.addInbound("+15551230002", "seed", at(0));
    fo.addInbound("Maya Chen", "seed", at(0));
    const { state } = await pollInbox(fo, emptyRunnerState());
    fo.addInbound("+15551230002", "from number", at(1));
    fo.addInbound("Maya Chen", "from name", at(2));
    const r = await pollInbox(fo, state);
    expect(r.messages[0]).toMatchObject({ text: "from number", phone: "+15551230002" });
    expect(r.messages[1]?.text).toBe("from name");
    expect(r.messages[1]).not.toHaveProperty("phone");

    const custom = await pollInbox(fo, state, { resolvePhone: (title) => (title === "Maya Chen" ? "+15551230003" : undefined) });
    expect(custom.messages.find((m) => m.text === "from name")?.phone).toBe("+15551230003");
  });

  it("skips a conversation that fails to load and keeps its cursor", async () => {
    const fo = new FakeFoClient();
    const id = fo.addInbound("Maya", "seed", at(0));
    const { state } = await pollInbox(fo, emptyRunnerState());
    fo.addInbound("Maya", "new", at(1));
    const broken: FoClient = { ...fo, ask: fo.ask.bind(fo), listConversations: () => fo.listConversations(), getConversation: async () => { throw new Error("boom"); } };
    const r = await pollInbox(broken, state, { log: () => {} });
    expect(r.messages).toEqual([]);
    expect(r.state.cursors[id]).toEqual(state.cursors[id]);
    expect((await pollInbox(fo, r.state)).messages.map((m) => m.text)).toEqual(["new"]);
  });

  it("keeps cursors for conversations it has no new turns for", async () => {
    const fo = new FakeFoClient();
    fo.addInbound("Maya", "seed", at(0));
    const state: RunnerState = (await pollInbox(fo, emptyRunnerState())).state;
    const again = await pollInbox(fo, state);
    expect(again.state.cursors).toEqual(state.cursors);
  });
});

describe("phoneFromTitle", () => {
  it("finds a single phone number", () => {
    expect(phoneFromTitle("+15551230001")).toBe("+15551230001");
    expect(phoneFromTitle("(555) 123-0001")).toBe("+15551230001");
    expect(phoneFromTitle("Maya +1 555 123 0001")).toBe("+15551230001");
  });

  it("returns undefined for names and group threads", () => {
    expect(phoneFromTitle("Maya Chen")).toBeUndefined();
    expect(phoneFromTitle("+15551230001, +15551230002")).toBeUndefined();
    expect(phoneFromTitle("Dinner 2026")).toBeUndefined();
  });
});
