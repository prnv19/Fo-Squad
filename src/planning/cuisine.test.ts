import { describe, expect, it } from "vitest";
import type { Preferences, RestaurantOption } from "../types.js";
import { filterRestaurantOptions, hardConstraints, pickCuisine } from "./cuisine.js";

function pref(personId: string, extra: Partial<Preferences> = {}): Preferences {
  return {
    personId,
    slotIds: [],
    anyTime: false,
    cuisines: [],
    avoidCuisines: [],
    dietary: [],
    plusOnes: 0,
    updatedAt: "2026-10-17T12:00:00Z",
    ...extra,
  };
}

describe("pickCuisine", () => {
  it("picks the most popular cuisine and reports who gave up", () => {
    const r = pickCuisine({
      organizerId: "pranav",
      preferences: [
        pref("pranav", { cuisines: ["italian"] }),
        pref("maya", { cuisines: ["Italian", "thai"] }),
        pref("jordan", { cuisines: ["thai"] }),
        pref("sam", { cuisines: ["italian"] }),
        pref("priya"),
      ],
    });
    expect(r.cuisine).toBe("italian");
    expect(r.counts).toEqual({ italian: 3, thai: 2 });
    expect(r.gaveUp).toEqual(["jordan"]);
    expect(r.tieBrokenBy).toBeUndefined();
  });

  it("gives ties to the organizer", () => {
    const r = pickCuisine({
      organizerId: "pranav",
      preferences: [pref("pranav", { cuisines: ["thai"] }), pref("maya", { cuisines: ["italian"] })],
    });
    expect(r.cuisine).toBe("thai");
    expect(r.tieBrokenBy).toBe("organizer");
    expect(r.gaveUp).toEqual(["maya"]);
  });

  it("counts the organizer's hint when the organizer gave no cuisine", () => {
    const r = pickCuisine({
      organizerId: "pranav",
      hint: "Italian",
      preferences: [pref("maya", { cuisines: ["thai"] }), pref("jordan", { cuisines: ["italian"] })],
    });
    expect(r.cuisine).toBe("italian");
    expect(r.counts.italian).toBe(2);
  });

  it("ignores the hint when the organizer stated a cuisine", () => {
    const r = pickCuisine({
      organizerId: "pranav",
      hint: "italian",
      preferences: [pref("pranav", { cuisines: ["thai"] })],
    });
    expect(r.cuisine).toBe("thai");
    expect(r.counts).toEqual({ thai: 1 });
  });

  it("then gives ties to a fairness priority person, then alphabetical", () => {
    const prefs = [
      pref("maya", { cuisines: ["thai"] }),
      pref("jordan", { cuisines: ["mexican"] }),
      pref("sam", { cuisines: ["italian"] }),
    ];
    const fair = pickCuisine({ organizerId: "pranav", preferences: prefs, priorityIds: ["jordan", "maya"] });
    expect(fair.cuisine).toBe("mexican");
    expect(fair.tieBrokenBy).toBe("fairness");

    const alpha = pickCuisine({ organizerId: "pranav", preferences: prefs });
    expect(alpha.cuisine).toBe("italian");
    expect(alpha.tieBrokenBy).toBe("alphabetical");
  });

  it("never lets an avoided cuisine win while another option exists (soft veto)", () => {
    const r = pickCuisine({
      organizerId: "pranav",
      preferences: [
        pref("pranav", { cuisines: ["thai"] }),
        pref("maya", { cuisines: ["thai"] }),
        pref("jordan", { cuisines: ["thai", "italian"] }),
        pref("sam", { avoidCuisines: ["thai"] }),
      ],
    });
    expect(r.cuisine).toBe("italian");
    expect(r.avoided).toEqual(["thai"]);
    expect(r.gaveUp).toEqual(["pranav", "maya"]);
    expect(r.reason).toContain("someone would rather avoid it");
    expect(r.reason).not.toContain("sam");
  });

  it("lets an avoided cuisine win when everything requested is avoided", () => {
    const r = pickCuisine({
      organizerId: "pranav",
      preferences: [pref("pranav", { cuisines: ["thai"] }), pref("sam", { avoidCuisines: ["thai"] })],
    });
    expect(r.cuisine).toBe("thai");
  });

  it("returns no cuisine when nobody has a preference", () => {
    const r = pickCuisine({ organizerId: "pranav", preferences: [pref("maya"), pref("jordan")] });
    expect(r.cuisine).toBeUndefined();
    expect(r.gaveUp).toEqual([]);
  });
});

describe("hardConstraints", () => {
  it("unions dietary needs and takes the strictest budget silently", () => {
    const r = hardConstraints({
      groupBudgetCents: 5000,
      preferences: [
        pref("maya", { dietary: ["Vegetarian"], budgetCents: 4000 }),
        pref("jordan", { dietary: ["nut allergy", "vegetarian"], avoidCuisines: ["thai"] }),
        pref("sam", { budgetCents: 6000 }),
      ],
    });
    expect(r).toEqual({
      dietary: ["nut allergy", "vegetarian"],
      maxBudgetPerPersonCents: 4000,
      avoidCuisines: ["thai"],
    });
    expect(JSON.stringify(r)).not.toContain("maya");
  });

  it("uses the group budget alone, or none at all", () => {
    expect(hardConstraints({ groupBudgetCents: 5000, preferences: [pref("maya")] }).maxBudgetPerPersonCents).toBe(5000);
    expect(hardConstraints({ preferences: [pref("maya")] })).toEqual({ dietary: [], avoidCuisines: [] });
  });
});

describe("filterRestaurantOptions", () => {
  it("rejects options over budget or in an avoided cuisine, without naming anyone", () => {
    const options: RestaurantOption[] = [
      { id: "1", name: "Luigi's", cuisine: "italian", pricePerPersonCents: 3500 },
      { id: "2", name: "Steak Palace", cuisine: "steakhouse", pricePerPersonCents: 9000 },
      { id: "3", name: "Thai Basil", cuisine: "Thai", pricePerPersonCents: 2500 },
      { id: "4", name: "Tavola", cuisine: "italian" },
    ];
    const r = filterRestaurantOptions(options, { maxBudgetPerPersonCents: 4000, avoidCuisines: ["thai"] });
    expect(r.allowed.map((o) => o.id)).toEqual(["1", "4"]);
    expect(r.rejected.map((x) => [x.option.id, x.reason])).toEqual([
      ["2", "Over the group's budget"],
      ["3", "Someone would rather avoid thai"],
    ]);
  });
});
