import { describe, expect, it } from "vitest";
import { formatResultLine, parseEdgeArgs } from "./cli.js";
import type { EdgeCaseResult } from "./harness.js";
import { selectCases } from "./index.js";
import type { EdgeCase } from "./types.js";

const kase = (id: string, area: EdgeCase["area"], critical: boolean): EdgeCase => ({
  id,
  title: id,
  area,
  planRef: "x",
  critical,
  seed: async () => ({ eventId: "e" }),
  inbound: [],
  checks: [],
});

describe("edge CLI", () => {
  it("parses flags with defaults", () => {
    expect(parseEdgeArgs([], {})).toEqual({ filter: {}, concurrency: 3, maxUsd: 25, backend: "claude-code", model: "claude-haiku-5-5", list: false, viewer: false });
    expect(parseEdgeArgs(["--only", "a, b", "--area", "security", "--critical", "--concurrency", "2", "--max-usd", "7.5", "--model", "m"], {})).toEqual({
      filter: { only: ["a", "b"], area: "security", criticalOnly: true },
      concurrency: 2,
      maxUsd: 7.5,
      backend: "claude-code",
      model: "m",
      list: false,
      viewer: false,
    });
    expect(parseEdgeArgs([], { SANDBOX_MODEL: "env-model" }).model).toBe("env-model");
    expect(parseEdgeArgs(["--backend", "api"], {})).toMatchObject({ backend: "api", model: "claude-opus-5-5" });
    expect(parseEdgeArgs([], { SANDBOX_BACKEND: "api" }).backend).toBe("api");
    expect(() => parseEdgeArgs(["--backend", "bedrock"], {})).toThrow(/backend must be/);
    expect(() => parseEdgeArgs(["--area", "dessert"], {})).toThrow(/--area must be one of/);
    expect(() => parseEdgeArgs(["--max-usd", "0"], {})).toThrow(/--max-usd/);
    expect(() => parseEdgeArgs(["--bogus"], {})).toThrow();
  });

  it("selects cases by id, area and criticality, and rejects unknown or duplicate ids", () => {
    const all = [kase("a", "security", true), kase("b", "voting", false), kase("c", "security", false)];
    expect(selectCases({}, all).map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(selectCases({ area: "security" }, all).map((c) => c.id)).toEqual(["a", "c"]);
    expect(selectCases({ area: "security", criticalOnly: true }, all).map((c) => c.id)).toEqual(["a"]);
    expect(selectCases({ only: ["b", "c"] }, all).map((c) => c.id)).toEqual(["b", "c"]);
    expect(() => selectCases({ only: ["zzz"] }, all)).toThrow(/No edge case with id: zzz/);
    expect(() => selectCases({}, [...all, kase("a", "voting", false)])).toThrow(/Duplicate edge case id: a/);
  });

  it("prints one line per case plus its failed checks", () => {
    const r = {
      id: "x",
      area: "booking",
      critical: true,
      passed: false,
      runs: 2,
      estimatedUsd: 0.5,
      checks: [
        { description: "good", passed: true },
        { description: "bad", passed: false, detail: "why\nnot" },
      ],
    } as EdgeCaseResult;
    expect(formatResultLine(r, { done: 1, total: 4, totalUsd: 1.25 })).toEqual([
      "[1/4] FAIL  booking   x (critical)  2 run(s)  $0.50  (total $1.25)",
      "      - bad: why / not",
    ]);
  });
});
