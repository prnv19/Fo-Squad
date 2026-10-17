import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileOAuthProvider, FoSignInRequiredError, HEADLESS_SIGN_IN_MESSAGE } from "./oauth.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fo-oauth-"));
  file = path.join(dir, "nested", "fo-oauth.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileOAuthProvider", () => {
  it("returns nothing before anything is saved, without creating the file", async () => {
    const p = new FileOAuthProvider({ file, interactive: false });
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toBeUndefined();
    await expect(p.codeVerifier()).rejects.toThrow(/code verifier/);
    await expect(stat(path.dirname(file))).rejects.toThrow();
  });

  it("persists client info, tokens, verifier and discovery state across instances, mode 0600", async () => {
    const a = new FileOAuthProvider({ file, interactive: true });
    await Promise.all([
      a.saveClientInformation({ client_id: "abc", issuer: "https://auth.example/" } as never),
      a.saveTokens({ access_token: "t1", token_type: "Bearer", refresh_token: "r1", issuer: "https://auth.example/" } as never),
      a.saveCodeVerifier("verifier-1"),
      a.saveDiscoveryState({ authorizationServerUrl: "https://auth.example/" }),
    ]);

    const b = new FileOAuthProvider({ file, interactive: false });
    expect(await b.clientInformation()).toEqual({ client_id: "abc", issuer: "https://auth.example/" });
    expect(await b.tokens()).toEqual({ access_token: "t1", token_type: "Bearer", refresh_token: "r1", issuer: "https://auth.example/" });
    expect(await b.codeVerifier()).toBe("verifier-1");
    expect(await b.discoveryState()).toEqual({ authorizationServerUrl: "https://auth.example/" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).tokens.access_token).toBe("t1");
  });

  it("invalidates only the requested credentials", async () => {
    const p = new FileOAuthProvider({ file, interactive: false });
    await p.saveClientInformation({ client_id: "abc" });
    await p.saveTokens({ access_token: "t1", token_type: "Bearer" });
    await p.invalidateCredentials("tokens");
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toEqual({ client_id: "abc" });
    await p.invalidateCredentials("all");
    expect(await p.clientInformation()).toBeUndefined();
  });

  it("keeps a redirect URL and public-client metadata even when headless", () => {
    const p = new FileOAuthProvider({ file, interactive: false, redirectUrl: "http://127.0.0.1:9999/callback" });
    expect(p.redirectUrl).toBe("http://127.0.0.1:9999/callback");
    expect(p.clientMetadata).toMatchObject({
      redirect_uris: ["http://127.0.0.1:9999/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
  });

  it("refuses browser sign-in when headless, with the fo:login instruction", async () => {
    const p = new FileOAuthProvider({ file, interactive: false });
    const err = await Promise.resolve(p.redirectToAuthorization(new URL("https://auth.example/authorize"))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FoSignInRequiredError);
    expect((err as Error).message).toBe(HEADLESS_SIGN_IN_MESSAGE);
    expect(HEADLESS_SIGN_IN_MESSAGE).toBe(
      "Fo sign-in expired. Run `npm run fo:login` on a machine with a browser and copy the token file to the server.",
    );
  });

  it("hands the sign-in URL to onRedirect when interactive, and generates a fresh state each time", async () => {
    const seen: string[] = [];
    const p = new FileOAuthProvider({ file, interactive: true, onRedirect: (u) => void seen.push(u.href) });
    await p.redirectToAuthorization(new URL("https://auth.example/authorize?x=1"));
    expect(seen).toEqual(["https://auth.example/authorize?x=1"]);
    const s1 = p.state();
    const s2 = p.state();
    expect(s1).not.toBe(s2);
    expect(p.pendingState).toBe(s2);
  });
});
