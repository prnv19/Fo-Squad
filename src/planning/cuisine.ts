import type { Cents, Preferences, RestaurantOption } from "../types.js";
import { latestPerPerson, normalizeTag, uniqueSorted } from "./text.js";

export interface PickCuisineInput {
  preferences: readonly Preferences[];
  organizerId: string;
  /** Organizer's hint from create_event ("italian"). Stands in for the organizer's own answer. */
  hint?: string;
  /** Fairness memory, oldest concession first. */
  priorityIds?: readonly string[];
}

export interface PickCuisineResult {
  cuisine?: string;
  /** Respondents (plus the organizer's hint) who listed each cuisine. */
  counts: Record<string, number>;
  /** Cuisines someone asked to avoid. */
  avoided: string[];
  tieBrokenBy?: "organizer" | "fairness" | "alphabetical";
  reason: string;
  /** Respondents who named cuisines and got none of them. Feed to fairness memory. */
  gaveUp: string[];
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * Each respondent backs every cuisine they list (approval style), so "Italian or Thai"
 * counts once for each.
 *
 * Avoidance is a soft veto: an avoided cuisine can only win when every cuisine anyone
 * asked for is avoided by someone. Dietary needs are the hard constraint and are enforced
 * on restaurants, not cuisines (see hardConstraints).
 */
export function pickCuisine(input: PickCuisineInput): PickCuisineResult {
  const prefs = latestPerPerson(input.preferences);
  const wants = new Map<string, string[]>();
  for (const p of prefs) {
    wants.set(p.personId, uniqueSorted(p.cuisines.map(normalizeTag).filter(Boolean)));
  }
  const ownOrganizerWants = wants.get(input.organizerId) ?? [];
  const hint = input.hint ? normalizeTag(input.hint) : "";
  const organizerWants = ownOrganizerWants.length > 0 ? ownOrganizerWants : hint ? [hint] : [];

  const counts: Record<string, number> = {};
  const backers = new Map<string, string[]>(wants);
  backers.set(input.organizerId, organizerWants);
  for (const list of backers.values()) {
    for (const c of list) counts[c] = (counts[c] ?? 0) + 1;
  }

  const avoided = uniqueSorted(prefs.flatMap((p) => p.avoidCuisines.map(normalizeTag)).filter(Boolean));
  const avoidedSet = new Set(avoided);
  const all = Object.keys(counts);

  if (all.length === 0) {
    return { counts, avoided, reason: "No cuisine preferences, so anything that fits works", gaveUp: [] };
  }

  const allowed = all.filter((c) => !avoidedSet.has(c));
  const vetoApplied = allowed.length > 0 && allowed.length < all.length;
  const pool = allowed.length > 0 ? allowed : all;
  const top = Math.max(...pool.map((c) => counts[c] ?? 0));
  let tied = pool.filter((c) => counts[c] === top).sort();

  let tieBrokenBy: PickCuisineResult["tieBrokenBy"];
  if (tied.length > 1) {
    const narrow = (liked: readonly string[]): boolean => {
      const kept = tied.filter((c) => liked.includes(c));
      if (kept.length > 0 && kept.length < tied.length) tied = kept;
      return tied.length === 1;
    };
    if (narrow(organizerWants)) tieBrokenBy = "organizer";
    else {
      for (const id of input.priorityIds ?? []) {
        if (id !== input.organizerId && narrow(wants.get(id) ?? [])) {
          tieBrokenBy = "fairness";
          break;
        }
      }
      tieBrokenBy ??= "alphabetical";
    }
  }

  const cuisine = tied[0]!;
  const gaveUp = [...wants.entries()]
    .filter(([, list]) => list.length > 0 && !list.includes(cuisine))
    .map(([id]) => id);

  const label = capitalize(cuisine);
  let reason = `${label} is the most popular pick (${top} ${top === 1 ? "vote" : "votes"})`;
  if (tieBrokenBy === "organizer") reason = `${label} ties for most popular and is the organizer's choice`;
  else if (tieBrokenBy === "fairness") reason = `${label} ties for most popular and goes to someone who gave up their pick last time`;
  else if (tieBrokenBy === "alphabetical") reason = `${label} ties for most popular`;
  if (vetoApplied && all.some((c) => avoidedSet.has(c) && (counts[c] ?? 0) > top)) {
    reason += "; a more popular cuisine was skipped because someone would rather avoid it";
  }
  if (allowed.length === 0) reason += ", though someone would rather avoid it";

  return { cuisine, counts, avoided, ...(tieBrokenBy ? { tieBrokenBy } : {}), reason, gaveUp };
}

export interface HardConstraints {
  dietary: string[];
  /** Strictest of every private budget and the group budget. Never attributed to anyone. */
  maxBudgetPerPersonCents?: Cents;
  avoidCuisines: string[];
}

export function hardConstraints(input: {
  preferences: readonly Preferences[];
  groupBudgetCents?: Cents;
}): HardConstraints {
  const prefs = latestPerPerson(input.preferences);
  const dietary = uniqueSorted(prefs.flatMap((p) => p.dietary.map(normalizeTag)).filter(Boolean));
  const avoidCuisines = uniqueSorted(prefs.flatMap((p) => p.avoidCuisines.map(normalizeTag)).filter(Boolean));
  const budgets = [input.groupBudgetCents, ...prefs.map((p) => p.budgetCents)].filter(
    (b): b is number => typeof b === "number" && Number.isFinite(b) && b > 0,
  );
  return budgets.length > 0
    ? { dietary, maxBudgetPerPersonCents: Math.min(...budgets), avoidCuisines }
    : { dietary, avoidCuisines };
}

export interface FilteredOptions {
  allowed: RestaurantOption[];
  rejected: { option: RestaurantOption; reason: string }[];
}

/**
 * Dietary fit can't be verified from our data (a cuisine label says nothing about a
 * kitchen's vegetarian or nut-free options). Fo is responsible for checking menus;
 * this only enforces what we can measure: price and cuisine. Options with no price are
 * allowed, since Fo already searched with the budget.
 */
export function filterRestaurantOptions(
  options: readonly RestaurantOption[],
  constraints: Pick<HardConstraints, "maxBudgetPerPersonCents" | "avoidCuisines">,
): FilteredOptions {
  const avoid = new Set(constraints.avoidCuisines.map(normalizeTag));
  const max = constraints.maxBudgetPerPersonCents;
  const result: FilteredOptions = { allowed: [], rejected: [] };
  for (const option of options) {
    if (max !== undefined && option.pricePerPersonCents !== undefined && option.pricePerPersonCents > max) {
      // Deliberately generic: a private budget must never be traceable to its owner.
      result.rejected.push({ option, reason: "Over the group's budget" });
    } else if (option.cuisine && avoid.has(normalizeTag(option.cuisine))) {
      result.rejected.push({ option, reason: `Someone would rather avoid ${normalizeTag(option.cuisine)}` });
    } else {
      result.allowed.push(option);
    }
  }
  return result;
}
