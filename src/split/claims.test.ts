import { describe, expect, it } from "vitest";
import type { Claim, LineItem } from "../types.js";
import { analyzeClaims, parseClaimReply } from "./claims.js";

describe("parseClaimReply", () => {
  it.each([
    ["Maya: 1, 4", "Maya", [[1, 1], [4, 1]]],
    ["Maya: 1 and 4", "Maya", [[1, 1], [4, 1]]],
    ["maya:1,4x2", "maya", [[1, 1], [4, 2]]],
    ["Maya: 1, 4 x 2", "Maya", [[1, 1], [4, 2]]],
    ["Maya: 1 4", "Maya", [[1, 1], [4, 1]]],
    ["Maya: 1, 2, and 4X3", "Maya", [[1, 1], [2, 1], [4, 3]]],
    ["Mary Jane: #3", "Mary Jane", [[3, 1]]],
    ["  Maya :  7  ", "Maya", [[7, 1]]],
  ] as const)("parses %j", (text, name, pairs) => {
    expect(parseClaimReply(text)).toEqual({
      ok: true,
      name,
      items: pairs.map(([number, weight]) => ({ number, weight })),
    });
  });

  it.each(["Maya: none", "Maya: None", "Maya: nothing"])("parses %j as no items", (text) => {
    expect(parseClaimReply(text)).toEqual({ ok: true, name: "Maya", items: [] });
  });

  it.each([
    ["Maya 1, 4", /Missing "name:"/],
    [": 1, 4", /Missing the person's name/],
    ["Maya:", /No items listed for Maya/],
    ["Maya: 1, 1", /Item 1 is listed twice/],
    ["Maya: 0", /start at 1/],
    ["Maya: -2", /can't be negative/],
    ["Maya: 4x0", /portion of 0/],
    ["Maya: the pizza", /Couldn't read "the"/],
    ["Maya: 1.5", /Couldn't read "1.5"/],
  ])("rejects %j", (text, message) => {
    const result = parseClaimReply(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(message);
  });
});

describe("analyzeClaims", () => {
  const items: LineItem[] = [1, 2, 3, 4].map((n) => ({ number: n, description: `item ${n}`, amountCents: 100 }));
  const c = (personId: string, itemNumber: number): Claim => ({ personId, itemNumber, weight: 1 });

  it("reports unclaimed, shared, unknown, non-attendee and pending", () => {
    const result = analyzeClaims(
      items,
      [c("maya", 1), c("maya", 4), c("jordan", 4), c("jordan", 9), c("alex", 2)],
      ["maya", "jordan", "sam", "pranav"],
    );
    expect(result).toEqual({
      unclaimedItemNumbers: [2, 3], // alex's claim on 2 doesn't count
      sharedItems: [{ itemNumber: 4, claimantIds: ["maya", "jordan"] }],
      unknownItemNumbers: [9],
      nonAttendeeIds: ["alex"],
      pendingAttendeeIds: ["sam", "pranav"],
    });
  });

  it("counts people who answered 'none' via answeredIds", () => {
    const result = analyzeClaims(items, [c("maya", 1)], ["maya", "sam"], ["sam"]);
    expect(result.pendingAttendeeIds).toEqual([]);
  });

  it("is clean when everything is claimed once", () => {
    const result = analyzeClaims(items, [c("a", 1), c("a", 2), c("b", 3), c("b", 4)], ["a", "b"]);
    expect(result).toEqual({
      unclaimedItemNumbers: [],
      sharedItems: [],
      unknownItemNumbers: [],
      nonAttendeeIds: [],
      pendingAttendeeIds: [],
    });
  });
});
