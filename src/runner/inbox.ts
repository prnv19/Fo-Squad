// Turns Fo's conversation list into "new texts since last time".
//
// Assumptions about Fo's data (verify on a real account):
// - Fo's own turns have role "assistant" (or "fo"); "system" turns are not
//   texts either. Every other role is treated as an inbound text.
// - get_fo_conversation returns the last 40 text turns, oldest first, so a
//   busy thread's window slides and indices aren't stable once it's full.
// - A 1:1 SMS thread's title is the other person's number or contact name.

import { tryNormalizePhone } from "../events/people.js";
import type { FoClient, FoTurn, InboundText, RunnerState } from "./types.js";

type Cursor = RunnerState["cursors"][string];

/** get_fo_conversation returns at most this many turns. */
export const FO_TURN_WINDOW = 40;

/**
 * The contract's cursor plus the trailing turns we last saw, used to find our
 * place when Fo gives no timestamps. Stored in the same JSON object; the
 * extra field survives the state stores' JSON round trip.
 */
interface InboxCursor extends Cursor {
  tail?: string[];
}

const TAIL_LENGTH = 3;
const FO_ROLES = new Set(["assistant", "fo", "system"]);

export interface PollInboxOptions {
  /** Channels to watch. Default ["sms"]. */
  channels?: string[];
  /** Sender phone for a thread. Default: the single phone number in the title, if any. */
  resolvePhone?: (title: string, turns: FoTurn[]) => string | undefined;
  /** For InboundText.at when a turn has no timestamp. */
  now?: () => Date;
  /** Diagnostics (skipped conversations, cursor resyncs). */
  log?: (message: string) => void;
}

export function isFoTurn(turn: FoTurn): boolean {
  return FO_ROLES.has(turn.role.trim().toLowerCase());
}

/**
 * The phone number in a thread title, when there is exactly one. Group
 * threads list several numbers, and the sender can't be told from the title.
 */
export function phoneFromTitle(title: string): string | undefined {
  const found = new Set<string>();
  for (const match of title.matchAll(/\+?\d[\d\s().-]{5,}\d/g)) {
    const phone = tryNormalizePhone(match[0]);
    if (phone) found.add(phone);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

function tailKey(turn: FoTurn): string {
  return `${turn.role}\u0000${turn.text}`;
}

function cursorAtEnd(turns: FoTurn[]): InboxCursor {
  const last = turns.at(-1);
  const cursor: InboxCursor = { lastIndex: turns.length - 1, tail: turns.slice(-TAIL_LENGTH).map(tailKey) };
  if (last?.at) cursor.lastAt = last.at;
  return cursor;
}

function timeOf(at: string): number {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? NaN : ms;
}

function isAfter(at: string, lastAt: string): boolean {
  const a = timeOf(at);
  const b = timeOf(lastAt);
  return Number.isNaN(a) || Number.isNaN(b) ? at > lastAt : a > b;
}

/** Latest index whose preceding turns match the stored tail (a shorter match is fine at the window's start). */
function findByTail(turns: FoTurn[], tail: string[]): number | undefined {
  if (tail.length === 0) return undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    let ok = true;
    for (let j = 0; j < tail.length && i - j >= 0; j++) {
      const turn = turns[i - j];
      if (!turn || tailKey(turn) !== tail[tail.length - 1 - j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return undefined;
}

/**
 * Index of the first unprocessed turn, or undefined when our place is lost
 * (the caller then resyncs to the end rather than replaying the window).
 */
function firstNewIndex(turns: FoTurn[], cursor: InboxCursor): number | undefined {
  if (cursor.lastAt) {
    const lastAt = cursor.lastAt;
    // Several turns can share a timestamp, so prefer the one whose text matches too.
    const sameAt = turns.flatMap((t, i) => (t.at === lastAt ? [i] : []));
    if (sameAt.length > 0) {
      const lastKey = cursor.tail?.at(-1);
      const exact = sameAt.filter((i) => lastKey !== undefined && tailKey(turns[i]!) === lastKey).at(-1);
      return (exact ?? sameAt.at(-1)!) + 1;
    }
    // The cursor turn slid out of the window: everything after it by time is new.
    const idx = turns.findIndex((t) => t.at !== undefined && isAfter(t.at, lastAt));
    return idx === -1 ? turns.length : idx;
  }

  // No timestamps: find the last processed turn by its trailing text.
  const byTail = cursor.tail ? findByTail(turns, cursor.tail) : undefined;
  if (byTail !== undefined) return byTail + 1;
  // Indices only stay valid while the window hasn't filled up and started sliding.
  if (turns.length < FO_TURN_WINDOW && cursor.lastIndex < turns.length && !cursor.tail?.length) {
    return cursor.lastIndex + 1;
  }
  return undefined;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * New inbound texts on the watched channels since the last poll, oldest first,
 * plus the advanced state (the input state is not modified).
 *
 * A conversation seen for the first time only gets a cursor at its end, so a
 * fresh deploy doesn't replay old history. A conversation that fails to load
 * is skipped and keeps its cursor, so it's retried next poll.
 */
export async function pollInbox(
  fo: FoClient,
  state: RunnerState,
  opts: PollInboxOptions = {},
): Promise<{ messages: InboundText[]; state: RunnerState }> {
  const channels = new Set((opts.channels ?? ["sms"]).map((c) => c.toLowerCase()));
  const resolvePhone = opts.resolvePhone ?? ((title: string) => phoneFromTitle(title));
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});

  const next = structuredClone(state);
  const watched = (await fo.listConversations()).filter((c) => channels.has(c.channel.toLowerCase()));

  const results = await mapLimit(watched, 4, async (summary) => {
    try {
      return { summary, data: await fo.getConversation(summary.conversationId) };
    } catch (err) {
      log(`Skipping conversation ${summary.conversationId}: ${(err as Error).message}`);
      return undefined;
    }
  });

  const messages: { msg: InboundText; order: number }[] = [];
  let order = 0;
  for (const result of results) {
    if (!result) continue;
    const id = result.summary.conversationId;
    const turns = result.data.turns;
    const title = result.data.conversation?.title ?? result.summary.title;
    const cursor = next.cursors[id] as InboxCursor | undefined;

    if (!cursor) {
      next.cursors[id] = cursorAtEnd(turns);
      continue;
    }
    if (turns.length === 0) continue;

    const start = firstNewIndex(turns, cursor);
    if (start === undefined) {
      log(`Lost my place in conversation ${id}; skipping to its latest turn without replaying.`);
      next.cursors[id] = cursorAtEnd(turns);
      continue;
    }

    const fresh = turns.slice(start).filter((t) => !isFoTurn(t) && t.text.trim() !== "");
    if (fresh.length > 0) {
      const phone = resolvePhone(title, turns);
      const fallbackAt = now().toISOString();
      for (const turn of fresh) {
        const msg: InboundText = { threadTitle: title, text: turn.text, at: turn.at ?? fallbackAt, conversationId: id };
        if (phone) msg.phone = phone;
        messages.push({ msg, order: order++ });
      }
    }
    next.cursors[id] = cursorAtEnd(turns);
  }

  messages.sort((a, b) => {
    const diff = timeOf(a.msg.at) - timeOf(b.msg.at);
    return Number.isNaN(diff) || diff === 0 ? a.order - b.order : diff;
  });
  return { messages: messages.map((m) => m.msg), state: next };
}
