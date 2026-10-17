// In-memory stand-in for Fo, used by tests and by the runner's dry-run mode,
// so nothing real gets texted while exercising the loop end to end.

import { FO_TURN_WINDOW } from "../inbox.js";
import type { FoClient, FoConversationSummary, FoReply, FoTurn } from "../types.js";

export type FakeResponder = (message: string, ctx: { conversationId: string }) => FoReply | string;

export interface FakeFoClientOptions {
  /** Scripted reply to each ask(). A string means a complete reply with that text. Default: "OK". */
  respond?: FakeResponder;
  /** Report "working" this many times before the reply completes (counted in `polls`). */
  workingPolls?: number;
  /** Shorthand for `workingPolls: 1`. */
  firstReplyWorking?: boolean;
  /** Never complete: ask() returns a "working" reply, as the real client does when its timeout passes. */
  stuckWorking?: boolean;
  /** Leave `at` off returned turns, to exercise the no-timestamp fallback. */
  omitTimestamps?: boolean;
  /** Clock for generated timestamps. Default: wall time, forced strictly increasing. */
  now?: () => Date;
}

interface FakeConversation {
  summary: FoConversationSummary;
  turns: FoTurn[];
}

export class FakeFoClient implements FoClient {
  /** Every message the runner asked Fo to act on, in order. */
  readonly asked: { message: string; conversationId: string }[] = [];
  /** Number of simulated get_fo_reply polls. */
  polls = 0;
  respond: FakeResponder;

  private readonly conversations = new Map<string, FakeConversation>();
  private readonly workingPolls: number;
  private readonly stuckWorking: boolean;
  private readonly omitTimestamps: boolean;
  private readonly clock: () => Date;
  private lastMs = 0;
  private nextId = 1;
  private currentChatId: string | undefined;

  constructor(opts: FakeFoClientOptions = {}) {
    this.respond = opts.respond ?? (() => "OK");
    this.workingPolls = opts.workingPolls ?? (opts.firstReplyWorking ? 1 : 0);
    this.omitTimestamps = opts.omitTimestamps ?? false;
    this.stuckWorking = opts.stuckWorking ?? false;
    this.clock = opts.now ?? (() => new Date());
  }

  /** Simulates a friend texting Fo. Returns the conversation id of the thread. */
  addInbound(threadTitle: string, text: string, at?: string, channel = "sms"): string {
    return this.addTurn(threadTitle, { role: "user", text, at }, channel);
  }

  /** Simulates Fo's own message appearing in a thread (e.g. a text it sent). */
  addOutbound(threadTitle: string, text: string, at?: string, channel = "sms"): string {
    return this.addTurn(threadTitle, { role: "assistant", text, at }, channel);
  }

  /** All turns of a conversation, unwindowed, for assertions. */
  allTurns(conversationId: string): FoTurn[] {
    return structuredClone(this.require(conversationId).turns);
  }

  async ask(
    message: string,
    opts: { conversationId?: string; newConversation?: boolean; timeoutMs?: number } = {},
  ): Promise<FoReply> {
    if (opts.conversationId && opts.newConversation) {
      throw new Error("Pass either conversationId or newConversation, not both.");
    }
    let conv: FakeConversation;
    if (opts.conversationId) {
      conv = this.require(opts.conversationId);
    } else if (opts.newConversation || !this.currentChatId) {
      conv = this.create(`Chat ${this.nextId}`, "chat");
    } else {
      conv = this.require(this.currentChatId);
    }
    if (conv.summary.channel === "chat") this.currentChatId = conv.summary.conversationId;
    const conversationId = conv.summary.conversationId;
    this.asked.push({ message, conversationId });
    conv.turns.push({ role: "user", text: message, at: this.stamp() });

    this.polls += this.workingPolls;
    if (this.stuckWorking) {
      this.polls++;
      return { status: "working", conversationId, progress: "Working for 15m 0s: 3 tool calls so far" };
    }

    const scripted = this.respond(message, { conversationId });
    const reply: FoReply =
      typeof scripted === "string" ? { status: "complete", conversationId, response: scripted } : { ...scripted, conversationId };
    if (reply.response !== undefined) conv.turns.push({ role: "assistant", text: reply.response, at: this.stamp() });
    return reply;
  }

  async listConversations(): Promise<FoConversationSummary[]> {
    // Newest activity first, like Fo; at most 50.
    return [...this.conversations.values()]
      .sort((a, b) => lastActivity(b) - lastActivity(a))
      .slice(0, 50)
      .map((c) => ({ ...c.summary }));
  }

  async getConversation(conversationId: string): Promise<{ conversation: FoConversationSummary; turns: FoTurn[] }> {
    const conv = this.require(conversationId);
    const turns = conv.turns.slice(-FO_TURN_WINDOW).map((t) => {
      const copy = { ...t };
      if (this.omitTimestamps) delete copy.at;
      return copy;
    });
    return { conversation: { ...conv.summary }, turns };
  }

  private addTurn(threadTitle: string, turn: FoTurn, channel: string): string {
    let conv = [...this.conversations.values()].find(
      (c) => c.summary.title === threadTitle && c.summary.channel === channel,
    );
    conv ??= this.create(threadTitle, channel);
    conv.turns.push({ ...turn, at: turn.at ?? this.stamp() });
    return conv.summary.conversationId;
  }

  private create(title: string, channel: string): FakeConversation {
    const conversationId = `fake-conv-${this.nextId++}`;
    const conv: FakeConversation = {
      summary: { conversationId, title, channel, startedAt: this.stamp() },
      turns: [],
    };
    this.conversations.set(conversationId, conv);
    return conv;
  }

  private require(conversationId: string): FakeConversation {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error(`No conversation with id "${conversationId}".`);
    return conv;
  }

  private stamp(): string {
    this.lastMs = Math.max(this.clock().getTime(), this.lastMs + 1);
    return new Date(this.lastMs).toISOString();
  }
}

function lastActivity(c: FakeConversation): number {
  const at = c.turns.at(-1)?.at ?? c.summary.startedAt;
  return at ? Date.parse(at) : 0;
}
