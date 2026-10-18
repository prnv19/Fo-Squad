import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./events/index.js";
import { createApp, MIN_TOKEN_LENGTH, readToken } from "./index.js";
import { createMcpServer } from "./server.js";
import { FoSquadService } from "./service.js";

const CONTRACT_TOOLS = [
  "create_event",
  "update_event",
  "record_preferences",
  "mark_nudged",
  "pick_time",
  "set_restaurant_options",
  "record_vote",
  "tally_votes",
  "confirm_booking",
  "add_receipt",
  "set_attendees",
  "record_claims",
  "calculate_shares",
  "mark_paid",
  "record_opt_out",
  "get_status",
];

const newService = () => new FoSquadService(new MemoryStore(), () => new Date("2026-10-17T18:00:00.000Z"));

const CREATE_ARGS = {
  title: "Saturday dinner",
  organizer: { name: "Pranav", phone: "5550001111", venmo: "pranav" },
  friends: [{ name: "Maya", phone: "5551230001" }],
  time_slots: [{ label: "Sat 7:30pm", starts_at: "2026-10-25T02:30:00.000Z" }],
};

type Structured = Record<string, unknown>;

async function inMemoryClient() {
  const server = createMcpServer(newService());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server", () => {
  it("lists every contract tool with a description", async () => {
    const client = await inMemoryClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CONTRACT_TOOLS].sort());
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(40);
    const create = tools.find((t) => t.name === "create_event");
    expect(create?.inputSchema.required).toEqual(expect.arrayContaining(["title", "organizer", "friends"]));
    await client.close();
  });

  it("round-trips create_event then get_status", async () => {
    const client = await inMemoryClient();
    const created = await client.callTool({ name: "create_event", arguments: CREATE_ARGS });
    expect(created.isError).toBeFalsy();
    const body = created.structuredContent as Structured;
    expect(body).toMatchObject({ ok: true, stage: "planning" });
    const text = (created.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual(body);

    const status = await client.callTool({ name: "get_status", arguments: { phone: "+15551230001" } });
    expect(status.structuredContent).toMatchObject({ ok: true, found: true, event_id: body.event_id, stage: "planning" });
    await client.close();
  });

  it("returns FoErrors as isError with a code and message", async () => {
    const client = await inMemoryClient();
    const created = (await client.callTool({ name: "create_event", arguments: CREATE_ARGS })).structuredContent as Structured;
    const r = await client.callTool({
      name: "confirm_booking",
      arguments: { event_id: created.event_id, by_phone: "5551230001", restaurant_name: "Luigi's" },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      ok: false,
      error: { code: "NOT_ORGANIZER", message: expect.stringContaining("Only the organizer") },
    });
    const missing = await client.callTool({ name: "get_status", arguments: { event_id: "no-such-dinner" } });
    expect(missing.isError).toBe(true);
    expect((missing.structuredContent as Structured).error).toMatchObject({ code: "NOT_FOUND" });
    await client.close();
  });

  it("rejects args that don't match the schema", async () => {
    const client = await inMemoryClient();
    const r = await client.callTool({ name: "pick_time", arguments: { force: "yes" } });
    expect(r.isError).toBe(true);
    await client.close();
  });
});

describe("startup token", () => {
  const strong = "a".repeat(MIN_TOKEN_LENGTH);

  it("refuses to run the HTTP server without a token", () => {
    expect(() => readToken({})).toThrow(/FO_SQUAD_TOKEN is required/);
    expect(() => readToken({ FO_SQUAD_TOKEN: "   " })).toThrow(/FO_SQUAD_TOKEN is required/);
  });

  it("refuses weak or URL-unsafe tokens", () => {
    expect(() => readToken({ FO_SQUAD_TOKEN: "s3cret" })).toThrow(/at least 32 characters/);
    expect(() => readToken({ FO_SQUAD_TOKEN: `${strong}/x` })).toThrow(/letters, digits/);
  });

  it("accepts a strong token, and runs open only with the explicit local-development opt-out", () => {
    expect(readToken({ FO_SQUAD_TOKEN: ` ${strong} ` })).toBe(strong);
    expect(readToken({ FO_SQUAD_ALLOW_NO_TOKEN: "1" })).toBeUndefined();
    expect(() => readToken({ FO_SQUAD_ALLOW_NO_TOKEN: "true" })).toThrow(/FO_SQUAD_TOKEN is required/);
  });
});

describe("HTTP app", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(token?: string): Promise<string> {
    const app = createApp({ service: newService(), ...(token ? { token } : {}) });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const initialize = (base: string, path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "1" } },
      }),
    });

  it("serves /health without a token", async () => {
    const base = await listen("s3cret");
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("requires the bearer token on /mcp when one is set", async () => {
    const base = await listen("s3cret");
    expect((await initialize(base, "/mcp")).status).toBe(401);
    expect((await initialize(base, "/mcp", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await initialize(base, "/mcp", { authorization: "Bearer s3cret" })).status).toBe(200);
  });

  it("accepts the token as a secret path segment for clients that can't send headers", async () => {
    const base = await listen("s3cret");
    expect((await initialize(base, "/mcp/wrong")).status).toBe(401);
    expect((await initialize(base, "/mcp/s3cre")).status).toBe(401);
    expect((await initialize(base, "/mcp/s3cret")).status).toBe(200);
  });

  it("leaves /mcp open when no token is set", async () => {
    const base = await listen();
    expect((await initialize(base, "/mcp")).status).toBe(200);
    expect((await initialize(base, "/mcp/anything")).status).toBe(404);
  });

  it("works end to end with the SDK's HTTP client", async () => {
    const base = await listen("s3cret");
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer s3cret" } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(CONTRACT_TOOLS.length);
    const created = await client.callTool({ name: "create_event", arguments: CREATE_ARGS });
    const id = (created.structuredContent as Structured).event_id;
    const status = await client.callTool({ name: "get_status", arguments: { event_id: id } });
    expect(status.structuredContent).toMatchObject({ ok: true, found: true, stage: "planning" });
    await client.close();
  });
});
