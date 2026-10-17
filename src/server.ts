// MCP wiring: one registerTool per contract tool, all from the registry in
// src/tools.ts. All rules live in FoSquadService; this file only turns results
// and errors into MCP tool results.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FoSquadService, ToolResult } from "./service.js";
import { runServiceCall, TOOLS } from "./tools.js";

export const SERVER_NAME = "fo-squad";
export const SERVER_VERSION = "0.1.0";

function toCallResult(result: ToolResult, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    ...(isError ? { isError: true } : {}),
  };
}

/** Runs a service call and maps errors: FoError messages are safe to relay, anything else is not. */
export async function runTool(name: string, fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  const { result, isError } = await runServiceCall(name, fn);
  return toCallResult(result, isError);
}

export function createMcpServer(service: FoSquadService): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape },
      (args) => runTool(tool.name, () => tool.run(service, args as Record<string, unknown>)),
    );
  }
  return server;
}
