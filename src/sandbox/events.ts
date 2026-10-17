// Sandbox event stream: everything that happens in a simulated dinner, in
// order. The engine emits these; the live viewer, the terminal printer and
// the saved replay all render from the same list.

export type PhoneId = string; // "fo", "restaurant", or a person id ("pranav", "maya", ...)

export type SandboxEvent =
  | {
      type: "run_started";
      at: string;
      scenario: string;
      people: { id: PhoneId; name: string; role: "organizer" | "friend" }[];
      /** IANA zone of the scenario, so the viewer shows Denver times regardless of the browser's zone. */
      timeZone?: string;
    }
  /** Simulated clock moved forward. `at` is simulated time throughout. */
  | { type: "clock"; at: string }
  /** A text on someone's phone. Fo is always one side. */
  | { type: "text"; at: string; from: PhoneId; to: PhoneId; text: string }
  /** A Fo Squad MCP tool call made by the coordinator. */
  | { type: "tool"; at: string; name: string; args: unknown; result: unknown; ok: boolean }
  /** Real-world actions that the sandbox does NOT perform (calls, bookings, payments). */
  | { type: "stubbed"; at: string; action: string; detail: string }
  /** Real web search used for restaurant selection. */
  | { type: "search"; at: string; query: string; resultCount?: number }
  /** Fo scheduled a timer (nudge, deadline, reminder) on the simulated clock. */
  | { type: "scheduled"; at: string; runAt: string; description: string }
  | { type: "stage"; at: string; eventId: string; stage: string }
  /** Free-form engine note, e.g. "Jordan never replies (persona)". */
  | { type: "note"; at: string; text: string }
  | { type: "error"; at: string; message: string }
  | { type: "run_finished"; at: string; ok: boolean; summary: string; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; webSearches: number; estimatedUsd?: number } };

export type SandboxListener = (event: SandboxEvent) => void;

export class SandboxBus {
  readonly history: SandboxEvent[] = [];
  private listeners = new Set<SandboxListener>();

  emit(event: SandboxEvent): void {
    this.history.push(event);
    for (const listener of this.listeners) listener(event);
  }

  /** Replays history to the new listener first, so late viewers see everything. */
  subscribe(listener: SandboxListener): () => void {
    for (const event of this.history) listener(event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
