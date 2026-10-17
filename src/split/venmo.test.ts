import { describe, expect, it } from "vitest";
import type { PersonShare } from "../types.js";
import { buildShareMessage, buildVenmoLink } from "./venmo.js";

const maya: PersonShare = {
  personId: "maya",
  items: [
    { itemNumber: 1, description: "margherita", fraction: "1", shareCents: 1800 },
    { itemNumber: 4, description: "garlic bread", fraction: "1/3", shareCents: 300 },
  ],
  subtotalCents: 2100,
  extrasCents: 588,
  treatCents: 0,
  totalCents: 2688,
};

describe("buildVenmoLink", () => {
  it("builds web and app links with the amount and an encoded note", () => {
    expect(buildVenmoLink({ handle: "@pranav-u", amountCents: 2688, note: "Luigi's dinner & drinks 🍕" })).toEqual({
      webUrl: "https://venmo.com/pranav-u?txn=pay&amount=26.88&note=Luigi's%20dinner%20%26%20drinks%20%F0%9F%8D%95",
      appUrl:
        "venmo://paycharge?txn=pay&recipients=pranav-u&amount=26.88&note=Luigi's%20dinner%20%26%20drinks%20%F0%9F%8D%95",
    });
  });

  it("formats amounts without symbols or grouping", () => {
    const { webUrl } = buildVenmoLink({ handle: "pranav", amountCents: 102650, note: "x" });
    expect(new URL(webUrl).searchParams.get("amount")).toBe("1026.50");
  });

  it("decodes back to the original note", () => {
    const note = "Dinner at Luigi's: 1/3 bread + tax?";
    const { webUrl } = buildVenmoLink({ handle: "pranav", amountCents: 500, note });
    expect(new URL(webUrl).searchParams.get("note")).toBe(note);
  });

  it("rejects missing handles and non-positive amounts", () => {
    expect(() => buildVenmoLink({ handle: "@", amountCents: 100, note: "" })).toThrow(/handle/);
    expect(() => buildVenmoLink({ handle: "pranav", amountCents: 0, note: "" })).toThrow(/positive/);
  });
});

describe("buildShareMessage", () => {
  it("lists only this person's items and total, with the pay link", () => {
    expect(
      buildShareMessage({
        eventTitle: "Luigi's",
        organizerName: "Pranav",
        share: maya,
        link: "https://venmo.com/pranav?txn=pay&amount=26.88",
      }),
    ).toBe(
      "Your share for Luigi's is $26.88 (margherita, 1/3 garlic bread, tax and tip). Pay Pranav here: https://venmo.com/pranav?txn=pay&amount=26.88",
    );
  });

  it("falls back to plain text when there's no Venmo", () => {
    expect(buildShareMessage({ eventTitle: "Luigi's", organizerName: "Pranav", share: maya })).toBe(
      "Your share for Luigi's is $26.88 (margherita, 1/3 garlic bread, tax and tip). Send $26.88 to Pranav.",
    );
    expect(
      buildShareMessage({ eventTitle: "Luigi's", organizerName: "Pranav", share: maya, organizerHandle: "@pranav" }),
    ).toMatch(/Send \$26\.88 to Pranav on Venmo \(@pranav\)\.$/);
  });

  it("tells a treated person they owe nothing, without naming anyone", () => {
    const treated: PersonShare = { ...maya, treatCents: -2688, totalCents: 0 };
    expect(buildShareMessage({ eventTitle: "Luigi's", organizerName: "Pranav", share: treated })).toBe(
      "You're all set for Luigi's: nothing to pay. Thanks for coming!",
    );
  });

  it("mentions a treat contribution generically", () => {
    const payer: PersonShare = { ...maya, treatCents: 1344, totalCents: 4032 };
    expect(buildShareMessage({ eventTitle: "Luigi's", organizerName: "Pranav", share: payer })).toContain(
      "tax and tip, your part of tonight's treat). Send $40.32 to Pranav.",
    );
  });
});
