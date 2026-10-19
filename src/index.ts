// Entry point. HTTP by default (Streamable HTTP, stateless: a fresh server and
// transport per request, since all state lives in the store), or stdio with
// --stdio for running from Claude Desktop/Code as a fallback.

import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createStore } from "./events/index.js";
import { DEFAULT_TIME_ZONE, isTimeZone } from "./events/zone.js";
import { createRunnerFromEnv, runnerEnabled, type DryRunHooks } from "./runner/factory.js";
import type { RunnerHealth } from "./runner/runner.js";
import { createMcpServer } from "./server.js";
import { FoSquadService } from "./service.js";

export interface AppOptions {
  service: FoSquadService;
  /** When set, /mcp needs "Authorization: Bearer <token>" or the /mcp/<token> path. */
  token?: string;
  /** Adds `runner` to /health. Omitted: /health is just { ok: true }. */
  runnerHealth?: () => RunnerHealth;
  /** FO_RUNNER_DRY=1 only: POST /runner/dry/inbound { from, text } fakes a text to Fo. */
  dryRun?: DryRunHooks;
  /** One line per MCP request and tool call. Never the token, arguments or results. */
  log?: (line: string) => void;
}

/** "tools/call get_status", "initialize", or "batch of 3" from a JSON-RPC body. */
function describeRpc(body: unknown): string {
  const one = (m: unknown): string => {
    const msg = (m ?? {}) as { method?: unknown; params?: { name?: unknown } };
    const method = typeof msg.method === "string" ? msg.method : "response";
    return method === "tools/call" && typeof msg.params?.name === "string" ? `${method} ${msg.params.name}` : method;
  };
  return Array.isArray(body) ? `batch of ${body.length} (${body.map(one).join(", ")})` : one(body);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Bad configuration: printed as one plain line at startup, without a stack trace. */
export class StartupError extends Error {}

/** 32+ characters: `openssl rand -hex 32` gives 64. */
export const MIN_TOKEN_LENGTH = 32;

/**
 * The token /mcp requires. The HTTP server fails closed: no token (or a weak
 * one) is a startup error, unless FO_SQUAD_ALLOW_NO_TOKEN=1 for local
 * development. URL-safe characters only, since it may travel as a path segment.
 */
export function readToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.FO_SQUAD_TOKEN?.trim();
  if (token) {
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new StartupError(`FO_SQUAD_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. Generate one with: openssl rand -hex 32`);
    }
    if (!/^[A-Za-z0-9._~-]+$/.test(token)) {
      throw new StartupError("FO_SQUAD_TOKEN may only use letters, digits and . _ ~ - (it can appear in the URL). Generate one with: openssl rand -hex 32");
    }
    return token;
  }
  if (env.FO_SQUAD_ALLOW_NO_TOKEN?.trim() === "1") return undefined;
  throw new StartupError(
    "FO_SQUAD_TOKEN is required: without it anyone could read and change every dinner. Generate one with: openssl rand -hex 32. For local development only, FO_SQUAD_ALLOW_NO_TOKEN=1 runs without one.",
  );
}

/**
 * The zone the server places day-of reminders in: FO_SQUAD_TZ, else RUNNER_TZ
 * (so a runner deployment needs only one), else the runner's default.
 */
export function readTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const zone = env.FO_SQUAD_TZ?.trim() || env.RUNNER_TZ?.trim() || DEFAULT_TIME_ZONE;
  if (!isTimeZone(zone)) {
    throw new StartupError(`Time zone "${zone}" isn't a known IANA name (use one like America/Denver).`);
  }
  return zone;
}

