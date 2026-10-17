// Planning and voting edge cases. Default cast: Pranav organizes; Maya, Jordan,
// Sam, Priya and Alex are friends. Slots A) Fri 7pm B) Sat 6pm C) Sat 7:30pm D) Sun 6pm.

import type { Preferences } from "../../../types.js";
import type { CaseHistory, EdgeCase } from "../types.js";
import {
  callsNamed,
  DEFAULT_RESTAURANTS,
  okCallsNamed,
  organizerOf,
  refersTo,
  resultOf,
  samePhone,
  seedToBooked,
  seedToPlanning,
  seedToTimePicked,
  seedToVoting,
  textsExcept,
  textsFromFo,
  toolEvents,
  type Pass,
} from "./seed-helpers.js";

const ALLERGY = /allerg|peanut|\bnuts?\b|epi-?pen/i;

function prefOf(h: CaseHistory, personId: string): Preferences | undefined {
  return h.finalEvent.preferences.find((p) => p.personId === personId);
}

function okPrefCallsFor(h: CaseHistory, personId: string) {
  return okCallsNamed(h, "record_preferences").filter((c) => refersTo(h, c.args.person, personId));
}

function slotIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map((s) => String(s).trim().toUpperCase()).sort() : [];
}

function isNoOverlap(result: Record<string, unknown>): boolean {
  return result.status === "no_overlap" || result.code === "NO_OVERLAP";
}

function noVoteOrShortlist(h: CaseHistory): Pass {
  const used = ["set_restaurant_options", "record_vote", "tally_votes"].filter((n) => callsNamed(h, n).length > 0);
  if (used.length) return `Fo called ${used.join(", ")}`;
  if (h.finalEvent.restaurantOptions.length) return "the dinner has restaurant options now";
  return true;
}

function noBookingSince(h: CaseHistory, restaurant: string): Pass {
  const b = h.finalEvent.booking;
  if (!b) return "the booking disappeared";
  if (b.restaurantName !== restaurant) return `the booking is now ${b.restaurantName}`;
  const changers = ["confirm_booking", "update_event"].filter((n) => okCallsNamed(h, n).length > 0);
  return changers.length === 0 || `Fo called ${changers.join(" and ")} without the organizer asking`;
}

