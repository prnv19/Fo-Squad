import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOLS } from "../tools.js";
import { claudeCodeEnv, toSdkTool } from "./claudeCode.js";

type Tool = Parameters<typeof toSdkTool>[0];

const fakeTool = (run: Tool["run"]): Tool => ({
  type: "custom",
  name: "send_text",
  description: "Send one text.",
  input_schema: {
    type: "object",
    properties: { to_phone: { type: "string" }, text: { type: "string" } },
    required: ["to_phone", "text"],
    additionalProperties: false,
  },
  parse: (input: unknown) => input as Record<string, unknown>,
  run,
});

describe("claudeCodeEnv", () => {
  it("drops API credentials so Claude Code uses its login, and turns claude.ai connectors off", () => {
    const env = claudeCodeEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "junk", ANTHROPIC_AUTH_TOKEN: "junk" });
    expect(env.PATH).toBe("/bin");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  });
});

describe("toSdkTool", () => {
  it("keeps the name, description and input fields", () => {
    const t = toSdkTool(fakeTool(() => "{}"));
    expect(t.name).toBe("send_text");
    expect(t.description).toBe("Send one text.");
    expect(Object.keys(t.inputSchema)).toEqual(["to_phone", "text"]);
  });

  it("returns the tool's output as text", async () => {
    const t = toSdkTool(fakeTool((args) => JSON.stringify({ ok: true, to: args.to_phone })));
    expect(await t.handler({ to_phone: "+15555550100", text: "hi" }, undefined)).toEqual({ content: [{ type: "text", text: '{"ok":true,"to":"+15555550100"}' }] });
  });

  it("turns a ToolError into an MCP error result", async () => {
    const t = toSdkTool(
      fakeTool(() => {
        throw new ToolError('{"ok":false}');
      }),
    );
    expect(await t.handler({ to_phone: "x", text: "y" }, undefined)).toEqual({ content: [{ type: "text", text: '{"ok":false}' }], isError: true });
  });

  it("converts every Fo Squad tool's schema", () => {
    for (const def of TOOLS) {
      const schema = z.toJSONSchema(z.object(def.inputShape)) as Tool["input_schema"];
      const t = toSdkTool({ ...fakeTool(() => "{}"), name: def.name, input_schema: schema });
      expect(Object.keys(t.inputSchema).sort(), def.name).toEqual(Object.keys(def.inputShape).sort());
    }
  });
});