/** Constant-time compare so the token can't be guessed one character at a time. */
function tokenMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createApp({ service, token, runnerHealth, dryRun, log }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  if (log) {
    // Who's calling and with what, so a connection from Fo is visible. The path
    // token is replaced before logging; bodies are reduced to method names.
    app.use(["/mcp", "/mcp/:token"], (req, res, next) => {
      const started = Date.now();
      res.on("finish", () => {
        const path = req.params.token !== undefined || req.path !== "/" ? "/mcp/<token>" : "/mcp";
        const ua = clip(String(req.headers["user-agent"] ?? "-"), 80);
        log(`${req.method} ${path} ${req.method === "POST" ? describeRpc(req.body) : "-"} -> ${res.statusCode} ${Date.now() - started}ms ua="${ua}"`);
      });
      next();
    });
  }

  app.get("/health", (_req, res) => {
    res.json(runnerHealth ? { ok: true, runner: runnerHealth() } : { ok: true });
  });

  // Claude.ai custom connectors can't send headers, so the token may also
  // arrive as a secret path segment. Both are checked the same way.
  const auth = (req: Request, res: Response, next: NextFunction): void => {
    const pathToken = typeof req.params.token === "string" ? req.params.token : undefined;
    if (!token) {
      if (pathToken !== undefined) return void res.status(404).json({ error: "Not found" });
      return next();
    }
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    if (tokenMatches(bearer, token) || tokenMatches(pathToken, token)) return next();
    res.setHeader("WWW-Authenticate", "Bearer");
    jsonRpcError(res, 401, -32001, "Unauthorized");
  };

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    const server = createMcpServer(service, log ? { log } : {});
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[fo-squad] MCP request failed:", err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  };

  // Stateless mode has no sessions, so there is no SSE stream to GET and nothing to DELETE.
  const notAllowed = (_req: Request, res: Response): void => {
    jsonRpcError(res, 405, -32000, "Method not allowed.");
  };

  for (const path of ["/mcp", "/mcp/:token"]) {
    app.post(path, auth, handleMcp);
    app.get(path, auth, notAllowed);
    app.delete(path, auth, notAllowed);
  }

  if (dryRun) {
    // Rehearsal only: the fake Fo client has no real inbox, so texts are injected here.
    app.post("/runner/dry/inbound", auth, (req: Request, res: Response) => {
      const { from, text } = (req.body ?? {}) as { from?: unknown; text?: unknown };
      if (typeof from !== "string" || !from.trim() || typeof text !== "string" || !text.trim()) {
        return void res.status(400).json({ ok: false, error: "Send JSON { from, text }." });
      }
      dryRun.inbound(from.trim(), text);
      res.json({ ok: true, queued: true });
    });
  }

  return app;
}

async function main(): Promise<void> {
  const store = createStore();
  const timeZone = readTimeZone(); // throws a clear message on a bad zone
  const service = new FoSquadService(store, undefined, { timeZone });

  if (process.argv.includes("--stdio")) {
    // stdout carries the protocol in stdio mode, so logs go to stderr only.
    await createMcpServer(service).connect(new StdioServerTransport());
    console.error("[fo-squad] MCP server running on stdio");
    return;
  }

  const token = readToken(); // throws a clear message when missing or weak
  const port = Number(process.env.PORT) || 3000;

  // Same process as the MCP server, so the runner shares the store and the per-event locks.
  let runnerHealth: () => RunnerHealth = () => ({ enabled: false, lastTickAt: null, lastError: null });
  let dryRun: DryRunHooks | undefined;
  if (runnerEnabled()) {
    const built = createRunnerFromEnv({ service, store }); // throws a clear message on bad config
    built.runner.start();
    runnerHealth = () => built.runner.health();
    dryRun = built.dryRun;
    const c = built.config;
    console.error(
      `[fo-squad] runner on${c.dryRun ? " (DRY RUN: nothing is texted)" : ""}: every ${c.intervalMs}ms, ${c.timeZone}, ${c.organizerPhones.length} organizer number(s)`,
    );
  }

  const log = (line: string) => console.error(`[fo-squad] ${new Date().toISOString()} ${line}`);
  const app = createApp({ service, runnerHealth, log, ...(dryRun ? { dryRun } : {}), ...(token ? { token } : {}) });
  app.listen(port, (err?: Error) => {
    if (err) {
      console.error("[fo-squad] failed to start:", err);
      process.exit(1);
    }
    const store = process.env.DATA_DIR?.trim() ? `files in ${process.env.DATA_DIR}` : "memory (lost on restart)";
    const access = token ? "token required" : "NO TOKEN: open to anyone who can reach it (FO_SQUAD_ALLOW_NO_TOKEN=1, local development only)";
    console.error(`[fo-squad] listening on :${port}, POST /mcp (${access}), store: ${store}, time zone: ${timeZone}`);
  });
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error("[fo-squad] fatal:", err instanceof StartupError ? err.message : err);
    process.exit(1);
  });
}
