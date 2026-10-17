export interface RoundStatusInput {
  /** Everyone expected to reply, opted-out people already removed. */
  invitedIds: readonly string[];
  answeredIds: readonly string[];
  nudgedIds: readonly string[];
  /** ISO deadline. Missing means the round only ends when everyone answers or Fo forces it. */
  deadline?: string;
  /** ISO timestamp for "now", passed in so the logic stays deterministic. */
  now: string;
}

export interface RoundStatus {
  pending: string[];
  /** Pending and not nudged yet. Each person gets at most one nudge, and none after the deadline. */
  toNudge: string[];
  deadlinePassed: boolean;
  readyToDecide: boolean;
  /** Answers can no longer change. */
  locked: boolean;
}

export function isLateReply(deadline: string | undefined, now: string): boolean {
  if (!deadline) return false;
  const d = Date.parse(deadline);
  const n = Date.parse(now);
  if (Number.isNaN(d) || Number.isNaN(n)) return false;
  return n >= d;
}

export function roundStatus(input: RoundStatusInput): RoundStatus {
  const answered = new Set(input.answeredIds);
  const nudged = new Set(input.nudgedIds);
  const pending = input.invitedIds.filter((id) => !answered.has(id));
  const deadlinePassed = isLateReply(input.deadline, input.now);
  return {
    pending,
    toNudge: deadlinePassed ? [] : pending.filter((id) => !nudged.has(id)),
    deadlinePassed,
    readyToDecide: pending.length === 0 || deadlinePassed,
    locked: deadlinePassed,
  };
}
