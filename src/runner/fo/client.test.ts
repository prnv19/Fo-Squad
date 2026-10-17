// McpFoClient against an in-process fake of Fo's MCP server on localhost.
// Never talks to wajo.ai.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FoToolError, McpFoClient } from "./client.js";
import { FileOAuthProvider, FoSignInRequiredError } from "./oauth.js";

type Handler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;

const ok = (data: object): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});
const textOnly = (data: object): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const toolError = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

interface FakeFoServer {
  url: string;
  origin: string;
  handlers: Record<string, Handler>;
  calls: { name: string; args: Record<string, unknown> }[];
  /** Return true to take over the raw request (e.g. to drop the connection). */
  intercept?: (req: IncomingMessage, res: ServerResponse, body: unknown) => boolean;
  /** When set, /fo requires "Authorization: Bearer <token>". */
  requiredToken?: string;
  tokenRequests: URLSearchParams[];
  close(): Promise<void>;
}

async function startFakeFo(): Promise<FakeFoServer> {
  const fake = {
    handlers: {} as Record<string, Handler>,
    calls: [] as { name: string; args: Record<string, unknown> }[],
    tokenRequests: [] as URLSearchParams[],
  } as FakeFoServer;

  const buildServer = () => {
    const server = new McpServer({ name: "fake-fo", version: "0.0.0" });
    const register = (name: string, shape: z.ZodRawShape) =>
      server.registerTool(name, { inputSchema: shape }, async (args: Record<string, unknown>) => {
        fake.calls.push({ name, args });
        const handler = fake.handlers[name];
        if (!handler) return toolError(`No handler for ${name}`);
        return handler(args);
      });
    register("ask_fo", { message: z.string(), conversationId: z.string().optional(), newConversation: z.boolean().optional() });
    register("get_fo_reply", { conversationId: z.string().optional(), waitSeconds: z.number().optional() });
    register("list_fo_conversations", {});
    register("get_fo_conversation", { conversationId: z.string() });
    return server;
  };

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };

  const http: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/token" && req.method === "POST") {
      fake.tokenRequests.push(new URLSearchParams(await readBody(req)));
      fake.requiredToken = "fresh-access";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "fresh-access", token_type: "Bearer", refresh_token: "r2", expires_in: 3600 }));
      return;
    }
    if (url.pathname !== "/fo") {
      res.writeHead(404).end();
      return;
    }
    if (fake.requiredToken && req.headers.authorization !== `Bearer ${fake.requiredToken}`) {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const body: unknown = JSON.parse(await readBody(req));
    if (fake.intercept?.(req, res, body)) return;
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  fake.origin = `http://127.0.0.1:${port}`;
  fake.url = `${fake.origin}/fo`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  return fake;
}

function isToolCall(body: unknown, name: string): boolean {
  const b = body as { method?: string; params?: { name?: string } };
  return b?.method === "tools/call" && b.params?.name === name;
}

let fake: FakeFoServer;
let client: McpFoClient;
beforeEach(async () => {
  fake = await startFakeFo();
  client = new McpFoClient({ url: fake.url, minPollIntervalMs: 0 });
});
afterEach(async () => {
  await client.close();
  await fake.close();
});