export const cases: EdgeCase[] = [
  {
    id: "no-overlap",
    title: "No time works for at least half the group",
    area: "planning",
    planRef: "Edge cases > Planning: No time works for everyone",
    critical: true,
    seed: (ctx) =>
      seedToPlanning(ctx, {
        preferences: {
          maya: { slot_ids: ["A"], cuisines: ["italian"] },
          jordan: { slot_ids: ["B"] },
          sam: { slot_ids: ["D"] },
          priya: { slot_ids: [] },
        },
      }),
    inbound: [{ from: "alex", text: "ugh this weekend is slammed, none of those work for me. sorry!!" }],
    replies: [
      {
        to: "pranav",
        when: /new (time|option)|other (time|day|option)|different (time|day)|no time|doesn'?t work|don'?t work|overlap/i,
        reply: "Ugh ok. How about the weekend after instead: Fri 7pm or Sat 7pm?",
      },
    ],
    maxRuns: 5,
    checks: [
      {
        description: "Alex's answer is saved with no times",
        test: (h) => {
          const p = prefOf(h, "alex");
          if (!p) return "no saved answer for Alex";
          return (p.slotIds.length === 0 && !p.anyTime) || p.slotsStale === true || `Alex saved as ${JSON.stringify(p.slotIds)}`;
        },
      },
      {
        description: "pick_time ran and reported no_overlap",
        test: (h) =>
          okCallsNamed(h, "pick_time").some((c) => isNoOverlap(resultOf(c.result))) || "no pick_time call returned no_overlap",
      },
      {
        description: "No time was chosen",
        test: (h) => h.finalEvent.chosenSlotId === undefined || `chosenSlotId is ${h.finalEvent.chosenSlotId}`,
      },
      {
        description: "Still planning: no shortlist, vote or booking",
        test: (h) => {
          if (h.finalEvent.stage !== "planning") return `stage is ${h.finalEvent.stage}`;
          if (okCallsNamed(h, "confirm_booking").length) return "confirm_booking succeeded";
          return noVoteOrShortlist(h);
        },
      },
      {
        description: "Fo asked the organizer for new options after no_overlap",
        test: (h) => {
          const at = toolEvents(h, "pick_time").find((e) => isNoOverlap(resultOf(e.result)))?.index;
          if (at === undefined) return "pick_time never reported no_overlap";
          return textsFromFo(h, organizerOf(h).id).some((t) => t.index > at) || "no text to the organizer after no_overlap";
        },
      },
      {
        description: "No friend was told a time landed or asked to vote",
        test: (h) => {
          const bad = textsExcept(h, organizerOf(h).id).filter((t) => /landed on|\bvote\b|\bbooked\b/i.test(t.text));
          return bad.length === 0 || `told ${bad.map((t) => t.to).join(", ")}: "${bad[0]!.text}"`;
        },
      },
      {
        description: "Any new time options came from the organizer",
        test: (h) => {
          const org = organizerOf(h);
          const bad = callsNamed(h, "update_event").filter(
            (c) => c.args.time_slots !== undefined && (!samePhone(c.args.by_phone, org.phone) || c.triggeredBy !== org.id),
          );
          return bad.length === 0 || `update_event with time_slots from ${bad[0]!.triggeredBy}'s run`;
        },
      },
    ],
  },

  {
    id: "late-reply-after-deadline",
    title: "Reply arrives after the plan is set",
    area: "planning",
    planRef: "Edge cases > Planning: Reply after the deadline",
    critical: false,
    seed: (ctx) =>
      seedToBooked(ctx, {
        friends: ["maya", "jordan", "sam", "priya", "alex"],
        preferences: {
          maya: { slot_ids: ["B", "C"] },
          jordan: { slot_ids: ["C", "D"] },
          sam: { slot_ids: ["C"] },
          priya: { slot_ids: ["A", "B", "C"] },
        },
        pastDeadline: true,
        votes: { pranav: "1", maya: "1", jordan: "2", sam: "1", priya: "1" },
        confirmation: "OM-4410",
      }),
    inbound: [{ from: "alex", text: "hey sorry just seeing this!! I can do Sat 7:30 or Sun. italian sounds great", afterMinutes: 30 }],
    maxRuns: 4,
    checks: [
      {
        description: "Alex's late answer was not saved",
        test: (h) => {
          if (okPrefCallsFor(h, "alex").length) return "record_preferences succeeded for Alex";
          return prefOf(h, "alex") === undefined || "Alex has saved preferences";
        },
      },
      {
        description: "Alex hears the plan is set, with the restaurant",
        test: (h) => {
          const place = h.finalEvent.booking?.restaurantName.toLowerCase() ?? "osteria marco";
          const texts = h.textsTo("alex");
          if (!texts.length) return "Fo never replied to Alex";
          return texts.some((t) => t.toLowerCase().includes(place)) || `no text to Alex names ${place}`;
        },
      },
      {
        description: "The plan is unchanged (Sat 7:30pm at Osteria Marco)",
        test: (h) => {
          if (h.finalEvent.chosenSlotId !== "C") return `chosenSlotId is ${h.finalEvent.chosenSlotId}`;
          return noBookingSince(h, "Osteria Marco");
        },
      },
    ],
  },

  {
    id: "changed-answer",
    title: "Friend changes their answer before the deadline",
    area: "planning",
    planRef: "Edge cases > Planning: Someone changes their answer",
    critical: false,
    seed: (ctx) =>
      seedToPlanning(ctx, {
        preferences: {
          maya: { slot_ids: ["C"] },
          jordan: { slot_ids: ["C", "D"] },
          priya: { slot_ids: ["B", "C"] },
        },
      }),
    inbound: [
      { from: "sam", text: "B or C works for me!" },
      { from: "sam", text: "wait sorry scratch that, I'm busy all saturday. only D works", afterMinutes: 4 },
    ],
    maxRuns: 4,
    checks: [
      {
        description: "Sam's saved answer is the latest one (D only)",
        test: (h) => {
          const p = prefOf(h, "sam");
          if (!p) return "no saved answer for Sam";
          if (p.anyTime) return "Sam saved as any time";
          return JSON.stringify(p.slotIds) === '["D"]' || `Sam saved as ${JSON.stringify(p.slotIds)}`;
        },
      },
      {
        description: "Both answers went through record_preferences, the last one with D",
        test: (h) => {
          const calls = okPrefCallsFor(h, "sam");
          if (calls.length < 2) return `${calls.length} successful record_preferences call(s) for Sam`;
          const last = slotIds(calls.at(-1)!.args.slot_ids);
          return JSON.stringify(last) === '["D"]' || `last call saved ${JSON.stringify(last)}`;
        },
      },
      {
        description: "No forced pick_time from a friend's text (Alex hasn't answered, deadline not passed)",
        test: (h) => {
          const org = organizerOf(h).id;
          const bad = callsNamed(h, "pick_time").filter((c) => c.args.force === true && c.triggeredBy !== "timer" && c.triggeredBy !== org);
          return bad.length === 0 || `pick_time force in ${bad[0]!.triggeredBy}'s run`;
        },
      },
    ],
  },

  {
    id: "any-time-works",
    title: "\"Anything works for me\"",
    area: "planning",
    planRef: "Edge cases > Planning: \"Any time works\"",
    critical: false,
    seed: (ctx) =>
      seedToPlanning(ctx, {
        preferences: {
          maya: { slot_ids: ["C"], cuisines: ["italian"] },
          jordan: { slot_ids: ["C", "D"] },
          sam: { slot_ids: ["B", "C", "D"] },
        },
      }),
    inbound: [{ from: "priya", text: "honestly anything works for me! I'm easy, whatever you guys want" }],
    maxRuns: 3,
    checks: [
      {
        description: "record_preferences saved Priya with any_time: true",
        test: (h) => {
          const last = okPrefCallsFor(h, "priya").at(-1);
          if (!last) return "no successful record_preferences for Priya";
          return last.args.any_time === true || `any_time was ${JSON.stringify(last.args.any_time)}`;
        },
      },
      {
        description: "Priya's saved answer is any time, with no invented food answers",
        test: (h) => {
          const p = prefOf(h, "priya");
          if (!p) return "no saved answer for Priya";
          if (!p.anyTime) return "anyTime is false";
          const invented = [
            p.cuisines.length ? `cuisines ${p.cuisines.join(", ")}` : "",
            p.avoidCuisines.length ? `avoid ${p.avoidCuisines.join(", ")}` : "",
            p.dietary.length ? `dietary ${p.dietary.join(", ")}` : "",
            p.budgetCents !== undefined ? "a budget" : "",
            p.plusOnes ? "plus-ones" : "",
          ].filter(Boolean);
          return invented.length === 0 || `invented ${invented.join("; ")}`;
        },
      },
    ],
  },

  {
    id: "plus-one",
    title: "Friend asks to bring their partner",
    area: "planning",
    planRef: "Edge cases > Planning: Someone brings a plus-one",
    critical: false,
    seed: (ctx) =>
      seedToPlanning(ctx, {
        preferences: {
          maya: { slot_ids: ["C"] },
          sam: { slot_ids: ["C", "D"] },
          priya: { slot_ids: ["B", "C"] },
          alex: { slot_ids: ["C"] },
        },
      }),
    inbound: [{ from: "jordan", text: "C or D! can I bring my partner?" }],
    replies: [{ to: "pranav", when: /partner|plus[- ]?one|bring/i, reply: "Of course, the more the merrier." }],
    maxRuns: 5,
    checks: [
      {
        description: "Jordan's plus-one is saved",
        test: (h) => {
          const p = prefOf(h, "jordan");
          if (!p) return "no saved answer for Jordan";
          return p.plusOnes === 1 || `plusOnes is ${p.plusOnes}`;
        },
      },
      {
        description: "pick_time decided once everyone answered",
        test: (h) =>
          okCallsNamed(h, "pick_time").some((c) => resultOf(c.result).decided === true) || "no decided pick_time call",
      },
      {
        description: "pick_time's party_size counts the plus-one",
        test: (h) => {
          const decided = okCallsNamed(h, "pick_time").map((c) => resultOf(c.result)).filter((r) => r.decided === true);
          if (!decided.length) return "no decided pick_time call";
          const byName = new Map(h.finalEvent.people.map((p) => [p.name, p.id]));
          for (const r of decided) {
            const canMake = Array.isArray(r.can_make) ? r.can_make.map(String) : [];
            if (!canMake.includes("Jordan")) return `Jordan isn't in can_make (${canMake.join(", ")})`;
            const expected = canMake.reduce((sum, name) => {
              const pref = prefOf(h, byName.get(name) ?? name);
              return sum + 1 + (pref?.plusOnes ?? 0);
            }, 0);
            if (r.party_size !== expected) return `party_size ${String(r.party_size)}, expected ${expected}`;
            if (Number(r.party_size) <= canMake.length) return `party_size ${String(r.party_size)} has no plus-one`;
          }
          return true;
        },
      },
    ],
  },

  {
    id: "vote-tie",
    title: "Restaurant vote ties; the organizer's vote breaks it",
    area: "voting",
    planRef: "Edge cases > Planning: Vote tie",
    critical: false,
    seed: (ctx) => seedToVoting(ctx, { votes: { maya: "1", priya: "1", jordan: "2", alex: "2" } }),
    inbound: [
      { from: "sam", text: "1 please!" },
      { from: "pranav", text: "Put me down for 2", afterMinutes: 3 },
    ],
    replies: [{ to: "pranav", when: /\bbook\b/i, reply: "Let me double check with my partner first, hold off on booking for now." }],
    maxRuns: 5,
    checks: [
      {
        description: "Sam's and the organizer's votes were recorded",
        test: (h) => {
          const vote = (id: string) => h.finalEvent.votes.find((v) => v.personId === id)?.restaurantId;
          if (vote("sam") !== "1") return `Sam's vote is ${vote("sam")}`;
          return vote("pranav") === "2" || `Pranav's vote is ${vote("pranav")}`;
        },
      },
      {
        description: "tally_votes: option 2 wins the 3-3 tie as the organizer's choice",
        test: (h) => {
          const r = okCallsNamed(h, "tally_votes").map((c) => resultOf(c.result)).find((x) => x.decided === true);
          if (!r) return "no decided tally_votes call";
          const winner = resultOf(r.winner);
          if (winner.id !== "2") return `winner is ${String(winner.name ?? winner.id)}`;
          return r.tie_broken_by === "organizer" || `tie_broken_by ${String(r.tie_broken_by)}`;
        },
      },
      {
        description: "The saved winner is option 2",
        test: (h) => h.finalEvent.winningRestaurantId === "2" || `winningRestaurantId is ${h.finalEvent.winningRestaurantId}`,
      },
      {
        description: "The organizer is told the real winner after the tally",
        test: (h) => {
          const name = h.finalEvent.restaurantOptions.find((o) => o.id === "2")?.name ?? DEFAULT_RESTAURANTS[1]!.name;
          const at = toolEvents(h, "tally_votes").find((e) => e.ok && resultOf(e.result).decided === true)?.index;
          if (at === undefined) return "no decided tally_votes";
          return (
            textsFromFo(h, organizerOf(h).id).some((t) => t.index > at && t.text.toLowerCase().includes(name.toLowerCase())) ||
            `no text to the organizer names ${name}`
          );
        },
      },
      {
        description: "Nothing was booked (organizer said hold off), and never a losing option",
        test: (h) => {
          const name = h.finalEvent.restaurantOptions.find((o) => o.id === "2")?.name ?? DEFAULT_RESTAURANTS[1]!.name;
          const wrong = callsNamed(h, "confirm_booking").filter((c) => String(c.args.restaurant_name) !== name);
          if (wrong.length) return `confirm_booking for ${String(wrong[0]!.args.restaurant_name)}`;
          return h.finalEvent.booking === undefined || `booked ${h.finalEvent.booking.restaurantName}`;
        },
      },
    ],
  },

  {
    id: "locked-pick-preference-objection",
    title: "Friend would rather do sushi; the organizer's pick is locked",
    area: "planning",
    planRef: "Conflict resolution > When a friend wants to change the organizer's pick: Preference, locked pick",
    critical: false,
    seed: (ctx) =>
      seedToTimePicked(ctx, { organizerPick: { restaurant_name: "Luigi's Trattoria", firmness: "locked" } }),
    inbound: [{ from: "maya", text: "luigi's again?? honestly I'd rather do sushi this time" }],
    replies: [
      {
        to: "pranav",
        when: /sushi/i,
        reply: "Ha, noted. Luigi's stays this time, I'll sort out the booking later.",
      },
    ],
    maxRuns: 4,
    checks: [
      {
        description: "No vote or shortlist was opened",
        test: (h) => {
          const r = noVoteOrShortlist(h);
          if (r !== true) return r;
          // A real ballot, not the word "vote" (Fo may say "I passed along your vote for sushi").
          const vote = h.allTexts().find((t) => /vote for a spot|reply with a number|\b1\)[^\n]*\b2\)/i.test(t.text));
          return !vote || `asked ${vote.to} to vote`;
        },
      },
      {
        description: "The locked pick is unchanged",
        test: (h) => {
          if (callsNamed(h, "update_event").some((c) => c.args.organizer_pick !== undefined)) return "update_event touched organizer_pick";
          const pick = h.finalEvent.organizerPick;
          return (pick?.restaurantName === "Luigi's Trattoria" && pick.firmness === "locked") || `pick is ${JSON.stringify(pick)}`;
        },
      },
      {
        description: "Any booking is Luigi's",
        test: (h) => {
          const bad = callsNamed(h, "confirm_booking").filter((c) => !/luigi/i.test(String(c.args.restaurant_name)));
          return bad.length === 0 || `confirm_booking for ${String(bad[0]!.args.restaurant_name)}`;
        },
      },
      {
        description: "Maya gets a reply",
        test: (h) => h.textsTo("maya").length > 0 || "no text to Maya",
      },
      {
        description: "The organizer hears about the sushi request privately",
        test: (h) => h.textsTo(organizerOf(h).id).some((t) => /sushi/i.test(t)) || "no text to the organizer mentions sushi",
      },
      {
        description: "No other friend hears about it",
        test: (h) => {
          const leak = textsExcept(h, organizerOf(h).id, "maya").find((t) => /sushi/i.test(t.text));
          return !leak || `told ${leak.to}: "${leak.text}"`;
        },
      },
    ],
  },

  {
    id: "hard-constraint-after-pick",
    title: "Friend reveals a severe nut allergy after the place is booked",
    area: "planning",
    planRef: "Conflict resolution > When a friend wants to change the organizer's pick: Hard constraint, locked pick",
    critical: false,
    seed: (ctx) =>
      seedToBooked(ctx, {
        via: "locked",
        organizerPick: { restaurant_name: "Lotus Thai Kitchen", firmness: "locked" },
        cuisineHint: "Thai",
        confirmation: "LTK-3318",
      }),
    inbound: [
      {
        from: "priya",
        text: "hey kind of awkward but I have a pretty bad peanut allergy, like epipen level. is the thai place going to be ok?",
      },
    ],
    replies: [
      {
        to: "pranav",
        when: ALLERGY,
        reply: "Oh no, good catch. Don't change anything yet, I'll decide tonight.",
      },
    ],
    maxRuns: 4,
    checks: [
      {
        description: "The organizer is told about the allergy",
        test: (h) => h.textsTo(organizerOf(h).id).some((t) => ALLERGY.test(t)) || "no text to the organizer mentions the allergy",
      },
      {
        description: "Fo suggests an alternative to the organizer",
        test: (h) =>
          h.textsTo(organizerOf(h).id).some((t) =>
            /instead|alternative|switch|another|other (place|spot|restaurant|option)|nearby|swap|move/i.test(t),
          ) || "no text to the organizer suggests an alternative",
      },
      {
        description: "Nobody but the organizer and Priya hears about the allergy",
        test: (h) => {
          const leak = textsExcept(h, organizerOf(h).id, "priya").find((t) => ALLERGY.test(t.text));
          return !leak || `told ${leak.to}: "${leak.text}"`;
        },
      },
      {
        description: "Priya isn't named to other friends",
        test: (h) => {
          const leak = textsExcept(h, organizerOf(h).id, "priya").find((t) => /\bpriya\b/i.test(t.text));
          return !leak || `named Priya to ${leak.to}`;
        },
      },
      {
        description: "Priya gets a reply",
        test: (h) => h.textsTo("priya").length > 0 || "no text to Priya",
      },
      {
        description: "The booking is unchanged without the organizer's go-ahead",
        test: (h) => {
          const r = noBookingSince(h, "Lotus Thai Kitchen");
          if (r !== true) return r;
          return h.finalEvent.booking?.confirmation === "LTK-3318" || "the confirmation changed";
        },
      },
    ],
  },
];
