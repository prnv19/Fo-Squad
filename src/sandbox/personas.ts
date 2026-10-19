// Decides which scripted reply (if any) a simulated person sends, from the
// text Fo just sent them. Matching is plain ordered regexes over Fo's wording,
// which follows the playbook's templates closely, plus the dinner's stage for
// the organizer so a "?" in a booking question can't read as a list check.
//
// Friend rules, first match wins:
//   payment      "your share", "pay here", "venmo", "you owe", "friendly reminder"
//   confirm      "just to check", "double-check", "to confirm", "is that right", "did you mean", "right?"
//   claims       "what you had", "numbers of what", "which items", "what did you have", "reply with the numbers"
//   unclaimed    "did anyone have", "anyone have"
//   vote         "vote", "reply with a number", "which spot", "pick a spot"
//   availability "which times", "what times", "times work", "A)", "any food", "dietary"
//   booked       "booked", "see you there"
//   reminder     "tonight", "reminder"
//   cant_make    "landed on", "doesn't work for you", "miss you"
//   plan_locked  "plan is set", "locked"
//   other        anything else (no reply)
//
// The organizer answers questions, not keywords. Fo's text is split into
// sentences, and a rule only matches a QUESTION sentence (one ending in "?",
// read together with the sentence just before it, which often carries the
// topic: "They need a $50 deposit. OK to pay it?"), or an explicit request
// phrased without one ("Reply with a number.", "text me a photo of the
// receipt"). Status updates ("Got your vote... Still waiting on Maya", "there
// aren't any totals to send yet") match nothing and get no reply.
//
// Organizer rules, first match wins (stage = the dinner's stage, none before create_event).
// "Q:" = must appear in a question sentence; "req:" = a request anywhere in the text.
//   details          no dinner yet; any question or request. One-shot, re-ask: a question for numbers/phones/times/Venmo
//   injection_report text mentions "ignore ... instructions", "mark everyone/everybody/all", "set ... $0", "prompt injection", and asks a question
//   settled          "night complete", "everyone's paid" (classified only; no reply)
//   totals           claiming/paying; at least two "Name $12.34" amounts (scenario names), and the text ends with a
//                    question or asks about sending/approving ("Send?"). Once per distinct set of totals.
//   attendees        claiming; Q: "make it", "came", "were there", "who was there", "attend"
//   claims           claiming; Q: "what did you have", "which items"; req: "reply with the numbers", "tell me what you had"
//   unclaimed        claiming; text says an item is unclaimed ("unclaimed", "nobody/no one claimed") AND names a specific
//                    item ("8)", "item 8", "#8" or a receipt item) AND Q: "split", "assign", "evenly", "who had", "whose".
//                    Never while a friend is still inside their scripted claim-reply window (below).
//   deposit          planning/voting; Q: "deposit", "card hold", "no-show fee"
//   book             planning/voting; Q: "book". One-shot with re-ask
//   change_booking   booked; Q: "update", "change", "party size", "reservation", "cancel"
//   confirm_list     planning; Q: "look right", "sound right", "look good", "sound good", "correct?", "right?". One-shot with re-ask
//   venmo            planning; Q: "venmo"
//   vote             voting; Q: "vote", "which spot"; req: "reply with a number", "your vote:". Strictly once
//   new_times        planning; Q: "new times/options", "other times", "different times", "no time works"
//   receipt_request  Q: "receipt", "the bill"; req: "send/text/snap ... receipt/bill". One-shot with re-ask
//   other            anything else (no reply)
//
// One-shot with re-ask: after the persona has answered, the same kind of ask
// gets another answer only when Fo asks the same question again, meaning the
// first answer was lost: the question sentences overlap the answered one (word
// Jaccard >= 0.6), or Fo says it is asking again ("again", "resend", "didn't
// get", "still need"), or the rule's own re-ask test matches (details).
// A one-shot ask that doesn't qualify is returned as `other` with `skipped`.
//
// Claim-reply window: when a friend's scripted claims reply is planned, the
// window is open until that reply is due (if the caller passes `now`), or,
// without a clock, until Fo texts that friend anything other than the item list
// again (Fo only does that after hearing back: a check, a thanks, "did anyone
// have 8)?"). The organizer won't answer an unclaimed-item question while any
// window is open.

import type { FriendAsk, OrganizerAsk, ReplyRule, Scenario, ScriptedReply } from "./scenario.js";

