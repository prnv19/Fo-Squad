// The sandbox must have no code path to Fo, phones, Venmo or restaurants. The
// only client anywhere in its import graph is the Anthropic SDK, so these
// tests walk every relative import (static and dynamic) from the sandbox's
// entry points and check what they can reach.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY_POINTS = ["sandbox/engine.ts", "sandbox/cli.ts", "sandbox/scenario.ts", "sandbox/personas.ts", "sandbox/clock.ts", "sandbox/printer.ts"];

interface Graph {
  files: Set<string>;
  bareImports: Set<string>;
}

function walk(entries: string[]): Graph {
  const files = new Set<string>();
  const bareImports = new Set<string>();
  const stack = entries.map((e) => path.join(SRC, e));
  while (stack.length) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const code = readFileSync(file, "utf8");
    const specs = [...code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const spec of specs) {
      if (!spec.startsWith(".")) {
        bareImports.add(spec);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), spec).replace(/\.js$/, ".ts");
      if (existsSync(resolved)) stack.push(resolved);
    }
  }
  return { files, bareImports };
}

describe("sandbox safety", () => {
  const graph = walk(ENTRY_POINTS);
  const rel = [...graph.files].map((f) => path.relative(SRC, f));

  it("imports nothing from src/runner/fo/ (directly or transitively)", () => {
    expect(rel.length).toBeGreaterThan(5);
    expect(rel.filter((f) => f.startsWith(path.join("runner", "fo")))).toEqual([]);
    // The runner's factory is what wires up the real Fo client.
    expect(rel).not.toContain(path.join("runner", "factory.ts"));
  });

  it("the engine reaches no network client besides the Anthropic SDK", () => {
    const engine = walk(["sandbox/engine.ts"]);
    const bare = [...engine.bareImports];
    for (const banned of ["node:http", "node:https", "node:net", "node:child_process", "@modelcontextprotocol/sdk", "express"]) {
      expect(bare.filter((b) => b === banned || b.startsWith(`${banned}/`))).toEqual([]);
    }
    const files = [...engine.files].map((f) => readFileSync(f, "utf8")).join("\n");
    expect(files).not.toMatch(/\bfetch\s*\(/);
  });
});
