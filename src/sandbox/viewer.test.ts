import { get, request, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxBus, type SandboxEvent, type SandboxListener } from "./events.js";
import { startViewer, type Viewer } from "./viewer.js";

/** Counts live subscriptions so tests can see the SSE handler unsubscribe. */
class CountingBus extends SandboxBus {
  active = 0;
  override subscribe(listener: SandboxListener): () => void {
    const off = super.subscribe(listener);
    this.active += 1;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.active -= 1;
      }
      return off();
    };
  }
}

const at = "2026-10-17T19:30:00-06:00";
const text = (t: string): SandboxEvent => ({ type: "text", at, from: "fo", to: "maya", text: t });

let viewer: Viewer | undefined;
afterEach(async () => {
  await viewer?.close();
  viewer = undefined;
});

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fetchText(url: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Opens /events and collects parsed data lines and raw chunks. */
function openStream(url: string) {
  const events: SandboxEvent[] = [];
  let raw = "";
  let buffer = "";
  const req = get(`${url}events`, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      raw += chunk;
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as SandboxEvent);
        }
      }
    });
  });
  req.on("error", () => {});
  return { events, raw: () => raw, req };
}

describe("startViewer", () => {
  it("binds to 127.0.0.1 and refuses non-loopback hosts", async () => {
    viewer = await startViewer(new SandboxBus(), { port: 0 });
    expect(viewer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    await expect(startViewer(new SandboxBus(), { port: 0, host: "0.0.0.0" })).rejects.toThrow(/loopback/);
  });

  it("serves the static page and assets with a strict CSP", async () => {
    viewer = await startViewer(new SandboxBus(), { port: 0 });
    const page = await fetchText(viewer.url);
    expect(page.status).toBe(200);
    expect(page.type).toContain("text/html");
    expect(page.body).toContain('<script src="app.js" defer></script>');
    expect(String(page.headers["content-security-policy"])).toContain("script-src 'self'");

    const js = await fetchText(`${viewer.url}app.js`);
    expect(js.status).toBe(200);
    expect(js.type).toContain("javascript");
    expect(js.body).toContain("EventSource");

    const css = await fetchText(`${viewer.url}styles.css`);
    expect(css.status).toBe(200);
    expect(css.type).toContain("text/css");
  });

  it("rejects requests with a foreign Host header (DNS rebinding)", async () => {
    viewer = await startViewer(new SandboxBus(), { port: 0 });
    const res = await fetchText(viewer.url, { Host: "evil.example" });
    expect(res.status).toBe(403);
  });

  it("streams history first, then live events, and unsubscribes on disconnect", async () => {
    const bus = new CountingBus();
    bus.emit({ type: "run_started", at, scenario: "Test", people: [{ id: "maya", name: "Maya", role: "friend" }] });
    bus.emit(text("history </script><b>html</b>"));
    viewer = await startViewer(bus, { port: 0 });

    const stream = openStream(viewer.url);
    await waitFor(() => stream.events.length === 2);
    expect(stream.events.map((e) => e.type)).toEqual(["run_started", "text"]);
    expect(stream.events[1]).toEqual(bus.history[1]);
    expect(bus.active).toBe(1);

    bus.emit(text("live one\nwith a newline"));
    await waitFor(() => stream.events.length === 3);
    expect(stream.events[2]).toEqual(text("live one\nwith a newline"));

    stream.req.destroy();
    await waitFor(() => bus.active === 0);
    // Emitting after disconnect must not throw or write to a dead socket.
    expect(() => bus.emit(text("after"))).not.toThrow();
  });

  it("sends heartbeat comments", async () => {
    viewer = await startViewer(new SandboxBus(), { port: 0, heartbeatMs: 20 });
    const stream = openStream(viewer.url);
    await waitFor(() => stream.raw().includes(": heartbeat"));
    stream.req.destroy();
  });

  it("closes cleanly while a stream is open", async () => {
    const bus = new CountingBus();
    const v = await startViewer(bus, { port: 0 });
    const stream = openStream(v.url);
    await waitFor(() => bus.active === 1);
    await v.close();
    await waitFor(() => bus.active === 0);
    stream.req.destroy();
  });
});
