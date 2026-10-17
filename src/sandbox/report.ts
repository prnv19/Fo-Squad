// Saved replay: one self-contained HTML file with the viewer's CSS and JS
// inlined and the run's history embedded as JSON, so it opens from disk (or an
// email attachment) with no server and no network.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SandboxEvent } from "./events.js";
import { PUBLIC_DIR } from "./viewer.js";

const STYLE_TAG = '<link rel="stylesheet" href="styles.css">';
const SCRIPT_TAG = '<script src="app.js" defer></script>';
const CSP_TAG = /<meta http-equiv="Content-Security-Policy"[^>]*>/;

/**
 * JSON for a `<script type="application/json">` block. Escaping every "<"
 * means event text like "</script><script>..." can never close the tag early.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function sha256(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

export async function renderReport(history: SandboxEvent[]): Promise<string> {
  const [html, css, js] = await Promise.all([
    readFile(join(PUBLIC_DIR, "index.html"), "utf8"),
    readFile(join(PUBLIC_DIR, "styles.css"), "utf8"),
    readFile(join(PUBLIC_DIR, "app.js"), "utf8"),
  ]);
  if (!html.includes(STYLE_TAG) || !html.includes(SCRIPT_TAG) || !CSP_TAG.test(html)) {
    throw new Error("viewer index.html is missing the stylesheet, script or CSP tag the report inlines");
  }
  if (/<\/style/i.test(css) || /<\/script/i.test(js)) throw new Error("viewer assets must not contain closing style/script tags");

  // Hashes keep a strict CSP working for the inline copies; the JSON block is not executed so it needs none.
  const csp = `default-src 'none'; script-src ${sha256(js)}; style-src ${sha256(css)}; img-src data:; base-uri 'none'; form-action 'none'`;

  // Function replacers, because the assets contain "$" sequences that string replacement would interpret.
  return html
    .replace(CSP_TAG, () => `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace(STYLE_TAG, () => `<style>${css}</style>`)
    .replace(
      SCRIPT_TAG,
      () => `<script type="application/json" id="sandbox-history">${embedJson(history)}</script>\n<script>${js}</script>`,
    );
}

export async function writeReport(history: SandboxEvent[], path: string): Promise<void> {
  const html = await renderReport(history);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, "utf8");
}
