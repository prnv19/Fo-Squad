// `npm run fo:login`: one-time browser sign-in to Fo, run on a laptop. Writes
// the token file the headless runner uses, then lists conversations once to
// prove the connection. It never calls ask_fo: Fo's actions are real.
//
// Env: FO_OAUTH_FILE (default ./data/fo-oauth.json), FO_MCP_URL, FO_OAUTH_PORT (default 8976).

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FO_MCP_URL, McpFoClient } from "./client.js";
import { DEFAULT_OAUTH_FILE, DEFAULT_OAUTH_PORT, FileOAuthProvider } from "./oauth.js";

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no browser opener: the printed URL is enough
    child.unref();
  } catch {
    // same
  }
}

const page = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Fo Squad</title><p style="font:16px system-ui;margin:3em">${msg}</p>`;

/** Localhost server that resolves with the authorization code from the OAuth redirect. */
function waitForCallback(
  port: number,
  expectedState: () => string | undefined,
): { ready: Promise<void>; code: Promise<string>; server: Server } {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    const state = expectedState();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (error) {
      res.end(page("Sign-in failed. You can close this tab and check the terminal."));
      rejectCode(new Error(`Fo sign-in failed: ${error} ${url.searchParams.get("error_description") ?? ""}`.trim()));
    } else if (!got || (state !== undefined && url.searchParams.get("state") !== state)) {
      res.end(page("That sign-in link didn't match. Run npm run fo:login again."));
      rejectCode(new Error("OAuth callback had no code or a mismatched state."));
    } else {
      res.end(page("Signed in to Fo. You can close this tab."));
      resolveCode(got);
    }
  });
  const ready = new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => res());
  });
  const timer = setTimeout(() => rejectCode(new Error("Timed out waiting for the Fo sign-in.")), SIGN_IN_TIMEOUT_MS);
  timer.unref();
  return { ready, code, server };
}

async function main(): Promise<void> {
  const file = path.resolve(process.env.FO_OAUTH_FILE?.trim() || DEFAULT_OAUTH_FILE);
  const url = process.env.FO_MCP_URL?.trim() || FO_MCP_URL;
  const port = Number(process.env.FO_OAUTH_PORT) || DEFAULT_OAUTH_PORT;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;

  const provider = new FileOAuthProvider({
    file,
    interactive: true,
    redirectUrl,
    onRedirect: (authUrl) => {
      console.log(`\nSign in to Fo with your Wajo account (OG Fo plan):\n\n  ${authUrl.href}\n`);
      openBrowser(authUrl.href);
    },
  });

  // A registration made for a different callback port can't complete this sign-in.
  const info = (await provider.clientInformation()) as { redirect_uris?: string[] } | undefined;
  if (info?.redirect_uris && !info.redirect_uris.includes(redirectUrl)) await provider.invalidateCredentials("client");

  const callback = waitForCallback(port, () => provider.pendingState);
  await callback.ready;
  try {
    // Same path the runner takes: connect, get a 401, let the SDK discover,
    // register and start the sign-in, then finish it with the code.
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
    const probe = new Client({ name: "fo-squad-login", version: "0.1.0" });
    try {
      await probe.connect(transport);
      console.log("Already signed in (delete the token file to sign in as someone else).");
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      const code = await callback.code;
      await transport.finishAuth(code);
    } finally {
      await probe.close().catch(() => {});
    }
  } finally {
    callback.server.close();
  }

  const fo = new McpFoClient({ url, authProvider: provider });
  try {
    const conversations = await fo.listConversations();
    console.log(`Connected to Fo: ${conversations.length} conversation(s) visible.`);
  } finally {
    await fo.close();
  }
  console.log(`Token file: ${file}\nCopy it to the server at the path in FO_OAUTH_FILE (keep it private).`);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(`fo:login failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
