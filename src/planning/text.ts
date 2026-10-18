/** Optional id -> display name map. Ids are slugs of names, so the fallback reads fine. */
export type NameMap = Readonly<Record<string, string>>;

export function displayName(id: string, names?: NameMap): string {
  const name = names?.[id];
  if (name) return name;
  return id.length > 0 ? id[0]!.toUpperCase() + id.slice(1) : id;
}

/** "Sam", "Sam and Alex", "Sam, Alex and Jo". */
export function joinNames(items: readonly string[], conjunction: "and" | "or" = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

export function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Upstream already keeps only the latest reply per person, but planning must not
 * double count if a stale duplicate slips through.
 */
export function latestPerPerson<T extends { personId: string; updatedAt: string }>(
  items: readonly T[],
): T[] {
  const byPerson = new Map<string, T>();
  for (const item of items) {
    const prev = byPerson.get(item.personId);
    if (!prev || Date.parse(item.updatedAt) >= Date.parse(prev.updatedAt)) {
      byPerson.set(item.personId, item);
    }
  }
  return [...byPerson.values()];
}
