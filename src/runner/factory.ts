// Builds the runner from environment variables, for src/index.ts. Kept apart
// from the HTTP app so the server starts the same way with the runner off.

import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { tryNormalizePhone, type EventStore } from "../events/index.js";
import type { FoSquadService } from "../service.js";
import { ClaudeBrain } from "./brain.js";
import { FO_MCP_URL, McpFoClient } from "./fo/client.js";
import { FakeFoClient } from "./fo/fake.js";
import { FileOAuthProvider } from "./fo/oauth.js";
import { pollInbox } from "./inbox.js";
import { Runner, type PollInbox } from "./runner.js";
import { createRunnerStateStore } from "./state.js";
import { DEFAULT_QUIET_HOURS, DEFAULT_TIME_ZONE } from "./timers.js";
import type { FoClient, InboundText } from "./types.js";

export interface RunnerConfig {
  dryRun: boolean;
  foMcpUrl: string;
  foOAuthFile: string;
  organizerPhones: string[];
  intervalMs: number;
  timeZone: string;
}

/** Thrown for a misconfigured runner, so startup fails with a message that says what to set. */
export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerConfigError";
  }
}

/** Any of these lets the Anthropic SDK authenticate (key, token, profile or workload identity). */
const CLAUDE_CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_FEDERATION_RULE_ID",
] as const;

export function runnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FO_RUNNER?.trim() === "1";
}

export function readRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const problems: string[] = [];
  const dryRun = env.FO_RUNNER_DRY?.trim() === "1";

  const rawPhones = (env.ORGANIZER_PHONES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const organizerPhones: string[] = [];
  for (const raw of rawPhones) {
    const phone = tryNormalizePhone(raw);
    if (phone) organizerPhones.push(phone);
    else problems.push(`ORGANIZER_PHONES has "${raw}", which isn't a phone number.`);
  }
  if (rawPhones.length === 0) {
    problems.push(
      "ORGANIZER_PHONES is required when FO_RUNNER=1: comma-separated numbers allowed to start a dinner by texting Fo (e.g. +15551234567).",
    );
  }

  if (!CLAUDE_CREDENTIAL_VARS.some((name) => env[name]?.trim())) {
    problems.push(
      `ANTHROPIC_API_KEY (or another SDK credential: ${CLAUDE_CREDENTIAL_VARS.slice(1).join(", ")}) is required when FO_RUNNER=1: the runner's brain is a Claude call.`,
    );
  }

  const dataDir = env.DATA_DIR?.trim();
  // Without a volume, a restart forgets which nudges went out and texts people twice.
  if (!dataDir && !dryRun) {
    problems.push("DATA_DIR is required when FO_RUNNER=1 (unless FO_RUNNER_DRY=1), so the runner remembers what it already sent.");
  }

  let intervalMs = 60_000;
  if (env.RUNNER_INTERVAL_MS?.trim()) {
    intervalMs = Number(env.RUNNER_INTERVAL_MS);
    if (!Number.isFinite(intervalMs) || intervalMs < 5_000) {
      problems.push(`RUNNER_INTERVAL_MS must be a number of milliseconds, at least 5000 (got "${env.RUNNER_INTERVAL_MS}").`);
    }
  }

  const timeZone = env.RUNNER_TZ?.trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    problems.push(`RUNNER_TZ "${timeZone}" isn't a known time zone (use an IANA name like America/Los_Angeles).`);
  }

  if (problems.length > 0) throw new RunnerConfigError(`Fo runner misconfigured:\n- ${problems.join("\n- ")}`);

  return {
    dryRun,
    foMcpUrl: env.FO_MCP_URL?.trim() || FO_MCP_URL,
    foOAuthFile: path.resolve(env.FO_OAUTH_FILE?.trim() || path.join(dataDir || "./data", "fo-oauth.json")),
    organizerPhones,
    intervalMs,
    timeZone,
  };
}

export interface DryRunHooks {
  /** Simulates a text arriving in Fo's SMS inbox (thread title = sender's number or name). */
  inbound(from: string, text: string): void;
}

/** The fake Fo client for rehearsals: logs every instruction instead of texting anyone. */
export function createDryRunFo(log: (line: string) => void): FakeFoClient {
  return new FakeFoClient({
    respond: (message) => {
      log(`DRY RUN, would ask Fo:\n${message}`);
      return "Sent (dry run, nothing was texted).";
    },
  });
}

export function createFoClient(config: RunnerConfig, log: (line: string) => void): FoClient {
  if (config.dryRun) return createDryRunFo(log);
  return new McpFoClient({
    url: config.foMcpUrl,
    // Headless: an expired sign-in throws with instructions to run `npm run fo:login`.
    authProvider: new FileOAuthProvider({ file: config.foOAuthFile, interactive: false }),
  });
}

export interface RunnerDeps {
  service: FoSquadService;
  store: EventStore;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** Validates env and wires Fo, the brain, inbox polling and state into a Runner (not started). */
export function createRunnerFromEnv({ service, store, env = process.env, log }: RunnerDeps): {
  runner: Runner;
  config: RunnerConfig;
  dryRun?: DryRunHooks;
} {
  const config = readRunnerConfig(env);
  const logLine = log ?? ((line: string) => console.error(`[fo-runner] ${line}`));
  const fo = createFoClient(config, logLine);
  const stateStore = createRunnerStateStore(env);
  const brain = new ClaudeBrain({
    anthropic: new Anthropic({
      ...(env.ANTHROPIC_API_KEY?.trim() ? { apiKey: env.ANTHROPIC_API_KEY.trim() } : {}),
      ...(env.ANTHROPIC_AUTH_TOKEN?.trim() ? { authToken: env.ANTHROPIC_AUTH_TOKEN.trim() } : {}),
    }),
    service,
    store,
    fo,
    stateStore,
    organizerPhones: config.organizerPhones,
    log: (line) => logLine(`brain: ${line}`),
  });
  // Dry run: texts injected through the hook join the next poll directly
  // (a brand-new fake thread would otherwise only get a cursor, not be read).
  const injected: InboundText[] = [];
  const poll: PollInbox = config.dryRun
    ? async (client, state, opts) => {
        const polled = await pollInbox(client, state, opts);
        return { messages: [...polled.messages, ...injected.splice(0)], state: polled.state };
      }
    : pollInbox;
  const runner = new Runner({
    service,
    store,
    fo,
    brain,
    stateStore,
    organizerPhones: config.organizerPhones,
    pollInbox: poll,
    intervalMs: config.intervalMs,
    timeZone: config.timeZone,
    quietHours: DEFAULT_QUIET_HOURS,
    log: logLine,
  });
  const dryRun: DryRunHooks | undefined = config.dryRun
    ? {
        inbound(from, text) {
          const phone = tryNormalizePhone(from);
          injected.push({ ...(phone ? { phone } : {}), threadTitle: from, text, at: new Date().toISOString(), conversationId: "dry-run" });
          logLine(`DRY RUN, queued a text from ${from}: ${text}`);
        },
      }
    : undefined;
  return { runner, config, ...(dryRun ? { dryRun } : {}) };
}
