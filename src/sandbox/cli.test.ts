import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasAnthropicCredentials } from "./cli.js";

describe("hasAnthropicCredentials", () => {
  it("accepts an API key or a profile saved by `ant auth login`, and nothing else", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "sandbox-creds-"));
    expect(hasAnthropicCredentials({ HOME: empty, XDG_CONFIG_HOME: empty })).toBe(false);
    expect(hasAnthropicCredentials({ HOME: empty, XDG_CONFIG_HOME: empty, ANTHROPIC_API_KEY: "sk-test" })).toBe(true);

    const xdg = mkdtempSync(path.join(tmpdir(), "sandbox-creds-"));
    mkdirSync(path.join(xdg, "anthropic", "credentials"), { recursive: true });
    writeFileSync(path.join(xdg, "anthropic", "credentials", "default.json"), "{}");
    expect(hasAnthropicCredentials({ HOME: empty, XDG_CONFIG_HOME: xdg })).toBe(true);
  });
});
