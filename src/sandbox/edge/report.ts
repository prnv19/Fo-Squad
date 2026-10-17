// Suite reports: summary.md (table plus a compact transcript per case for
// human review), summary.json (machine-readable, no histories), and one HTML
// replay per case via the full sandbox's writeReport.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxEvent } from "../events.js";
import { writeReport } from "../report.js";
import { formatLocal } from "../time.js";
import type { EdgeCaseResult } from "./harness.js";
import type { EdgeCase } from "./types.js";

export interface EdgeReportInput {
  results: EdgeCaseResult[];
  skipped: Pick<EdgeCase, "id" | "title" | "area" | "critical">[];
  startedAt: Date;
  finishedAt: Date;
  model: string;
  maxUsd?: number;
}

export interface EdgeReportPaths {
  dir: string;
  summaryMd: string;
  summaryJson: string;
  html: string[];
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " / ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cell = (s: string) => oneLine(s).replace(/\|/g, "\\|");
// Transcripts sit in fenced blocks; a stray fence in a text would end the block early.
const fenceSafe = (s: string) => s.replace(/```/g, "'''");

export const caseFileName = (id: string) => id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "case";

export function edgeRunDir(root: string, at: Date = new Date()): string {
  return join(root, `edge-${at.toISOString().replace(/[:.]/g, "-")}`);
}

function totals(input: EdgeReportInput) {
  const passed = input.results.filter((r) => r.passed).length;
  const criticalFailed = input.results.filter((r) => r.critical && !r.passed).length;
  const usdTotal = input.results.reduce((sum, r) => sum + r.estimatedUsd, 0);
  const runs = input.results.reduce((sum, r) => sum + r.runs, 0);
  return { ran: input.results.length, passed, failed: input.results.length - passed, criticalFailed, skipped: input.skipped.length, usd: Math.round(usdTotal * 10_000) / 10_000, runs };
}

/** One line per event that matters for review: texts, tool calls, stubs, stages, notes, errors. */
export function compactTranscript(history: SandboxEvent[]): string[] {
  const start = history.find((e) => e.type === "run_started");
  const tz = start?.type === "run_started" ? (start.timeZone ?? "UTC") : "UTC";
  const names = new Map<string, string>([["fo", "Fo"]]);
  if (start?.type === "run_started") for (const p of start.people) names.set(p.id, p.name);
  const name = (id: string) => names.get(id) ?? id;
  const when = (at: string) => formatLocal(tz, new Date(at));

  const lines: string[] = [];
  for (const e of history) {
    switch (e.type) {
      case "text":
        lines.push(`[${when(e.at)}] ${name(e.from)} -> ${name(e.to)}: ${oneLine(e.text)}`);
        break;
      case "tool": {
        const r = e.result as { error?: { code?: string; message?: string } } | undefined;
        const outcome = e.ok ? "ok" : `FAILED ${clip(oneLine(`${r?.error?.code ?? ""} ${r?.error?.message ?? ""}`.trim()), 200)}`;
        lines.push(`    tool ${e.name} ${clip(JSON.stringify(e.args) ?? "", 240)} -> ${outcome}`);
        break;
      }
      case "stubbed":
        lines.push(`    STUBBED ${e.action}: ${oneLine(e.detail)}`);
        break;
      case "search":
        lines.push(`    search "${e.query}"${e.resultCount !== undefined ? ` (${e.resultCount} results)` : ""}`);
        break;
      case "scheduled":
        lines.push(`    timer for ${when(e.runAt)}: ${oneLine(e.description)}`);
        break;
      case "stage":
        lines.push(`    == stage: ${e.stage} ==`);
        break;
      case "note":
        lines.push(e.text.startsWith("AUDIT") || e.text.startsWith("CHECK") ? `    ${oneLine(e.text)}` : `    note: ${oneLine(e.text)}`);
        break;
      case "error":
        lines.push(`    ERROR: ${oneLine(e.message)}`);
        break;
      default:
        break;
    }
  }
  return lines;
}

export function renderSummaryMarkdown(input: EdgeReportInput): string {
  const t = totals(input);
  const out: string[] = [
    "# Fo Squad sandbox: edge-case suite",
    "",
    `Started ${input.startedAt.toISOString()}, finished ${input.finishedAt.toISOString()}. Model ${input.model}.`,
    "",
    `**${t.passed}/${t.ran} passed**, ${t.failed} failed (${t.criticalFailed} critical), ${t.skipped} skipped. ${t.runs} coordinator runs. Estimated cost ${usd(t.usd)}${input.maxUsd !== undefined ? ` (cap ${usd(input.maxUsd)})` : ""}; list-price estimate, not a bill.`,
    "",
    "| Case | Area | Critical | Result | Failed checks | Runs | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of input.results) {
    const failed = r.checks.filter((k) => !k.passed).map((k) => `${k.description}${k.detail ? `: ${clip(k.detail, 200)}` : ""}`);
    out.push(
      `| [${cell(r.id)}](#${caseFileName(r.id)}) | ${r.area} | ${r.critical ? "yes" : ""} | ${r.passed ? "PASS" : "**FAIL**"} | ${cell(failed.join("; "))} | ${r.runs} | ${usd(r.estimatedUsd)} |`,
    );
  }
  for (const s of input.skipped) out.push(`| ${cell(s.id)} | ${s.area} | ${s.critical ? "yes" : ""} | SKIPPED (cost cap) |  | 0 | $0.00 |`);

  for (const r of input.results) {
    out.push(
      "",
      `<a id="${caseFileName(r.id)}"></a>`,
      `## ${r.passed ? "PASS" : "FAIL"}: ${r.id}`,
      "",
      `${r.title} (${r.area}${r.critical ? ", critical" : ""}; plan: ${r.planRef}). ${r.stopReason} ${r.runs} run(s), ${r.usage.requests} model request(s), ${usd(r.estimatedUsd)}. Replay: [${caseFileName(r.id)}.html](${caseFileName(r.id)}.html)`,
      "",
    );
    for (const k of r.checks) out.push(`- ${k.passed ? "PASS" : "FAIL"} ${k.description}${k.detail ? `: ${oneLine(k.detail)}` : ""}`);
    if (r.duplicateTimers) out.push(`- NOTE ${r.duplicateTimers} duplicate timer(s)`);
    for (const f of r.auditFlags) out.push(`- AUDIT ${oneLine(f)}`);
    out.push("", "```text", ...compactTranscript(r.history).map(fenceSafe), "```");
  }
  return `${out.join("\n")}\n`;
}

export async function writeEdgeReports(input: EdgeReportInput, dir: string): Promise<EdgeReportPaths> {
  await mkdir(dir, { recursive: true });
  const html: string[] = [];
  for (const r of input.results) {
    const file = join(dir, `${caseFileName(r.id)}.html`);
    await writeReport(r.history, file);
    html.push(file);
  }
  const summaryMd = join(dir, "summary.md");
  await writeFile(summaryMd, renderSummaryMarkdown(input), "utf8");

  const summaryJson = join(dir, "summary.json");
  const json = {
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    model: input.model,
    ...(input.maxUsd !== undefined ? { maxUsd: input.maxUsd } : {}),
    totals: totals(input),
    cases: input.results.map(({ history: _history, ...r }) => ({ ...r, replay: `${caseFileName(r.id)}.html` })),
    skipped: input.skipped.map((s) => ({ id: s.id, title: s.title, area: s.area, critical: s.critical })),
  };
  await writeFile(summaryJson, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return { dir, summaryMd, summaryJson, html };
}