const FRIEND_RULES: [FriendAsk, RegExp][] = [
  ["payment", /your share|pay here|venmo|you owe|friendly reminder/i],
  ["confirm", /just to check|double[- ]check|to confirm|is that right|did you mean|right\?/i],
  ["claims", /what you had|numbers of what|which items|what did you have|reply with the numbers/i],
  ["unclaimed", /did anyone have|anyone have/i],
  ["vote", /\bvote\b|reply with a number|which spot|pick a spot/i],
  ["availability", /which times|what times|times work|\bA\)|any food|dietary/i],
  ["booked", /\bbooked\b|see you there/i],
  ["reminder", /tonight|reminder/i],
  ["cant_make", /landed on|doesn'?t work for you|miss you/i],
  ["plan_locked", /plan is set|locked/i],
];

export function classifyFriendText(text: string): FriendAsk {
  return FRIEND_RULES.find(([, re]) => re.test(text))?.[0] ?? "other";
}

// ---------- organizer ----------

type StageName = "planning" | "voting" | "booked" | "claiming" | "paying" | "settled";

/** Names and receipt items the organizer matchers can refer to. */
export interface OrganizerContext {
  /** People's first names; a totals proposal pairs these with dollar amounts. */
  people?: string[];
  /** Receipt item descriptions, so "the Tiramisu" counts as a specific item. */
  items?: string[];
}

type Once = "strict" | "reask";

interface OrganizerRule {
  kind: OrganizerAsk;
  stages?: StageName[];
  /** Tested against each question sentence. */
  ask?: RegExp;
  /** Tested against the whole text: an explicit request phrased without a "?". */
  request?: RegExp;
  /** Custom test over the whole text (replaces ask/request). */
  match?: (text: string, ctx: OrganizerContext) => boolean;
  once?: Once;
  /** For "reask" rules: a question that counts as asking the same thing again. */
  reask?: RegExp;
}

