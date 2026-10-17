// Live viewer for a sandbox run: serves the static page and streams the bus as
// Server-Sent Events. Read-only and bound to loopback only, so there is no auth:
// nothing off this machine can reach it, and the Host check below stops a web
// page from reaching it through DNS rebinding.

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import type { SandboxBus, SandboxEvent } from "./events.js";

export const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

export interface ViewerOptions {
  port?: number;
  host?: string;
  /** Keeps idle proxies and browsers from dropping the stream. Overridable for tests. */
  heartbeatMs?: number;
}

export interface Viewer {
  url: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// The page only loads its own files, so a strict policy costs nothing and backs
// up the textContent-only rendering if a bug ever slips in.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function startViewer(bus: SandboxBus, options: ViewerOptions = {}): Promise<Viewer> {
  const { port = 4321, host = "127.0.0.1", heartbeatMs = 15_000 } = options;
  if (!isLoopback(host)) throw new Error(`The sandbox viewer only binds to loopback, not "${host}".`);

  const streams = new Set<ServerResponse>();
  let boundPort = port;

  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const allowed = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`, `${host}:${boundPort}`];
    if (!allowed.includes(hostHeader)) {
      res.status(403).type("text/plain").send("Forbidden host");
      return;
    }
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    streams.add(res);

    // JSON.stringify never emits raw newlines, so each event is exactly one data line.
    const send = (event: SandboxEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": heartbeat\n\n");
    }, heartbeatMs);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(res);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  });

  app.use(express.static(PUBLIC_DIR, { index: "index.html", maxAge: 0 }));

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  boundPort = (server.address() as AddressInfo).port;
  const urlHost = host.includes(":") ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${boundPort}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Open SSE streams would otherwise keep server.close() waiting forever.
        for (const res of streams) res.end();
        streams.clear();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
