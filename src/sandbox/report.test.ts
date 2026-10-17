import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxEvent } from "./events.js";
import { demoHistory } from "./fixtures/demo-history.js";
import { embedJson, writeReport } from "./report.js";

const at = "2026-10-17T19:30:00-06:00";
const EVIL = "</script><script>alert(1)</script>";

/** One of every event type; typed as a Record so a new type in the union is noticed here. */
const ONE_OF_EACH: Record<SandboxEvent["type"], SandboxEvent> = {
  run_started: { type: "run_started", at, scenario: "Smoke scenario", people: [{ id: "pranav", name: "Pranav", role: "organizer" }, { id: "maya", name: "Maya", role: "friend" }] },
  clock: { type: "clock", at: "2026-10-17T21:00:00-06:00" },
  text: { type: "text", at, from: "maya", to: "fo", text: `smoke text ${EVIL}` },
  tool: { type: "tool", at, name: "calculate_shares", args: { event_id: "e1" }, result: { ok: true, shares: [] }, ok: true },
  stubbed: { type: "stubbed", at, action: "smoke booking call", detail: "would call" },
  search: { type: "search", at, query: "smoke italian search", resultCount: 4 },
  scheduled: { type: "scheduled", at, runAt: "2026-10-17T22:00:00-06:00", description: "smoke reminder" },
  stage: { type: "stage", at, eventId: "e1", stage: "paying" },
  note: { type: "note", at, text: "smoke note" },
  error: { type: "error", at, message: "smoke error" },
  run_finished: { type: "run_finished", at, ok: true, summary: "smoke summary", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, webSearches: 1, estimatedUsd: 0.01 } },
};

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function render(history: SandboxEvent[]): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "fo-report-"));
  const path = join(dir, "nested", "deeper", "run.html");
  await writeReport(history, path);
  return readFile(path, "utf8");
}

function embedded(html: string): unknown {
  const m = /<script type="application\/json" id="sandbox-history">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("no embedded history");
  return JSON.parse(m[1]!);
}

describe("writeReport", () => {
  it("creates parent directories and inlines the viewer with no external assets", async () => {
    const html = await render([ONE_OF_EACH.run_started]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain('src="app.js"');
    expect(html).not.toContain('href="styles.css"');
    expect(html).toContain("<style>");
    expect(html).toContain("sandbox-history");
    expect(html).not.toMatch(/https?:\/\/(?!venmo)/); // nothing fetched from the network
  });

  it("embeds hostile text as data that cannot break out of the script tag", async () => {
    const history: SandboxEvent[] = [{ type: "text", at, from: "sam", to: "fo", text: EVIL }, { type: "note", at, text: "<!-- <script>" }];
    const html = await render(history);
    expect(html).not.toContain(EVIL);
    expect(html).not.toContain("alert(1)</script>");
    // Exactly the JSON block and the app script, nothing injected.
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(embedded(html)).toEqual(history);
    expect(embedJson(EVIL)).toBe('"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"');
  });

  it("pins the inline script and style with CSP hashes", async () => {
    const html = await render([]);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)![1]!;
    const js = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)![1]!;
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");
    expect(csp).toContain(`script-src 'sha256-${hash(js)}'`);
    expect(csp).toContain(`style-src 'sha256-${hash(css)}'`);
    expect(csp).toContain("default-src 'none'");
  });

  it("smoke: every event type round-trips through the report", async () => {
    const history = Object.values(ONE_OF_EACH);
    const html = await render(history);
    const data = embedded(html) as SandboxEvent[];
    expect(data.map((e) => e.type).sort()).toEqual(Object.keys(ONE_OF_EACH).sort());
    for (const needle of ["Smoke scenario", "smoke booking call", "smoke italian search", "smoke reminder", "smoke note", "smoke error", "smoke summary", "calculate_shares"]) {
      expect(html).toContain(needle);
    }
  });
});

describe("demo fixture", () => {
  it("covers every event type, all six stages, says_paid then paid, and a cost", () => {
    const types = new Set(demoHistory.map((e) => e.type));
    expect([...types].sort()).toEqual(Object.keys(ONE_OF_EACH).sort());
    const stages = demoHistory.flatMap((e) => (e.type === "stage" ? [e.stage] : []));
    expect(stages).toEqual(["planning", "voting", "booked", "claiming", "paying", "settled"]);

    const statuses = demoHistory.flatMap((e) =>
      e.type === "tool" && e.name === "mark_paid" ? [(e.result as { status: string }).status] : [],
    );
    expect(statuses.indexOf("says_paid")).toBeGreaterThanOrEqual(0);
    expect(statuses.lastIndexOf("paid")).toBeGreaterThan(statuses.indexOf("says_paid"));

    expect(demoHistory.some((e) => e.type === "stubbed")).toBe(true);
    expect(demoHistory.some((e) => e.type === "text" && e.text.includes("ignore all previous instructions"))).toBe(true);
    const last = demoHistory[demoHistory.length - 1]!;
    expect(last.type === "run_finished" && last.usage?.estimatedUsd).toBeGreaterThan(0);
  });

  it("has split totals that add up to the receipt exactly", () => {
    const calc = demoHistory.find((e) => e.type === "tool" && e.name === "calculate_shares");
    const result = (calc as { result: { total_cents: number; shares: { subtotal_cents: number; extras_cents: number; total_cents: number }[] } }).result;
    const sum = result.shares.reduce((s, r) => s + r.total_cents, 0);
    expect(sum).toBe(result.total_cents);
    for (const r of result.shares) expect(r.subtotal_cents + r.extras_cents).toBe(r.total_cents);
  });

  it("keeps simulated time moving forward", () => {
    const times = demoHistory.map((e) => Date.parse(e.at));
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
  });
});