/** Sentences of `text`, split at . ! ? (plus any closing quote or bracket) and at line breaks. */
function sentences(text: string): string[] {
  return text
    .split(/\n+|\s+\/\s+|(?<=[.!?]["'”’)\]]*)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const QUESTION_END = /\?["'”’)\]]*$/;

export function questionSentences(text: string): string[] {
  return sentences(text).filter((s) => QUESTION_END.test(s));
}

/** Each question sentence together with the sentence just before it, which often carries the topic ("$50 deposit. OK to pay it?"). */
function questionUnits(text: string): string[] {
  const all = sentences(text);
  return all.flatMap((s, i) => {
    if (!QUESTION_END.test(s)) return [];
    const before = all[i - 1];
    return [before && !QUESTION_END.test(before) ? `${before} ${s}` : s];
  });
}

function endsWithQuestion(text: string): boolean {
  return QUESTION_END.test(sentences(text).at(-1) ?? "");
}

const AMOUNT_WITH_NAME = /(?<!\d\)\s*)\b(?!(?:Total|Subtotal|Tax|Tip)\b)([A-Z][a-z]+)(?:'s)?(?: (?:owes|pays|gets|is))?:? \$(\d+(?:\.\d{2})?)/g;

/** "maya:26.88|jordan:47.36" for each "Name $amount" in the text, or undefined with fewer than two. */
export function totalsKey(text: string, people?: string[]): string | undefined {
  const known = people?.map((p) => p.toLowerCase());
  const pairs = new Set<string>();
  for (const m of text.matchAll(AMOUNT_WITH_NAME)) {
    const name = m[1]!.toLowerCase();
    if (known && !known.includes(name)) continue;
    pairs.add(`${name}:${Number(m[2]).toFixed(2)}`);
  }
  return pairs.size >= 2 ? [...pairs].sort().join("|") : undefined;
}

function isTotalsProposal(text: string, ctx: OrganizerContext): boolean {
  if (!totalsKey(text, ctx.people)) return false;
  return endsWithQuestion(text) || questionSentences(text).some((q) => /\bsend\b|approve|\bok\b|okay|go ahead/i.test(q));
}

const UNCLAIMED_CONTEXT = /unclaimed|(?:nobody|no one|no-one)(?: has)? (?:claimed|had)|not claimed|hasn'?t been claimed|left ?over/i;
const UNCLAIMED_QUESTION = /split|assign|evenly|who (?:had|gets|should|pays)|whose|cover|what (?:should|do|would) (?:i|we|you) do/i;
const ITEM_NUMBER = /\bitem\s*#?\d+\b|#\d+\b|\b\d+\)\s*[A-Za-z]/i;

function asksAboutUnclaimedItem(text: string, ctx: OrganizerContext): boolean {
  if (!UNCLAIMED_CONTEXT.test(text)) return false;
  const lower = text.toLowerCase();
  const namesItem = ITEM_NUMBER.test(text) || (ctx.items ?? []).some((item) => lower.includes(item.toLowerCase()));
  return namesItem && questionSentences(text).some((q) => UNCLAIMED_QUESTION.test(q));
}

const ORGANIZER_RULES: OrganizerRule[] = [
  {
    kind: "injection_report",
    match: (text) =>
      /ignore (?:\w+ )?instructions|mark (?:everyone|everybody|all)|set (?:his|my|their|\w+'s) total to \$0|prompt injection/i.test(text) && questionSentences(text).length > 0,
  },
  { kind: "settled", match: (text) => /night complete|everyone'?s paid|totals sent/i.test(text) },
  { kind: "totals", stages: ["claiming", "paying"], match: isTotalsProposal },
  { kind: "attendees", stages: ["claiming"], ask: /make it|\bcame\b|were there|who was there|attend/i },
  {
    kind: "claims",
    stages: ["claiming"],
    ask: /what (?:did )?you (?:had|have)|which items|which ones were yours|numbers of what/i,
    request: /reply with (?:the )?numbers|(?:tell|send) me what you had|let me know what you had/i,
  },
  { kind: "unclaimed", stages: ["claiming"], match: asksAboutUnclaimedItem },
  { kind: "deposit", stages: ["planning", "voting"], ask: /deposit|card hold|no-show fee/i },
  { kind: "book", stages: ["planning", "voting"], ask: /\bbook\b/i, once: "reask" },
  { kind: "change_booking", stages: ["booked"], ask: /update|change|party size|reservation|cancel/i },
  {
    kind: "confirm_list",
    stages: ["planning"],
    ask: /look right|sound right|look good|sound good|correct\?|right\?/i,
    once: "reask",
  },
  { kind: "venmo", stages: ["planning"], ask: /venmo/i },
  {
    kind: "vote",
    stages: ["voting"],
    ask: /\bvote\b|which spot/i,
    request: /reply with (?:a|the|your) number|your vote:/i,
    once: "strict",
  },
  { kind: "new_times", stages: ["planning"], ask: /new (?:times|options)|other times|different times|no time works/i },
  {
    kind: "receipt_request",
    ask: /receipt|the bill/i,
    request: /\b(?:send|text|snap|share|forward)\b[^.!?]{0,30}\b(?:receipt|bill)\b/i,
    once: "reask",
  },
];

const DETAILS_RULE: OrganizerRule = {
  kind: "details",
  match: (text) => questionSentences(text).length > 0 || /\b(?:send|text|tell|give|share) me\b|let me know/i.test(text),
  once: "reask",
  reask: /number|phone|times?\b|venmo/i,
};

function ruleMatches(rule: OrganizerRule, text: string, ctx: OrganizerContext): boolean {
  if (rule.match) return rule.match(text, ctx);
  if (rule.request?.test(text)) return true;
  const ask = rule.ask;
  return !!ask && questionUnits(text).some((q) => ask.test(q));
}

function findOrganizerRule(text: string, stage: string | undefined, ctx: OrganizerContext): OrganizerRule | undefined {
  if (!stage) return ruleMatches(DETAILS_RULE, text, ctx) ? DETAILS_RULE : undefined;
  return ORGANIZER_RULES.find(
    (rule) => (!rule.stages || rule.stages.includes(stage as StageName)) && ruleMatches(rule, text, ctx),
  );
}

export function classifyOrganizerText(text: string, stage: string | undefined, ctx: OrganizerContext = {}): OrganizerAsk {
  return findOrganizerRule(text, stage, ctx)?.kind ?? "other";
}

const REASK_CUE = /\bagain\b|\bre-?send|didn'?t (?:get|see|catch|come through)|never (?:got|came|heard)|still need|in case you missed|got lost/i;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

/** The part of a text a re-ask is compared on: its question sentences, or the whole text for a request. */
function questionPart(text: string): string {
  const qs = questionSentences(text);
  return qs.length ? qs.join(" ") : text;
}

function isReask(rule: OrganizerRule, text: string, answered: string[]): boolean {
  if (REASK_CUE.test(text)) return true;
  const reask = rule.reask;
  if (reask && questionSentences(text).some((q) => reask.test(q))) return true;
  const now = words(questionPart(text));
  return answered.some((prev) => overlap(now, words(questionPart(prev))) >= 0.6);
}

// ---------- the responder ----------

export interface PlannedReply extends ScriptedReply {
  personId: string;
}

export interface FriendDecision {
  ask: FriendAsk;
  replies: PlannedReply[];
  /** Persona note to show once (first ask of this kind). */
  note?: string;
}

export interface OrganizerDecision {
  ask: OrganizerAsk;
  reply?: string;
  /** Set when a matching ask was deliberately not answered (returned as `other`): why. */
  skipped?: string;
}

/**
 * Remembers what each persona was asked and answered, so "reply only to the nudge",
 * one-shot organizer answers and the claim-reply window work.
 */
export class PersonaResponder {
  private readonly askCounts = new Map<string, number>();
  /** Organizer asks already answered, with the texts that asked them. */
  private readonly answered = new Map<OrganizerAsk, string[]>();
  private readonly totalsAnswered = new Set<string>();
  /** Friends whose scripted claims reply is planned and may not have arrived yet; value = due time (ms) when known. */
  private readonly claimWindows = new Map<string, number | undefined>();
  private readonly ctx: OrganizerContext;

  constructor(private readonly scenario: Scenario) {
    this.ctx = {
      people: [scenario.organizer, ...scenario.friends].map((p) => p.name),
      items: scenario.receipt.items.map((i) => i.description),
    };
  }

  /** `now` (simulated) lets the claim-reply window close on time rather than on Fo's next text to that friend. */
  friendReply(personId: string, text: string, now?: Date): FriendDecision {
    const ask = classifyFriendText(text);
    if (ask !== "claims" && this.claimWindows.has(personId)) this.claimWindows.delete(personId);
    const friend = this.scenario.friends.find((f) => f.id === personId);
    const rule: ReplyRule | undefined = friend?.script[ask];
    const key = `${personId}:${ask}`;
    const count = (this.askCounts.get(key) ?? 0) + 1;
    this.askCounts.set(key, count);
    if (!rule) return { ask, replies: [] };
    const onAsk = rule.onAsk ?? 1;
    const fires = onAsk === "every" || onAsk === count;
    if (fires && ask === "claims" && rule.replies.length) {
      const lastMinutes = Math.max(...rule.replies.map((r) => r.afterMinutes));
      this.claimWindows.set(personId, now ? now.getTime() + lastMinutes * 60_000 : undefined);
    }
    return {
      ask,
      replies: fires ? rule.replies.map((r) => ({ ...r, personId })) : [],
      ...(count === 1 && rule.note ? { note: rule.note } : {}),
    };
  }

  /** Friends still inside their scripted claim-reply window. */
  friendsStillReplying(now?: Date): string[] {
    return [...this.claimWindows]
      .filter(([, dueAt]) => dueAt === undefined || !now || now.getTime() < dueAt)
      .map(([id]) => id);
  }

  organizerReply(text: string, stage: string | undefined, now?: Date): OrganizerDecision {
    const rule = findOrganizerRule(text, stage, this.ctx);
    if (!rule) return { ask: "other" };
    const ask = rule.kind;
    const skip = (why: string): OrganizerDecision => ({ ask: "other", skipped: `${ask}: ${why}` });

    if (ask === "unclaimed") {
      const waiting = this.friendsStillReplying(now);
      if (waiting.length) return skip(`still waiting on ${waiting.join(", ")}'s scripted claims`);
    }
    if (ask === "totals") {
      const key = totalsKey(text, this.ctx.people)!;
      if (this.totalsAnswered.has(key)) return skip("these totals were already approved");
      this.totalsAnswered.add(key);
    }
    const prior = this.answered.get(ask);
    if (prior && rule.once === "strict") return skip("already answered");
    if (prior && rule.once === "reask" && !isReask(rule, text, prior)) return skip("already answered, and this isn't the same question again");
    if (rule.once) this.answered.set(ask, [...(prior ?? []), text]);

    const reply = this.scenario.organizer.replies[ask];
    return reply ? { ask, reply } : { ask };
  }
}
