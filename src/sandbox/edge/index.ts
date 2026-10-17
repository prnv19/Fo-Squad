// The edge-case suite: the case registry, selection, and the harness.

import { allCases } from "./cases/index.js";
import type { EdgeArea, EdgeCase } from "./types.js";

export { allCases };
export { runEdgeCase, runSuite, DEFAULT_MAX_RUNS, type EdgeCaseResult, type EdgeCheckResult, type RunEdgeCaseOptions, type SuiteResult } from "./harness.js";
export type * from "./types.js";

export const EDGE_AREAS: readonly EdgeArea[] = ["planning", "voting", "booking", "claiming", "payment", "messaging", "security"];

export interface CaseFilter {
  only?: string[];
  area?: EdgeArea;
  criticalOnly?: boolean;
}

/** Throws on duplicate ids or `only` ids that don't exist, so a typo can't silently run nothing. */
export function selectCases(filter: CaseFilter = {}, cases: EdgeCase[] = allCases): EdgeCase[] {
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`Duplicate edge case id: ${c.id}`);
    seen.add(c.id);
  }
  const missing = (filter.only ?? []).filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`No edge case with id: ${missing.join(", ")}`);
  return cases.filter(
    (c) =>
      (!filter.only?.length || filter.only.includes(c.id)) &&
      (!filter.area || c.area === filter.area) &&
      (!filter.criticalOnly || c.critical),
  );
}
