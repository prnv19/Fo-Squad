import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../events/index.js";
import { createApp } from "../index.js";
import { FoSquadService } from "../service.js";
import { createRunnerFromEnv, readRunnerConfig, RunnerConfigError, runnerEnabled } from "./factory.js";

const base = {
  FO_RUNNER: "1",
  ORGANIZER_PHONES: "+1 (555) 000-0001, 5550000009",
  ANTHROPIC_API_KEY: "test-key",
  DATA_DIR: "/data",
};

describe("readRunnerConfig", () => {
  it("reads defaults and normalizes organizer phones", () => {
    const c = readRunnerConfig(base);
    expect(c).toMatchObject({
      dryRun: false,
      foMcpUrl: "https://mcp.api.wajo.ai/fo",
      foOAuthFile: "/data/fo-oauth.json",
      organizerPhones: ["+15550000001", "+15550000009"],
      intervalMs: 60_000,
      timeZone: "America/Los_Angeles",
    });
    expect(runnerEnabled(base)).toBe(true);
    expect(runnerEnabled({})).toBe(false);
  });

  it("fails fast with a clear message when ORGANIZER_PHONES is missing", () => {
    expect(() => readRunnerConfig({ ...base, ORGANIZER_PHONES: "" })).toThrow(RunnerConfigError);
    expect(() => readRunnerConfig({ ...base, ORGANIZER_PHONES: " " })).toThrow(/ORGANIZER_PHONES is required/);
    expect(() => readRunnerConfig({ ...base, ORGANIZER_PHONES: "not-a-phone" })).toThrow(/isn't a phone number/);
  });

  it("requires a Claude credential, a data dir (unless dry) and a real time zone", () => {
    expect(() => readRunnerConfig({ ...base, ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => readRunnerConfig({ ...base, DATA_DIR: "" })).toThrow(/DATA_DIR/);
    expect(readRunnerConfig({ ...base, DATA_DIR: "", FO_RUNNER_DRY: "1" }).dryRun).toBe(true);
    expect(() => readRunnerConfig({ ...base, RUNNER_TZ: "Mars/Olympus" })).toThrow(/RUNNER_TZ/);
    expect(() => readRunnerConfig({ ...base, RUNNER_INTERVAL_MS: "10" })).toThrow(/RUNNER_INTERVAL_MS/);
  });
});

describe("dry run wiring", () => {
  it("routes an injected text through the fake Fo client without texting anyone", async () => {
    const store = new MemoryStore();
    const logs: string[] = [];
    const { runner, dryRun } = createRunnerFromEnv({
      service: new FoSquadService(store),
      store,
      env: { ...base, DATA_DIR: "", FO_RUNNER_DRY: "1" },
      log: (l) => logs.push(l),
    });
    expect(dryRun).toBeDefined();
    // A stranger's text is dropped before any Claude call.
    dryRun!.inbound("+15557770000", "hello");
    const report = await runner.tick();
    expect(report.inbound).toBe(1);
    expect(report.ignored).toBe(1);
    expect(logs.some((l) => l.includes("DRY RUN, queued"))).toBe(true);
  });
});

describe("/health", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it("reports the runner when one is wired", async () => {
    const app = createApp({
      service: new FoSquadService(new MemoryStore()),
      runnerHealth: () => ({ enabled: true, lastTickAt: "2026-10-17T18:00:00.000Z", lastError: null }),
    });
    const server = app.listen(0);
    close = () => server.close();
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.json()).toEqual({
      ok: true,
      runner: { enabled: true, lastTickAt: "2026-10-17T18:00:00.000Z", lastError: null },
    });
  });
});
