// `npm run sandbox`: runs the default scenario end to end with Claude as Fo,
// prints the transcript, optionally serves the live viewer, and saves an HTML
// replay. This spends real Claude tokens and web searches (no texts, calls or
// payments ever happen).
//
// Env: SANDBOX_CITY (default "Denver, CO"), SANDBOX_TZ (default America/Denver),
// SANDBOX_VIEWER=1 + SANDBOX_PORT (default 4321), SANDBOX_SPEED (simulated
// seconds per real second; default 3600 with the viewer, otherwise no pacing),
// SANDBOX_MAX_TURNS (default 60), SANDBOX_BUDGET_MIN (wall-clock cap, default
// 90), SANDBOX_MODEL (default claude-opus-5-5).

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { runSandbox } from "./engine.js";
import { SandboxBus, type SandboxEvent } from "./events.js";
import { createPrinter } from "./printer.js";
import { defaultScenario } from "./scenario.js";

const CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_FEDERATION_RULE_ID"];

/** Env credentials, or a profile saved by `ant auth login` where the SDK looks for it. */
export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (CREDENTIAL_VARS.some((name) => env[name]?.trim())) return true;
  const home = env.HOME?.trim() || homedir();
  const root = env.XDG_CONFIG_HOME?.trim() ? path.join(env.XDG_CONFIG_HOME, "anthropic") : path.join(home, ".config", "anthropic");
  const dir = path.join(root, "credentials");
  try {
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<number> {
  const env = process.env;
  if (!hasAnthropicCredentials(env)) {
    console.error(
      "No Anthropic credentials found. Set ANTHROPIC_API_KEY or run `ant auth login`, then try again.\nThe sandbox calls Claude (it plays Fo) and uses real web search, so it needs an API credential.",
    );
    return 1;
  }

  const scenario = defaultScenario({ ...(env.SANDBOX_CITY ? { city: env.SANDBOX_CITY } : {}), ...(env.SANDBOX_TZ ? { timeZone: env.SANDBOX_TZ } : {}) });
  const bus = new SandboxBus();
  bus.subscribe(createPrinter({ timeZone: scenario.timeZone, color: process.stdout.isTTY && !env.NO_COLOR }));

  const viewerOn = env.SANDBOX_VIEWER?.trim() === "1";
  let closeViewer: (() => Promise<void>) | undefined;
  if (viewerOn) {
    try {
      // Imported lazily so the CLI still runs if the viewer module is missing or broken.
      const viewer = await import("./viewer.js");
      const started = await viewer.startViewer(bus, { port: positiveNumber(env.SANDBOX_PORT, 4321) });
      closeViewer = () => started.close();
      console.log(`Live viewer: ${started.url}`);
    } catch (err) {
      console.error(`Couldn't start the viewer (${err instanceof Error ? err.message : String(err)}); continuing without it.`);
    }
  }

  const anthropic = new Anthropic({ ...(env.ANTHROPIC_API_KEY?.trim() ? { apiKey: env.ANTHROPIC_API_KEY.trim() } : {}) });
  const result = await runSandbox({
    scenario,
    anthropic,
    bus,
    ...(env.SANDBOX_MODEL?.trim() ? { model: env.SANDBOX_MODEL.trim() } : {}),
    maxCoordinatorTurns: positiveNumber(env.SANDBOX_MAX_TURNS, 60),
    wallClockBudgetMs: positiveNumber(env.SANDBOX_BUDGET_MIN, 90) * 60_000,
    speed: positiveNumber(env.SANDBOX_SPEED, viewerOn ? 3600 : Infinity),
  });

  await saveReport(bus.history);
  console.log(`Estimated cost: $${result.estimatedUsd.toFixed(2)} (estimate: list prices for ${env.SANDBOX_MODEL?.trim() || "claude-opus-5-5"}, not a bill)`);

  if (closeViewer) {
    console.log("Viewer still running so you can look around. Press Ctrl+C to exit.");
    await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
    await closeViewer();
  }
  return result.ok ? 0 : 2;
}

async function saveReport(history: SandboxEvent[]): Promise<void> {
  try {
    const report = (await import("./report.js")) as { writeReport?: (h: SandboxEvent[], p: string) => Promise<void> };
    if (typeof report.writeReport !== "function") return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(process.cwd(), "sandbox-runs", `${stamp}.html`);
    await report.writeReport(history, file);
    console.log(`Replay saved: ${file}`);
  } catch (err) {
    console.error(`Couldn't save the replay (${err instanceof Error ? err.message : String(err)}).`);
  }
}

// Only when run as a script, so tests can import hasAnthropicCredentials without starting a run.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
