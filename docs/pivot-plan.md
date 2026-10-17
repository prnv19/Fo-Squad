# Pivot: Fo runs the night, Fo Squad is the memory and money layer

## Why

We asked Fo what it can do on its own and what it's missing. Its answer:

1. **It handles the whole flow natively:** polling the group, collecting allergies and plus-ones, calling to book, itemizing the receipt, doing the math, and drafting Venmo requests.
2. **Money is its weak spot.** It can't send or receive payments, so the last step stays with people.
3. **An MCP that repeats what Fo already does adds nothing.** One that brings something Fo lacks is worth building, like a payments rail or the group's event data.

A server that wraps Fo's native flow again is "Fo's feature with extra steps." Fo told us where the gaps are, so we build there.

Fo also runs the conversation over text and sends its own nudges and reminders. That mostly solves the "nothing happens unless someone prompts Claude" problem, so the `/loop` autopilot (`src/runner/`) may not be needed.

## The split

| Fo (native) | Fo Squad MCP (us) |
| --- | --- |
| Planning, polls, booking | Ledger of who owes whom across dinners |
| Reading the receipt | Debt simplification: fewest payments to settle up |
| Texting everyone | Fairness memory: who picked last time, who gave something up, whose turn it is |
| Drafting Venmo requests | Payment tracking through Splitwise or PayPal |
| Bill math | Checking the math |

Pitch line: *"We asked Fo what it was missing, and built that."*

## Where we add value

### 1. The group's memory (event data)

Fo handles one dinner at a time. We remember across dinners.

- **Running ledger** across many events. *Not built yet.* `EventStore` (`src/events/store.ts`) keeps one record per event, with no balances across events.
- **Debt simplification**, so the group settles with the fewest payments. *Not built yet.*
- **Fairness memory.** *Partly built.* `Concession` (`src/types.ts`) is keyed by phone number so it carries across dinners. `src/planning/fairness.ts` already gives priority to people who conceded something and marks the concession redeemed at a later dinner. Still missing: "who picked last time" and "whose turn it is."

### 2. The money layer (payments rail)

- **Splitwise** has a public API. *Confirm we can get access.* Fo could log each dinner there automatically, and balances would live somewhere the friends already trust.
- **PayPal's official MCP** can create invoices and check whether they've been paid, which answers "did they actually pay?"

### 3. Trust but verify

Fo says it does the bill math, but we didn't know how. The test is to give Fo a tricky receipt and compare its answer with our split engine. If Fo gets it right, we use Fo's math and keep ours as a checker. If it slips, that's a demo moment and a clear reason our engine exists.

## Test results (2026-10-17)

The test is pinned in `src/split/fo-benchmark.test.ts`.

**Receipt:** 4 people and 7 items. It includes a $14 burrata split three ways, a $22 pizza split 2/3 and 1/3, a $42 bottle of wine split three ways (Dev didn't drink), and a $9.99 tiramisu split four ways. Subtotal $153.49, tax $13.62, tip $30.70, total $197.81. Tax and tip are split in proportion to what each person ate.

We asked Fo for numbers only, in a fresh conversation, and told it not to contact anyone.

| Person | Fo | Exact reference | Our engine |
| --- | --- | --- | --- |
| Alex | $46.18 | $46.18 | $46.19 |
| Bea | $52.40 | $52.40 | $52.41 |
| Cam | $72.06 | $72.06 | $72.05 |
| Dev | $27.17 | $27.17 | $27.16 |
| **Sum** | **$197.81** | **$197.81** | **$197.81** |

**Fo got it exactly right.** It computed the unrounded totals (for example, Alex is $46.176931), rounded everyone down to the cent, and then gave the 3 leftover pennies to the people with the largest fractions. It also pointed out that rounding each amount separately would sum to $197.82. A reference implementation in the test, which allocates the grand total once by each person's exact subtotal, matches Fo to the penny.

**Our engine balances but is not penny-exact.** `computeSplit` rounds each item's shares before adding them up. On a $14 / 3 burrata or a $9.99 / 4 tiramisu, the extra penny goes to whoever is listed first (ties go to the lower index), so Alex picks up rounding pennies and Dev loses them. In this receipt that leaves every person 1¢ off the exact split (Alex is +1.3¢ off the unrounded amount). The totals still add up to the receipt, so nobody is overcharged as a group. But if Fo and our engine both report numbers, they will disagree by a penny, and the demo would show that.

**What this means for the plan:**

- Use Fo's math as the main answer, as the plan suggests. As a checker, our engine should accept differences of up to 1¢ per person and require an exact match on the total. Or the engine should do one largest-remainder pass on exact totals, as Fo does. The per-item breakdown could still show rounded shares, with a note that line items may be off by a penny.
- The "Fo slips" demo moment did not happen on this receipt. The pitch should lean on memory and money, not on math.

## Next steps

1. Decide on the engine: change it to round once at the end like Fo, or keep per-item rounding and allow a 1¢ tolerance when checking.
2. Confirm Splitwise API access. Check whether the PayPal MCP can be used for invoice and paid-status checks.
3. Design the ledger: balances across events keyed by phone (the same key `Concession` uses), plus debt simplification.
4. Extend fairness memory with "who picked last" and "whose turn it is."
5. Change the MCP tools to match: drop the tools that repeat Fo's native flow, and add ledger, settlement, and verification tools.
6. Decide whether to keep or remove the `/loop` runner (`src/runner/`), now that Fo sends its own nudges.
