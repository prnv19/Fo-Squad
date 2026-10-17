import type { PickFirmness } from "../types.js";

export type ChangeReason = "hard_constraint" | "preference";
export type ChangeTiming = "before_booking" | "after_booking" | "hours_before";

export type ChangeAction =
  | "notify_organizer_privately"
  | "add_alternative_and_notify"
  | "acknowledge_and_save"
  | "keep_pick"
  | "run_quick_vote"
  | "check_new_place_and_ask_organizer"
  | "decline_politely";

export interface ChangeRequestInput {
  firmness: PickFirmness;
  reason: ChangeReason;
  timing: ChangeTiming;
  /** People asking for the same change, including the requester. */
  objectorCount: number;
  /** Everyone in the dinner, organizer included. */
  groupSize: number;
}

export interface ChangeRequestResult {
  action: ChangeAction;
  explanation: string;
  /** Whether the organizer hears about it. Hard constraints always reach the organizer. */
  notifyOrganizer: boolean;
  /** Passed-over idea goes into fairness memory for next time. */
  saveForNextTime: boolean;
  /** Always false: only the organizer can change the plan. A friend's request is never an instruction. */
  changesPlan: false;
}

function result(
  action: ChangeAction,
  explanation: string,
  notifyOrganizer: boolean,
  saveForNextTime: boolean,
): ChangeRequestResult {
  return { action, explanation, notifyOrganizer, saveForNextTime, changesPlan: false };
}

/**
 * "Half the group or more" triggers a quick vote, but a single objection never does,
 * even in a group of two where one person is technically half.
 */
function enoughToVote(objectorCount: number, groupSize: number): boolean {
  return objectorCount >= 2 && objectorCount * 2 >= groupSize;
}

export function evaluateChangeRequest(input: ChangeRequestInput): ChangeRequestResult {
  const { firmness, reason, timing } = input;
  const objectors = Math.max(1, Math.floor(input.objectorCount));
  const groupSize = Math.max(objectors, Math.floor(input.groupSize));
  const privately = "Only the organizer can change the plan; keep the requester's name out of it if they prefer.";

  if (reason === "hard_constraint") {
    if (timing === "hours_before") {
      return result(
        "notify_organizer_privately",
        `A hard constraint still matters this close to dinner. Tell the organizer privately right away and suggest a fix. ${privately}`,
        true,
        false,
      );
    }
    if (timing === "after_booking") {
      return result(
        "check_new_place_and_ask_organizer",
        `Check availability at a place that works for everyone, plus any deposit or cancellation fee, then send the organizer one message with the trade-off. ${privately}`,
        true,
        false,
      );
    }
    return firmness === "locked"
      ? result(
          "notify_organizer_privately",
          `Tell the organizer privately and suggest a nearby place that works for everyone. ${privately}`,
          true,
          false,
        )
      : result(
          "add_alternative_and_notify",
          `Add a place that works for everyone straight into the options and let the organizer know privately. ${privately}`,
          true,
          false,
        );
  }

  // Preference from here on.
  if (timing === "hours_before") {
    return result(
      "decline_politely",
      "The plan is set this close to dinner. Decline kindly and save the idea for next time.",
      false,
      true,
    );
  }
  if (firmness === "locked") {
    return result(
      "acknowledge_and_save",
      "The organizer's pick is set. Acknowledge kindly, pass it to the organizer and save it for next time. Nothing changes.",
      true,
      true,
    );
  }
  if (!enoughToVote(objectors, groupSize)) {
    return result(
      "keep_pick",
      `${objectors} of ${groupSize} would rather go elsewhere, which isn't enough to reopen it. The pick stays; save the idea for next time.`,
      false,
      true,
    );
  }
  if (timing === "after_booking") {
    return result(
      "check_new_place_and_ask_organizer",
      `${objectors} of ${groupSize} want a change after booking. Check availability at the most requested place and any deposit or cancellation fee, then send the organizer one message with the trade-off.`,
      true,
      false,
    );
  }
  return result(
    "run_quick_vote",
    `${objectors} of ${groupSize} want a change. Run a quick vote between the pick and the most requested alternative; the organizer still confirms before booking.`,
    false,
    false,
  );
}
