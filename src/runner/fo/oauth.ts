// File-backed OAuth state for Fo's MCP server. `npm run fo:login` signs in
// once in a browser and writes the file; the headless runner reuses it, and
// the SDK refreshes the access token (and saves the new one here) on a 401.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export const DEFAULT_OAUTH_FILE = "./data/fo-oauth.json";
export const DEFAULT_OAUTH_PORT = 8976;
export const DEFAULT_REDIRECT_URL = `http://127.0.0.1:${DEFAULT_OAUTH_PORT}/callback`;

export const HEADLESS_SIGN_IN_MESSAGE =
  "Fo sign-in expired. Run `npm run fo:login` on a machine with a browser and copy the token file to the server.";

export class FoSignInRequiredError extends Error {
  constructor(message = HEADLESS_SIGN_IN_MESSAGE) {
    super(message);
    this.name = "FoSignInRequiredError";
  }
}

/** Shape of the token file. Everything the SDK hands us is stored unchanged (it carries `issuer`). */
export interface FoOAuthFile {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface FileOAuthProviderOptions {
  /** Path of the JSON token file. Created (mode 0600) on first save. */
  file: string;
  /** false on servers: a needed browser sign-in throws FoSignInRequiredError instead. */
  interactive: boolean;
  /** Must match the login callback server. Default http://127.0.0.1:8976/callback. */
  redirectUrl?: string;
  /** Interactive mode: show/open the sign-in URL. */
  onRedirect?: (authorizationUrl: URL) => void | Promise<void>;
  clientName?: string;
}

export class FileOAuthProvider implements OAuthClientProvider {
  readonly file: string;
  private readonly interactive: boolean;
  private readonly redirect: string;
  private readonly onRedirect?: (authorizationUrl: URL) => void | Promise<void>;
  private readonly clientName: string;
  /** OAuth `state` of the sign-in in progress, checked by the login callback. */
  pendingState: string | undefined;

  constructor(opts: FileOAuthProviderOptions) {
    this.file = opts.file;
    this.interactive = opts.interactive;
    this.redirect = opts.redirectUrl ?? DEFAULT_REDIRECT_URL;
    this.onRedirect = opts.onRedirect;
    this.clientName = opts.clientName ?? "Fo Squad runner";
  }

  // Must stay defined even when headless: the SDK treats a missing redirect
  // URL as a client_credentials client and would never refresh.
  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.pendingState = randomBytes(16).toString("hex");
    return this.pendingState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.read()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update((f) => ({ ...f, clientInformation }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update((f) => ({ ...f, tokens }));
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update((f) => ({ ...f, codeVerifier }));
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.read()).codeVerifier;
    if (!verifier) throw new Error(`No PKCE code verifier saved in ${this.file}; start the sign-in again.`);
    return verifier;
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.read()).discoveryState;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.update((f) => ({ ...f, discoveryState }));
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await this.update((f) => {
      if (scope === "all") return {};
      const next = { ...f };
      if (scope === "client") delete next.clientInformation;
      if (scope === "tokens") delete next.tokens;
      if (scope === "verifier") delete next.codeVerifier;
      if (scope === "discovery") delete next.discoveryState;
      return next;
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) throw new FoSignInRequiredError();
    if (this.onRedirect) await this.onRedirect(authorizationUrl);
    else console.log(`Open this URL to sign in to Fo:\n${authorizationUrl.href}`);
  }

  /** Re-read on every call so a token file copied onto the server takes effect without a restart. */
  private async read(): Promise<FoOAuthFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as FoOAuthFile) : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`Can't read Fo token file ${this.file}: ${(err as Error).message}`);
    }
  }

  private writes: Promise<void> = Promise.resolve();

  /** Serialized read-modify-write, so concurrent saves from the SDK don't drop each other's fields. */
  private update(fn: (current: FoOAuthFile) => FoOAuthFile): Promise<void> {
    const run = this.writes.then(async () => writeJson0600(this.file, fn(await this.read())));
    this.writes = run.catch(() => {});
    return run;
  }
}

async function writeJson0600(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
