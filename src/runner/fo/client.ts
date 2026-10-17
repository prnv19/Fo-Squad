// FoClient over Fo's remote MCP server (Streamable HTTP + OAuth).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FoClient, FoConversationSummary, FoReply, FoTurn, FoTurnStatus } from "../types.js";
import { FoSignInRequiredError } from "./oauth.js";

export const FO_MCP_URL = "https://mcp.api.wajo.ai/fo";
export const DEFAULT_ASK_TIMEOUT_MS = 15 * 60_000;
const MAX_WAIT_SECONDS = 40;
// ask_fo holds the request up to ~45 s and get_fo_reply up to 40 s; leave headroom.
const REQUEST_SLACK_MS = 30_000;

export interface McpFoClientOptions {
  url: string;
  authProvider?: OAuthClientProvider;
  fetch?: FetchLike;
  /** Minimum gap between get_fo_reply calls, so a server answering instantly can't spin us. Default 1000. */
  minPollIntervalMs?: number;
}

/** A tool result with isError: Fo's readable message. */
export class FoToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "FoToolError";
  }
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

const STATUSES = new Set<FoTurnStatus>(["complete", "working", "failed"]);

function textOf(result: ToolResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/** structuredContent when present, else the JSON in the text content. */
function payloadOf(tool: string, result: ToolResult): Record<string, unknown> {
  if (result.isError) throw new FoToolError(tool, textOf(result) || `Fo's ${tool} failed.`);
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) return structured as Record<string, unknown>;
  const text = textOf(result);
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return { items: parsed };
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new Error(`Unexpected ${tool} result from Fo: ${text.slice(0, 200) || "(empty)"}`);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function parseReply(tool: string, p: Record<string, unknown>, fallbackConversationId?: string): FoReply {
  const status = str(p.status) as FoTurnStatus | undefined;
  if (!status || !STATUSES.has(status)) throw new Error(`Fo's ${tool} returned an unknown status: ${String(p.status)}`);
  const conversationId = str(p.conversationId) ?? fallbackConversationId;
  if (!conversationId) throw new Error(`Fo's ${tool} returned no conversationId.`);
  const reply: FoReply = { status, conversationId };
  const response = str(p.response);
  const progress = str(p.progress);
  if (response !== undefined) reply.response = response;
  if (progress !== undefined) reply.progress = progress;
  return reply;
}

function parseSummary(raw: unknown): FoConversationSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const conversationId = str(r.conversationId);
  if (!conversationId) return undefined;
  const summary: FoConversationSummary = {
    conversationId,
    title: str(r.title) ?? "",
    channel: str(r.channel) ?? "unknown",
  };
  const startedAt = str(r.startedAt);
  if (startedAt) summary.startedAt = startedAt;
  return summary;
}

function parseTurn(raw: unknown): FoTurn | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const text = str(r.text);
  if (text === undefined) return undefined;
  const turn: FoTurn = { role: str(r.role) ?? "unknown", text };
  const at = str(r.at);
  const runId = str(r.runId);
  if (at) turn.at = at;
  if (runId) turn.runId = runId;
  return turn;
}

/** Errors meaning the connection broke, as opposed to Fo or the protocol saying no. */
function isTransportFailure(err: unknown): boolean {
  if (err instanceof FoToolError || err instanceof FoSignInRequiredError || err instanceof UnauthorizedError) return false;
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed;
  return err instanceof Error;
}

/**
 * Whether a failed ask_fo certainly never reached Fo. Resending one that did
 * would make Fo act twice (two texts to a friend), which is worse than failing.
 */
function certainlyNotDelivered(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) return err.code === 404; // session expired, request rejected
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class McpFoClient implements FoClient {
  private readonly url: URL;
  private readonly authProvider?: OAuthClientProvider;
  private readonly fetchFn?: FetchLike;
  private readonly minPollIntervalMs: number;
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;

  constructor(opts: McpFoClientOptions) {
    this.url = new URL(opts.url);
    this.authProvider = opts.authProvider;
    this.fetchFn = opts.fetch;
    this.minPollIntervalMs = opts.minPollIntervalMs ?? 1000;
  }

  async ask(
    message: string,
    opts: { conversationId?: string; newConversation?: boolean; timeoutMs?: number } = {},
  ): Promise<FoReply> {
    if (opts.conversationId && opts.newConversation) {
      throw new Error("ask(): pass either conversationId or newConversation, not both.");
    }
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS);
    const args: Record<string, unknown> = { message };
    if (opts.conversationId) args.conversationId = opts.conversationId;
    if (opts.newConversation) args.newConversation = true;

    const first = await this.call("ask_fo", args, 45_000 + REQUEST_SLACK_MS, certainlyNotDelivered);
    let reply = parseReply("ask_fo", first, opts.conversationId);

    while (reply.status === "working") {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const waitSeconds = Math.min(MAX_WAIT_SECONDS, Math.ceil(remainingMs / 1000));
      const started = Date.now();
      const next = await this.call(
        "get_fo_reply",
        { conversationId: reply.conversationId, waitSeconds },
        waitSeconds * 1000 + REQUEST_SLACK_MS,
        () => true,
      );
      reply = parseReply("get_fo_reply", next, reply.conversationId);
      const elapsed = Date.now() - started;
      if (reply.status === "working" && elapsed < this.minPollIntervalMs) {
        await sleep(Math.min(this.minPollIntervalMs - elapsed, Math.max(0, deadline - Date.now())));
      }
    }
    return reply;
  }

  async listConversations(): Promise<FoConversationSummary[]> {
    const p = await this.call("list_fo_conversations", {}, 60_000, () => true);
    const rows = Array.isArray(p.conversations) ? p.conversations : Array.isArray(p.items) ? p.items : [];
    return rows.map(parseSummary).filter((s): s is FoConversationSummary => s !== undefined);
  }

  async getConversation(conversationId: string): Promise<{ conversation: FoConversationSummary; turns: FoTurn[] }> {
    const p = await this.call("get_fo_conversation", { conversationId }, 60_000, () => true);
    const conversation = parseSummary(p.conversation) ?? { conversationId, title: "", channel: "unknown" };
    const turns = (Array.isArray(p.turns) ? p.turns : []).map(parseTurn).filter((t): t is FoTurn => t !== undefined);
    return { conversation, turns };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    await client?.close().catch(() => {});
  }

  /**
   * One tool call, reconnecting once if the transport fails. `mayResend`
   * decides whether a call that failed after being sent is safe to repeat;
   * a failure while connecting is always retried since nothing was sent.
   */
  private async call(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    mayResend: (err: unknown) => boolean,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      let sent = false;
      try {
        const client = await this.connect();
        sent = true;
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
        return payloadOf(name, result);
      } catch (err) {
        if (!isTransportFailure(err)) throw err;
        await this.close();
        if (attempt > 0 || (sent && !mayResend(err))) throw err;
      }
    }
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const client = new Client({ name: "fo-squad-runner", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(this.url, {
        authProvider: this.authProvider,
        fetch: this.fetchFn,
      });
      client.onclose = () => {
        if (this.client === client) this.client = undefined;
      };
      try {
        await client.connect(transport);
      } catch (err) {
        this.connecting = undefined;
        await client.close().catch(() => {});
        throw err;
      }
      this.client = client;
      this.connecting = undefined;
      return client;
    })();
    return this.connecting;
  }
}
