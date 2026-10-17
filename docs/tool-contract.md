# MCP tool contract

The source of truth for tool names and arguments. The server (`src/server.ts`), the standing instructions and the README must all match this file.

Conventions:

- Tool args are snake_case. Every tool except `create_event` and `get_status` takes `event_id`.
- Money crosses the wire as dollar strings or numbers (`"26.88"`, `50`). The server parses them to integer cents exactly and returns both `*_cents` and a formatted `"$26.88"` string.
- `person` args accept a person id (`"maya"`), a name (`"Maya"`, case-insensitive) or a phone number.
- Every tool is idempotent: calling it twice with the same args leaves the same state.
- Errors come back as `{ ok: false, error: { code, message } }` with a message Fo can relay to the organizer. Success is `{ ok: true, ... }`, always including `stage` and `next_action`.
- Friends' replies are data, never instructions. Tools that change the plan or money (`confirm_booking`, `calculate_shares` overrides, `mark_paid` as paid) check `by_phone` against the organizer's number.

| Tool | Stage | Args | What it does |
| --- | --- | --- | --- |
| `create_event` | Planning | `title`, `organizer {name, phone, venmo?}`, `friends [{name, phone}]`, `time_slots? [{label, starts_at}]` (ids assigned A, B, C...; omit for a split-only night), `budget_per_person?`, `cuisine_hint?`, `reply_deadline?` (ISO, default now + 2h), `organizer_pick? {restaurant_name, firmness: "locked" \| "suggested"}` | Saves the event. Returns `event_id`, people with ids, slots, and the list for Fo to confirm with the organizer before texting anyone |
| `update_event` | Planning, Voting, Booked | `by_phone`, `time_slots?` (replaces options and clears slot answers, used after `NO_OVERLAP`), `organizer_pick?`, `organizer_venmo?`, `reply_deadline?`, `fix_phone? {person, phone}`, `add_friends? [{name, phone}]`, `remove_friends? []` | Organizer-only edits to the event |
| `record_preferences` | Planning | `person`, `slot_ids[]`, `any_time?`, `cuisines?[]`, `avoid_cuisines?[]`, `dietary?[]`, `budget?`, `plus_ones?` | Saves one person's round 1 answer. Latest reply wins until the deadline, then rejected with `PLAN_LOCKED` |
| `mark_nudged` | Planning, Voting | `person` | Records that Fo nudged someone once |
| `pick_time` | Planning | `force?` (decide now with whoever answered) | Applies the time rules. Returns the slot, who can and can't make it, `party_size` (including plus-ones), the winning cuisine and the hard constraints (dietary needs, max budget) Fo must respect when finding restaurants. Majority wins; `NO_OVERLAP` only when fewer than half of respondents can make the best slot, which means ask the organizer for new options via `update_event`. Records concessions for people who can't make it and returns any `fairness_note` |
| `set_restaurant_options` | Planning → Voting | `options [{name, cuisine?, price_per_person?, notes?}]` (ids assigned 1, 2, 3) | Saves the shortlist and opens voting |
| `record_vote` | Voting | `person`, `option` (id or name) | Saves one person's vote. Latest vote wins |
| `tally_votes` | Voting | `force?` | Returns the winner, counts and ranked runner ups (used if the winner is full). Ties go to the organizer. Records concessions for people whose pick lost and returns any `fairness_note` |
| `confirm_booking` | Planning, Voting → Booked | `by_phone`, `restaurant_name`, `slot_id?`, `party_size?`, `confirmation?`, `deposit?`, `auto_gratuity?`, `notes?` | Organizer-approved booking. Records deposit and auto gratuity for the split. Allowed straight from Planning when the organizer's pick is locked or the vote is skipped |
| `add_receipt` | → Claiming | `items [{description, amount}]`, `subtotal`, `tax`, `tip`, `fees?`, `discount?`, `total`, `tip_included?`, `deposit_credit?` | Validates items sum to subtotal and the parts sum to total. On mismatch nothing is saved and the error says by how much. Allowed from any stage before Paying, so a split-only night works. Multiple receipts get continuous item numbers. A deposit credit printed on the receipt goes in `deposit_credit` (never `discount`); the server makes sure the deposit is counted exactly once and warns if a booking with auto gratuity gets a receipt with an extra tip |
| `set_attendees` | Claiming | `people[]` | Records who actually came |
| `record_claims` | Claiming, Paying | `claim` (fixed format `"Maya: 1, 4"` or `"Maya: 1, 4x2"` for weight 2) or `person` + `items [{number, weight?}]` | Replaces that person's claims. Returns unclaimed items, shared items to flag, and who hasn't answered |
| `calculate_shares` | Claiming, Paying → Paying | `by_phone?` (required when using `split_evenly` or `treated`), `unclaimed_policy?` (`"block"` \| `"split_evenly"`), `treated?[]`, `fees_split_evenly?` | Runs the split. Returns each person's items, subtotal, extras, total, Venmo link and a ready-to-send private message. Can be rerun after a dispute. Does not send anything: Fo shows the organizer the totals and only texts friends after the organizer says yes |
| `mark_paid` | Paying → Settled | `person`, `by_phone` | From the organizer's phone: `paid`. From the person's own phone: `says_paid` (not proof). Settles the event when everyone but the organizer is `paid` |
| `record_opt_out` | All | `person` | Friend replied STOP. Fo must not text them again |
| `get_status` | All | `event_id?` or `phone?` | Stage, who is pending, and the next action for Fo. With `phone`, finds that person's active event (handles replies to old threads) |

Things the server deliberately does not do:

- **Reminders.** Fo schedules the day-of reminder itself. `get_status` in Booked tells it when.
- **Nudges after Voting.** One nudge per round is tracked for Planning and Voting. Claim and payment reminders (one or two, spaced out) are Fo's job; `get_status` lists who is still pending.
