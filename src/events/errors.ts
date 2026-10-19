export type FoErrorCode =
  | "WRONG_STAGE"
  | "NOT_FOUND"
  | "UNKNOWN_PERSON"
  | "NOT_ORGANIZER"
  | "PLAN_LOCKED"
  | "INVALID_INPUT"
  | "OPTED_OUT"
  | "CLAIMS_PENDING"
  | "OPEN_DINNER"
  | "NOT_YET";

/**
 * An error whose message is safe and useful for Fo to relay to the organizer.
 * The server turns it into `{ ok: false, error: { code, message } }`.
 */
export class FoError extends Error {
  readonly code: FoErrorCode;

  constructor(code: FoErrorCode, message: string) {
    super(message);
    this.name = "FoError";
    this.code = code;
  }
}

export function isFoError(err: unknown): err is FoError {
  return err instanceof FoError;
}
