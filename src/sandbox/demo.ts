// Free demo of the live viewer: replays the hand-written fixture into a bus
// with small delays, as if a real run were happening. No API calls.
//
//   npm run sandbox:demo                     # http://127.0.0.1:4321/
//   npm run sandbox:demo -- --speed 3        # faster
//   npm run sandbox:demo -- --port 0 --report out/demo.html

import { SandboxBus, type SandboxEvent } from "./events.js";
import { demoHistory } from "./fixtures/demo-history.js";
import { writeReport } from "./report.js";
import { startViewer } from "./viewer.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function delayMs(event: SandboxEvent): number {
  if (event.type === "text") return 500 + Math.min(1200, event.text.length * 10);
  if (event.type === "clock" || event.type === "stage") return 600;
  return 250;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const speed = Number(flag("speed") ?? "1") || 1;
  const port = Number(flag("port") ?? "4321");
  const reportPath = flag("report");

  const bus = new SandboxBus();
  const viewer = await startViewer(bus, { port });
  console.log(`Fo Squad sandbox viewer: ${viewer.url}`);
  console.log("Replaying the demo dinner (no API calls). Ctrl-C to stop.");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await viewer.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Give a browser a moment to connect so the first texts animate in live.
  await sleep(1500 / speed);
  for (const event of demoHistory) {
    if (stopping) return;
    bus.emit(event);
    await sleep(delayMs(event) / speed);
  }
  console.log("Demo run finished. The viewer stays up for replay.");
  if (reportPath) {
    await writeReport(bus.history, reportPath);
    console.log(`Saved replay: ${reportPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
