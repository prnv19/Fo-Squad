// Compact colored terminal transcript of a sandbox run, one line per event.

import type { SandboxEvent } from "./events.js";
import { formatLocal } from "./time.js";

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
} as const;
type Color = keyof typeof CODES;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " / ");

export interface PrinterOptions {
  timeZone: string;
  color?: boolean;
  write?: (line: string) => void;
}

export function createPrinter(opts: PrinterOptions): (event: SandboxEvent) => void {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const color = opts.color ?? true;
  const paint = (c: Color, s: string) => (color ? `${CODES[c]}${s}${CODES.reset}` : s);
  const names = new Map<string, string>([["fo", "Fo"], ["restaurant", "Restaurant"]]);
  const name = (id: string) => names.get(id) ?? id;
  let lastHeader = "";

  return (e) => {
    switch (e.type) {
      case "run_started":
        for (const p of e.people) names.set(p.id, p.name);
        write(paint("bold", `Sandbox: ${e.scenario}`));
        write(paint("dim", `People: ${e.people.map((p) => `${p.name}${p.role === "organizer" ? " (organizer)" : ""}`).join(", ")}`));
        return;
      case "clock": {
        const header = formatLocal(opts.timeZone, new Date(e.at));
        if (header !== lastHeader) write(paint("dim", `--- ${header} ---`));
        lastHeader = header;
        return;
      }
      case "text": {
        const fromFo = e.from === "fo";
        write(`${paint(fromFo ? "cyan" : "green", `${name(e.from)} -> ${name(e.to)}:`)} ${oneLine(e.text)}`);
        return;
      }
      case "tool": {
        const args = clip(JSON.stringify(e.args) ?? "", 160);
        const r = e.result as { stage?: string; error?: { code?: string; message?: string } } | undefined;
        const outcome = e.ok
          ? paint("dim", `ok${r?.stage ? ` [${r.stage}]` : ""}`)
          : paint("red", `failed: ${clip(`${r?.error?.code ?? ""} ${r?.error?.message ?? ""}`.trim(), 160)}`);
        write(`  ${paint("dim", "tool")} ${e.name} ${paint("dim", args)} -> ${outcome}`);
        return;
      }
      case "stubbed":
        write(`  ${paint("magenta", `STUBBED ${e.action}:`)} ${paint("magenta", oneLine(e.detail))}`);
        return;
      case "search":
        write(`  ${paint("blue", `search "${e.query}"${e.resultCount !== undefined ? ` (${e.resultCount} results)` : ""}`)}`);
        return;
      case "scheduled":
        write(paint("dim", `  timer for ${formatLocal(opts.timeZone, new Date(e.runAt))}: ${oneLine(e.description)}`));
        return;
      case "stage":
        write(paint("yellow", paint("bold", `=== stage: ${e.stage} ===`)));
        return;
      case "note":
        write(e.text.startsWith("AUDIT") ? paint("yellow", `  ${e.text}`) : paint("dim", `  note: ${oneLine(e.text)}`));
        return;
      case "error":
        write(paint("red", `  ERROR: ${e.message}`));
        return;
      case "run_finished": {
        write(paint("bold", `${e.ok ? "Finished" : "Ended"}: ${e.summary}`));
        const u = e.usage;
        if (u) {
          write(
            `Usage: ${u.inputTokens.toLocaleString()} input (incl. cache writes), ${u.cacheReadTokens.toLocaleString()} cache read, ${u.outputTokens.toLocaleString()} output tokens, ${u.webSearches} web searches.`,
          );
          if (u.estimatedUsd !== undefined) write(paint("bold", `Estimated cost: $${u.estimatedUsd.toFixed(2)} (estimate from list prices)`));
        }
        return;
      }
    }
  };
}