describe("McpFoClient.ask", () => {
  it("returns a complete reply straight from ask_fo", async () => {
    fake.handlers.ask_fo = () => ok({ status: "complete", conversationId: "c1", response: "Texted Maya.", elapsedSeconds: 3 });
    const reply = await client.ask("Text Maya: dinner Saturday?", { conversationId: "c1" });
    expect(reply).toEqual({ status: "complete", conversationId: "c1", response: "Texted Maya." });
    expect(fake.calls).toEqual([{ name: "ask_fo", args: { message: "Text Maya: dinner Saturday?", conversationId: "c1" } }]);
  });

  it("polls get_fo_reply while working, then returns the final reply", async () => {
    fake.handlers.ask_fo = () => ok({ status: "working", conversationId: "c9", progress: "Working for 5s" });
    let polls = 0;
    fake.handlers.get_fo_reply = () =>
      ++polls < 3
        ? ok({ status: "working", conversationId: "c9", response: "", progress: `step ${polls}` })
        : textOnly({ status: "complete", conversationId: "c9", response: "Done: sent 3 texts." });
    const reply = await client.ask("Send the invites", { newConversation: true });
    expect(reply).toEqual({ status: "complete", conversationId: "c9", response: "Done: sent 3 texts." });
    expect(fake.calls[0]?.args).toEqual({ message: "Send the invites", newConversation: true });
    const pollCalls = fake.calls.filter((c) => c.name === "get_fo_reply");
    expect(pollCalls).toHaveLength(3);
    expect(pollCalls[0]?.args).toEqual({ conversationId: "c9", waitSeconds: 40 });
  });

  it("returns a failed reply as is", async () => {
    fake.handlers.ask_fo = () => ok({ status: "working", conversationId: "c2" });
    fake.handlers.get_fo_reply = () => ok({ status: "failed", conversationId: "c2", response: "I couldn't reach that number." });
    expect(await client.ask("Text +15550000000")).toEqual({
      status: "failed",
      conversationId: "c2",
      response: "I couldn't reach that number.",
    });
  });

  it("throws Fo's message for isError results", async () => {
    fake.handlers.ask_fo = () => toolError("Unknown conversationId.");
    const err = await client.ask("hi", { conversationId: "made-up" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FoToolError);
    expect((err as Error).message).toBe("Unknown conversationId.");
  });

  it("gives up after the timeout and returns the last working reply", async () => {
    fake.handlers.ask_fo = () => ok({ status: "working", conversationId: "c3", progress: "starting" });
    fake.handlers.get_fo_reply = async (args) => {
      await new Promise((r) => setTimeout(r, 20));
      return ok({ status: "working", conversationId: "c3", response: "", progress: `wait ${String(args.waitSeconds)}` });
    };
    const started = Date.now();
    const reply = await client.ask("long task", { timeoutMs: 150 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(reply.status).toBe("working");
    expect(reply.conversationId).toBe("c3");
    expect(reply.progress).toBe("wait 1");
  });

  it("rejects conversationId together with newConversation without calling Fo", async () => {
    await expect(client.ask("x", { conversationId: "c", newConversation: true })).rejects.toThrow(/not both/);
    expect(fake.calls).toEqual([]);
  });

  it("does not resend ask_fo when the connection drops mid-request", async () => {
    fake.handlers.ask_fo = () => ok({ status: "complete", conversationId: "c1", response: "ok" });
    let drops = 0;
    fake.intercept = (req, _res, body) => {
      if (isToolCall(body, "ask_fo") && drops++ === 0) {
        req.socket.destroy();
        return true;
      }
      return false;
    };
    await expect(client.ask("Text Maya")).rejects.toThrow();
    expect(drops).toBe(1);
    // The next call reconnects normally.
    expect((await client.ask("Text Maya again")).response).toBe("ok");
  });
});

describe("McpFoClient conversations", () => {
  it("lists conversations, skipping malformed rows", async () => {
    fake.handlers.list_fo_conversations = () =>
      ok({
        conversations: [
          { conversationId: "a", title: "+15551230001", channel: "sms", startedAt: "2026-10-17T18:00:00Z" },
          { title: "no id" },
          { conversationId: "b", title: "Planning", channel: "chat" },
        ],
      });
    expect(await client.listConversations()).toEqual([
      { conversationId: "a", title: "+15551230001", channel: "sms", startedAt: "2026-10-17T18:00:00Z" },
      { conversationId: "b", title: "Planning", channel: "chat" },
    ]);
  });

  it("gets a conversation's turns from JSON text content", async () => {
    fake.handlers.get_fo_conversation = (args) =>
      textOnly({
        conversation: { conversationId: args.conversationId, title: "Maya", channel: "sms" },
        turns: [
          { role: "user", text: "I'm in", at: "2026-10-17T18:00:00Z" },
          { role: "assistant", text: "Great", runId: "r1" },
          { role: "user", image: "no text" },
        ],
      });
    expect(await client.getConversation("a")).toEqual({
      conversation: { conversationId: "a", title: "Maya", channel: "sms" },
      turns: [
        { role: "user", text: "I'm in", at: "2026-10-17T18:00:00Z" },
        { role: "assistant", text: "Great", runId: "r1" },
      ],
    });
  });

  it("reconnects once and retries a read when the connection drops", async () => {
    fake.handlers.list_fo_conversations = () => ok({ conversations: [{ conversationId: "a", title: "t", channel: "sms" }] });
    let drops = 0;
    fake.intercept = (req, _res, body) => {
      if (isToolCall(body, "list_fo_conversations") && drops++ === 0) {
        req.socket.destroy();
        return true;
      }
      return false;
    };
    expect(await client.listConversations()).toHaveLength(1);
    expect(drops).toBe(2);
  });

  it("gives up after one reconnect", async () => {
    fake.handlers.list_fo_conversations = () => ok({ conversations: [] });
    let drops = 0;
    fake.intercept = (req, _res, body) => {
      if (!isToolCall(body, "list_fo_conversations")) return false;
      drops++;
      req.socket.destroy();
      return true;
    };
    await expect(client.listConversations()).rejects.toThrow();
    expect(drops).toBe(2);
  });
});

describe("McpFoClient with the file OAuth provider", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "fo-client-oauth-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function providerWith(tokens: Record<string, unknown>): Promise<FileOAuthProvider> {
    const file = path.join(dir, "fo-oauth.json");
    const issuer = `${fake.origin}/`;
    await writeFile(file, JSON.stringify({ clientInformation: { client_id: "runner", issuer }, tokens: { ...tokens, issuer } }));
    return new FileOAuthProvider({ file, interactive: false });
  }

  it("sends the saved access token", async () => {
    fake.requiredToken = "saved-access";
    fake.handlers.list_fo_conversations = () => ok({ conversations: [] });
    const authed = new McpFoClient({ url: fake.url, authProvider: await providerWith({ access_token: "saved-access", token_type: "Bearer" }) });
    try {
      expect(await authed.listConversations()).toEqual([]);
    } finally {
      await authed.close();
    }
  });

  it("refreshes an expired token through the SDK and saves the new one", async () => {
    fake.requiredToken = "something-else";
    fake.handlers.list_fo_conversations = () => ok({ conversations: [] });
    const provider = await providerWith({ access_token: "expired", token_type: "Bearer", refresh_token: "r1" });
    const authed = new McpFoClient({ url: fake.url, authProvider: provider });
    try {
      expect(await authed.listConversations()).toEqual([]);
    } finally {
      await authed.close();
    }
    expect(fake.tokenRequests[0]?.get("grant_type")).toBe("refresh_token");
    expect(fake.tokenRequests[0]?.get("refresh_token")).toBe("r1");
    expect(await provider.tokens()).toMatchObject({ access_token: "fresh-access", refresh_token: "r2" });
  });

  it("throws the fo:login instruction when a browser sign-in would be needed headless", async () => {
    fake.requiredToken = "something-else";
    const provider = await providerWith({ access_token: "expired", token_type: "Bearer" });
    const authed = new McpFoClient({ url: fake.url, authProvider: provider });
    try {
      const err = await authed.listConversations().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FoSignInRequiredError);
      expect((err as Error).message).toContain("npm run fo:login");
    } finally {
      await authed.close();
    }
  });
});
