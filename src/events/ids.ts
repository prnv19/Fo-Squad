import { randomBytes } from "node:crypto";

// Crockford-style base32 without i, l, o, u so ids are easy to read aloud and retype.
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** Letters, digits, "-" and "_" only, so an id can never escape the data directory. */
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidEventId(id: unknown): id is string {
  return typeof id === "string" && EVENT_ID.test(id);
}

export function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += BASE32[b % 32];
  return out;
}

/**
 * Short, readable id like "luigis-sat-7k3f". The random suffix keeps two
 * dinners with the same title apart; callers should still check the store
 * for a collision and regenerate if needed.
 */
export function generateEventId(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let prefix = "";
  for (const w of words) {
    const next = prefix ? `${prefix}-${w}` : w;
    if (next.length > 20) break;
    prefix = next;
  }
  if (!prefix) prefix = (words[0] ?? "dinner").slice(0, 20) || "dinner";
  return `${prefix}-${randomBase32(4)}`;
}
