import { describe, expect, it } from "vitest";
import { FoError } from "./errors.js";
import { createEvent } from "./factory.js";
import {
  assertOrganizer,
  assertUniqueContacts,
  isOrganizerContact,
  normalizePhone,
  requirePerson,
  resolvePerson,
  slugId,
} from "./people.js";

const NOW = "2026-10-17T18:00:00.000Z";

function event() {
  return createEvent(
    {
      title: "Luigi's Saturday",
      organizer: { name: "Pranav", phone: "555-000-1111" },
      friends: [
        { name: "Maya", phone: "(555) 123-4567" },
        { name: "Maya", phone: "555 222 3333" },
        { name: "Jordan Lee", phone: "+44 20 7946 0958" },
      ],
      timeSlots: [],
    },
    { now: NOW, id: "test-evt" },
  );
}

describe("normalizePhone", () => {
  it.each([
    ["(555) 123-4567", "+15551234567"],
    ["555.123.4567", "+15551234567"],
    ["1-555-123-4567", "+15551234567"],
    ["+1 555 123 4567", "+15551234567"],
    ["  5551234567 ", "+15551234567"],
    ["+44 20 7946 0958", "+442079460958"],
    ["0044 20 7946 0958", "+442079460958"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it("uses the default country for national numbers", () => {
    expect(normalizePhone("020 7946 0958", "44")).toBe("+442079460958");
  });

  it.each(["", "   ", "call me", "555-1234", "555123456789", "+1 155 123 4567", "12+34567890", "+0 20 7946 0958"])(
    "rejects %j",
    (raw) => {
      expect(() => normalizePhone(raw)).toThrow(FoError);
    },
  );

  it("throws an INVALID_INPUT error with the bad value in the message", () => {
    try {
      normalizePhone("pizza");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FoError);
      expect((err as FoError).code).toBe("INVALID_INPUT");
      expect((err as FoError).message).toContain("pizza");
    }
  });
});

describe("slugId", () => {
  it("slugs names", () => {
    expect(slugId("Maya", new Set())).toBe("maya");
    expect(slugId("  Jordan  Lee ", new Set())).toBe("jordan-lee");
    expect(slugId("Zoë O'Brien", new Set())).toBe("zoe-obrien");
    expect(slugId("!!!", new Set())).toBe("friend");
  });

  it("suffixes collisions", () => {
    const taken = new Set(["maya"]);
    expect(slugId("Maya", taken)).toBe("maya-2");
    taken.add("maya-2");
    expect(slugId("MAYA", taken)).toBe("maya-3");
  });

  it("doesn't mutate the taken set", () => {
    const taken = new Set<string>();
    slugId("Maya", taken);
    expect(taken.size).toBe(0);
  });
});

describe("resolvePerson", () => {
  const e = event();

  it("matches by id", () => {
    expect(resolvePerson(e, "maya-2")?.phone).toBe("+15552223333");
    expect(resolvePerson(e, "jordan-lee")?.name).toBe("Jordan Lee");
  });

  it("matches by case-insensitive name", () => {
    expect(resolvePerson(e, "  jordan   LEE ")?.id).toBe("jordan-lee");
    expect(resolvePerson(e, "PRANAV")?.id).toBe("pranav");
  });

  it("matches by phone in any format", () => {
    expect(resolvePerson(e, "555.123.4567")?.id).toBe("maya");
    expect(resolvePerson(e, "+442079460958")?.id).toBe("jordan-lee");
  });

  it("doesn't guess between two people with the same name", () => {
    // "maya" is also an id, so make the name lookup the only route.
    expect(resolvePerson(e, "Maya")?.id).toBe("maya");
    const renamed = { ...e, people: e.people.map((p) => (p.id === "maya" ? { ...p, id: "maya-1" } : p)) };
    expect(resolvePerson(renamed, "Maya")).toBeUndefined();
  });

  it("returns undefined for unknown refs", () => {
    expect(resolvePerson(e, "Sam")).toBeUndefined();
    expect(resolvePerson(e, "")).toBeUndefined();
    expect(resolvePerson(e, "555-999-8888")).toBeUndefined();
  });

  it("requirePerson throws UNKNOWN_PERSON", () => {
    expect(() => requirePerson(e, "Sam")).toThrow(expect.objectContaining({ code: "UNKNOWN_PERSON" }));
  });
});

describe("organizer checks", () => {
  const e = event();

  it("isOrganizerContact normalizes before comparing", () => {
    expect(isOrganizerContact(e, "(555) 000-1111")).toBe(true);
    expect(isOrganizerContact(e, "+15550001111")).toBe(true);
    expect(isOrganizerContact(e, "555-123-4567")).toBe(false);
    expect(isOrganizerContact(e, "garbage")).toBe(false);
  });

  it("assertOrganizer throws NOT_ORGANIZER for friends", () => {
    expect(() => assertOrganizer(e, "555-123-4567", "mark someone paid")).toThrow(
      expect.objectContaining({ code: "NOT_ORGANIZER" }),
    );
    expect(() => assertOrganizer(e, "5550001111", "mark someone paid")).not.toThrow();
  });
});

describe("assertUniqueContacts", () => {
  it("rejects two people with one number", () => {
    expect(() =>
      assertUniqueContacts([
        { name: "Maya", phone: "+15551234567" },
        { name: "Sam", phone: "+15551234567" },
      ]),
    ).toThrow(/Maya and Sam have the same number/);
  });
});
