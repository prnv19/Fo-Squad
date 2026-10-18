import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MemoryStore } from "./events/index.js";
import { createMcpServer } from "./server.js";
import { FoSquadService } from "./service.js";
import { getTool, runServiceCall, TOOL_NAMES, TOOLS } from "./tools.js";

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
  "cover_bill",
  "mark_paid",
  "record_opt_out",
  "get_playbook",
  "get_status",
];

describe("tool registry", () => {
  it("has exactly the 18 contract tools, each with a usable shape", () => {
    expect([...TOOL_NAMES].sort()).toEqual([...CONTRACT_TOOLS].sort());
    expect(new Set(TOOL_NAMES).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.description.length).toBeGreaterThan(40);
      expect(() => z.toJSONSchema(z.object(t.inputShape))).not.toThrow();
    }
  });

  it("marks which tools carry by_phone, and whether it's required", () => {
    const withByPhone = TOOLS.filter((t) => "by_phone" in t.inputShape).map((t) => t.name);
    expect(withByPhone.sort()).toEqual(["calculate_shares", "confirm_booking", "cover_bill", "mark_paid", "update_event"]);
    // by_email stands in for by_phone on an email, so whether one is needed is declared, not in the schema.
    for (const name of withByPhone) expect("by_email" in getTool(name)!.inputShape, name).toBe(true);
    expect(TOOLS.filter((t) => t.sender).map((t) => t.name).sort()).toEqual(withByPhone.sort());
    expect(getTool("mark_paid")!.sender).toBe("required");
    expect(getTool("confirm_booking")!.sender).toBe("required");
    expect(getTool("update_event")!.sender).toBe("required");
    expect(getTool("calculate_shares")!.sender).toBe("optional");
  });

  it("runs the service and maps FoErrors to a relayable result", async () => {
    const service = new FoSquadService(new MemoryStore());
    const missing = await runServiceCall("get_status", () => getTool("get_status")!.run(service, { event_id: "nope" }));
    expect(missing).toEqual({ isError: true, result: { ok: false, error: { code: "NOT_FOUND", message: expect.any(String) } } });
  });
});

describe("MCP server registers from the registry", () => {
  it("lists the registry's tools in order with the same descriptions", async () => {
    const server = createMcpServer(new FoSquadService(new MemoryStore()));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      const def = getTool(t.name)!;
      expect(t.description).toBe(def.description);
      expect(t.title).toBe(def.title);
      expect(Object.keys(t.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(def.inputShape).sort());
    }
    await client.close();
  });
});
