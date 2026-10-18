// The Claude Code backend: one coordinator run through the Claude Agent SDK,
// on the machine's Claude Code login instead of an API key. The sandbox's own
// tools are served in process as an SDK MCP server; every built-in Claude Code
// tool except WebSearch is off, settings files and claude.ai connectors aren't
// loaded, and a run that sees any other tool is stopped before it starts.

import { tmpdir } from "node:os";
import { createSdkMcpServer, query, tool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { z } from "zod";

type RunnableTool = BetaRunnableTool<Record<string, unknown>>;

export const DEFAULT_CLAUDE_CODE_MODEL = "claude-haiku-5-5";
const SERVER = "fo";
const WEB_SEARCH = "WebSearch";

export interface ClaudeCodeRunRequest {
  model: string;
  systemPrompt: string;
  prompt: string;
  /** The sandbox's custom tools; each becomes mcp__fo__<name>. */
  tools: RunnableTool[];
  /** Model requests allowed in this run. */
  maxTurns: number;
  /** A web search Fo started. */
  onSearch?: (query: string) => void;
  /** Checked on every message; true stops the run. */
  overBudget?: () => boolean;
}

export interface ClaudeCodeRunOutcome {
  /** done: finished on its own; cap: hit maxTurns; budget: stopped by overBudget; refusal; error. */
  stop: "done" | "cap" | "budget" | "refusal" | "error";
  text: string;
  error?: string;
  usage: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    webSearches: number;
    requests: number;
    costUsd: number;
  };
}

/** The parent env minus API credentials, so Claude Code uses its own login, and with claude.ai connectors off. */
export function claudeCodeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_AGENT_SDK_CLIENT_APP: "fo-squad-sandbox/0.1.0" };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}

const resultText = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content));

/** Wraps a sandbox tool for the SDK: same run(), with ToolError becoming an MCP error result. */
export function toSdkTool(t: RunnableTool) {
  if (!("input_schema" in t)) throw new Error(`${t.name}: only custom tools can be served to Claude Code`);
  const schema = z.fromJSONSchema(t.input_schema as Parameters<typeof z.fromJSONSchema>[0]);
  if (!(schema instanceof z.ZodObject)) throw new Error(`${t.name}: input schema isn't an object`);
  return tool(t.name, t.description ?? "", schema.shape, async (args) => {
    try {
      return { content: [{ type: "text" as const, text: resultText(await t.run(args as Record<string, unknown>)) }] };
    } catch (err) {
      const text = err instanceof ToolError ? resultText(err.content) : JSON.stringify({ ok: false, error: { message: String(err) } });
      return { content: [{ type: "text" as const, text }], isError: true };
    }
  });
}

export async function runClaudeCodeTurn(req: ClaudeCodeRunRequest): Promise<ClaudeCodeRunOutcome> {
  const allowed = new Set([...req.tools.map((t) => `mcp__${SERVER}__${t.name}`), WEB_SEARCH]);
  const outcome: ClaudeCodeRunOutcome = {
    stop: "done",
    text: "",
    usage: { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, webSearches: 0, requests: 0, costUsd: 0 },
  };
  const seenSearchIds = new Set<string>();

  // A fresh server per run: an MCP server instance serves one transport.
  const server = createSdkMcpServer({ name: SERVER, version: "0.1.0", tools: req.tools.map(toSdkTool) });
  const q = query({
    prompt: req.prompt,
    options: {
      model: req.model,
      systemPrompt: req.systemPrompt,
      tools: [WEB_SEARCH],
      allowedTools: [`mcp__${SERVER}`, WEB_SEARCH],
      mcpServers: { [SERVER]: server },
      strictMcpConfig: true,
      permissionMode: "dontAsk",
      settingSources: [],
      persistSession: false,
      maxTurns: req.maxTurns,
      env: claudeCodeEnv(),
      cwd: tmpdir(),
    },
  });

  const handle = (m: SDKMessage): boolean => {
    if (m.type === "system" && m.subtype === "init") {
      const extra = m.tools.filter((name) => !allowed.has(name));
      if (extra.length) {
        outcome.stop = "error";
        outcome.error = `Claude Code offered tools outside the sandbox (${extra.join(", ")}); run stopped before Fo acted.`;
        return false;
      }
      return true;
    }
    if (m.type === "assistant") {
      for (const block of m.message.content) {
        if (block.type !== "tool_use" || block.name !== WEB_SEARCH || seenSearchIds.has(block.id)) continue;
        seenSearchIds.add(block.id);
        req.onSearch?.(String((block.input as { query?: unknown }).query ?? ""));
      }
      return true;
    }
    if (m.type !== "result") return true;
    for (const u of Object.values(m.modelUsage)) {
      outcome.usage.inputTokens += u.inputTokens;
      outcome.usage.cacheWriteTokens += u.cacheCreationInputTokens;
      outcome.usage.cacheReadTokens += u.cacheReadInputTokens;
      outcome.usage.outputTokens += u.outputTokens;
      outcome.usage.webSearches += u.webSearchRequests;
    }
    outcome.usage.requests += m.num_turns;
    outcome.usage.costUsd += m.total_cost_usd;
    if (m.subtype === "success") {
      if (m.is_error) {
        outcome.stop = "error";
        outcome.error = m.result;
      } else if (m.stop_reason === "refusal") {
        outcome.stop = "refusal";
      } else {
        outcome.text = m.result.trim();
      }
    } else if (m.subtype === "error_max_turns") {
      outcome.stop = "cap";
    } else {
      outcome.stop = "error";
      outcome.error = `${m.subtype}: ${m.errors.join("; ") || "no detail"}`;
    }
    return false;
  };

  try {
    for await (const m of q) {
      if (!handle(m)) break;
      if (req.overBudget?.()) {
        outcome.stop = "budget";
        break;
      }
    }
  } catch (err) {
    outcome.stop = "error";
    outcome.error = `Claude Code error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    q.close();
  }
  return outcome;
}
