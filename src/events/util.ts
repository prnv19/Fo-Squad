// Small helpers shared inside src/events. Not part of the public barrel.

export function toIso(now: Date | string): string {
  const d = typeof now === "string" ? new Date(now) : now;
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${String(now)}`);
  return d.toISOString();
}

export function toMs(now: Date | string): number {
  return typeof now === "string" ? Date.parse(now) : now.getTime();
}

/** "Sam", "Sam and Priya", "Sam, Priya and Alex". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
