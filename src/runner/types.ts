// Contracts for the headless runner: the fallback for when Fo can't call our
// MCP server directly. People only ever text Fo. The runner watches Fo's SMS
// threads through Fo's MCP server, asks Claude what to do (with our tools),
// and has Fo deliver the messages. Claude is never user-facing.

// ---------- Fo (remote MCP server at https://mcp.api.wajo.ai/fo) ----------

export type FoTurnStatus = "complete" | "working" | "failed";

export interface FoReply {
  status: FoTurnStatus;
  conversationId: string;
  /** Fo's final text. Present when complete or failed. */
  response?: string;
  /** One-line progress while working. */
  progress?: string;
}

export interface FoConversationSummary {
  conversationId: string;
  title: string;
  /** "chat" | "email" | "sms" | "whatsapp" | "telegram" | "slack" | "voice" | ... */
  channel: string;
  startedAt?: string;
}

export interface FoTurn {
  /** Who spoke. Fo's own turns are "assistant"; inbound texts are anything else. */
  role: string;
  text: string;
  at?: string;
  runId?: string;
}

export interface FoClient {
  /**
   * One Fo turn, driven to completion: ask_fo, then get_fo_reply until the
   * status isn't "working" or the timeout passes. Never call while another
   * turn on the same conversation is still working.
   */
  ask(
    message: string,
    opts?: { conversationId?: string; newConversation?: boolean; timeoutMs?: number },
  ): Promise<FoReply>;
  listConversations(): Promise<FoConversationSummary[]>;
  /** Last 40 text turns, oldest first. Images are not included. */
  getConversation(conversationId: string): Promise<{ conversation: FoConversationSummary; turns: FoTurn[] }>;
}

// ---------- What wakes the runner up ----------

export interface InboundText {
  /** Sender phone in E.164 when it can be determined, else undefined. */
  phone?: string;
  /** Raw thread title from Fo, kept for debugging and name matching. */
  threadTitle: string;
  text: string;
  at: string;
  conversationId: string;
}

export type Trigger =
  | { kind: "inbound_text"; message: InboundText; eventId?: string }
  | { kind: "deadline"; eventId: string; round: "planning" | "voting" }
  | { kind: "after_dinner"; eventId: string };

/** Deterministic, template-driven sends that don't need Claude. */
export interface ScheduledSend {
  eventId: string;
  /** Idempotency key, e.g. "nudge:planning:maya" or "pay-reminder:2:jordan". */
  key: string;
  kind: "nudge" | "day_of_reminder" | "payment_reminder";
  to: { personId: string; name: string; phone: string }[];
  text: string;
}

// ---------- Runner state (persisted next to events) ----------

export interface RunnerState {
  /** Per Fo conversation: the `at` (or index fallback) of the last turn processed. */
  cursors: Record<string, { lastAt?: string; lastIndex: number }>;
  /** Keys of ScheduledSend / trigger work already done, so restarts don't repeat it. */
  done: string[];
  /** Fo chat conversation the runner uses per event, so turns stay on topic. */
  foConversationByEvent: Record<string, string>;
  /** Short log of what was sent per event (last ~20), fed back to Claude as context. */
  outbox: Record<string, { at: string; to: string; text: string }[]>;
}

export interface RunnerStateStore {
  load(): Promise<RunnerState>;
  save(state: RunnerState): Promise<void>;
}

// ---------- The brain ----------

/**
 * Who is behind the current run. Code sets this, never the model: tool
 * wrappers inject `by_phone` from here, so a friend's text can't produce an
 * organizer approval no matter what it says.
 */
export interface RunContext {
  trigger: Trigger;
  /** Verified sender phone for inbound_text triggers; undefined for timers. */
  actorPhone?: string;
  now: Date;
}

export interface BrainResult {
  /** Plain-language log line of what happened, for stderr/ops. */
  summary: string;
  toolCalls: { name: string; ok: boolean }[];
}

export interface Brain {
  handle(ctx: RunContext): Promise<BrainResult>;
}
