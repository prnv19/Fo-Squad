// `npm run sandbox:edge`: runs the edge-case suite (short seeded cases, Claude
// as Fo) with bounded concurrency and a cost cap, prints one line per case,
// and writes sandbox-runs/edge-<timestamp>/ (summary.md, summary.json, one
// HTML replay per case). Spends real Claude tokens; nothing real is texted,
// called or paid.
//
//   --only id1,id2   run just these cases
//   --area security  run one area
//   --critical       run only must-work-before-demo cases
//   --concurrency 3  cases at once (each has its own store and clock)
//   --max-usd 25     stop starting cases once finished ones cost this much
//   --model <id>     default claude-opus-5-5 (or SANDBOX_MODEL)
//   --list           print the selected cases and exit (free)
//
// Also runs as `node --env-file=.env --import tsx src/sandbox/edge/cli.ts`.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { hasAnthropicCredentials } from "../cli.js";
import { DEFAULT_SANDBOX_MODEL } from "../engine.js";
import { SandboxBus } from "../events.js";
import { runEdgeCase, runSuite, type EdgeCaseResult } from "./harness.js";
import { EDGE_AREAS, selectCases, type CaseFilter } from "./index.js";
import { edgeRunDir, writeEdgeReports } from "./report.js";
import type { EdgeArea } from "./types.js";

export interface EdgeCliOptions {
  filter: CaseFilter;
  concurrency: number;
  maxUsd: number;
  model: string;
  list: boolean;
  viewer: boolean;
}

export function parseEdgeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): EdgeCliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string" },
      area: { type: "string" },
      critical: { type: "boolean", default: false },
      concurrency: { type: "string" },
      "max-usd": { type: "string" },
      model: { type: "string" },
      list: { type: "boolean", default: false },
      viewer: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const area = values.area?.trim();
  if (area && !EDGE_AREAS.includes(area as EdgeArea)) throw new Error(`--area must be one of ${EDGE_AREAS.join(", ")}`);
  const number = (raw: string | undefined, flag: string, fallback: number) => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number`);
    return n;
  };
  const only = values.only?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    filter: {
      ...(only?.length ? { only } : {}),
      ...(area ? { area: area as EdgeArea } : {}),
      ...(values.critical ? { criticalOnly: true } : {}),
    },
    concurrency: Math.floor(number(values.concurrency, "--concurrency", 3)),
    maxUsd: number(values["max-usd"], "--max-usd", 25),
    model: values.model?.trim() || env.SANDBOX_MODEL?.trim() || DEFAULT_SANDBOX_MODEL,
    list: values.list ?? false,
    viewer: values.viewer ?? false,
  };
}

export function formatResultLine(r: EdgeCaseResult, progress: { done: number; total: number; totalUsd: number }): string[] {
  const failed = r.checks.filter((k) => !k.passed);
  const head = `[${progress.done}/${progress.total}] ${r.passed ? "PASS" : "FAIL"}  ${r.area.padEnd(9)} ${r.id}${r.critical ? " (critical)" : ""}  ${r.runs} run(s)  $${r.estimatedUsd.toFixed(2)}  (total $${progress.totalUsd.toFixed(2)})`;
  return [head, ...failed.map((k) => `      - ${k.description}${k.detail ? `: ${k.detail.replace(/\s*\n\s*/g, " / ").slice(0, 300)}` : ""}`)];
}

async function main(): Promise<number> {
  let opts: EdgeCliOptions;
  let cases;
  try {
    opts = parseEdgeArgs(process.argv.slice(2));
    cases = selectCases(opts.filter);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (!cases.length) {
    console.error("No edge cases match.");
    return 1;
  }
  if (opts.list) {
    for (const c of cases) console.log(`${c.id.padEnd(40)} ${c.area.padEnd(9)} ${c.critical ? "critical" : "        "}  ${c.title}`);
    return 0;
  }
  if (opts.viewer) console.log("No live viewer for the suite; each case gets an HTML replay in the run folder.");
  if (!hasAnthropicCredentials(process.env)) {
    console.error("No Anthropic credentials found. Set ANTHROPIC_API_KEY or run `ant auth login`, then try again.");
    return 1;
  }

  const anthropic = new Anthropic({ ...(process.env.ANTHROPIC_API_KEY?.trim() ? { apiKey: process.env.ANTHROPIC_API_KEY.trim() } : {}) });
  const startedAt = new Date();
  console.log(`Running ${cases.length} edge case(s), ${opts.concurrency} at a time, cost cap $${opts.maxUsd.toFixed(2)}, model ${opts.model}.`);

  const suite = await runSuite(cases, {
    concurrency: opts.concurrency,
    maxUsd: opts.maxUsd,
    runCase: (c) => runEdgeCase(c, { anthropic, bus: new SandboxBus(), model: opts.model }),
    onResult: (r, progress) => {
      for (const line of formatResultLine(r, progress)) console.log(line);
    },
  });

  if (suite.skipped.length) console.log(`Skipped after the $${opts.maxUsd.toFixed(2)} cost cap: ${suite.skipped.map((c) => c.id).join(", ")}`);
  const passed = suite.results.filter((r) => r.passed).length;
  const criticalFailed = suite.results.filter((r) => r.critical && !r.passed).length;
  console.log(`${passed}/${suite.results.length} passed (${criticalFailed} critical failure(s)). Estimated cost $${suite.totalUsd.toFixed(2)} (list-price estimate, not a bill).`);

  try {
    const paths = await writeEdgeReports(
      { results: suite.results, skipped: suite.skipped, startedAt, finishedAt: new Date(), model: opts.model, maxUsd: opts.maxUsd },
      edgeRunDir(path.join(process.cwd(), "sandbox-runs"), startedAt),
    );
    console.log(`Report: ${paths.summaryMd}`);
  } catch (err) {
    console.error(`Couldn't write the reports (${err instanceof Error ? err.message : String(err)}).`);
  }
  return passed === suite.results.length && !suite.skipped.length ? 0 : 2;
}

// Only when run as a script, so tests can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
