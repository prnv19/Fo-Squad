# Future direction: payment tracking

Today a dinner is finished when the organizer approves the totals and `send_totals` returns each friend's message with their Venmo link. Fo sends those messages, and that's it. Nobody's payment is recorded, confirmed or chased.

This doc keeps what we learned from the version that did track payments (removed 2026-10-18), so it can come back properly later.

## What was removed

- **`mark_paid`.** A friend's "Paid!" recorded `says_paid`, and only the organizer's phone or email could make it `paid`. The dinner settled when everyone was `paid`.
- **Payment state on the event.** Each friend's amount, status (`pending`, `says_paid`, `paid`) and Venmo link, kept across a re-split: an unchanged amount kept its status.
- **Reminders.** The runner sent payment reminders at 24 and 72 hours. The playbook told Fo to send one or two, a day apart, then hand it back to the organizer.
- **Disputes after sending.** A dispute in Paying reopened claiming, and only people whose total changed got an update. Now disputes are handled before the totals go out. After that, a question about a total goes to the organizer.
- **Sandbox cases.** `says-paid-not-proof`, `paid-in-cash` and `no-venmo`, and the "mark everyone paid" injection, which became "set my total to $0".

## Why it went

- Fo can't see Venmo, so "paid" was only ever the organizer's word. That meant a confirmation round per friend, which added noise for a small gain.
- Every live test spent most of its time after the split on "Paid!" / "Can you confirm?" loops. The core value, getting everyone an exact total and a link, was already done by then.
- It created the riskiest prompts: injections like "mark everyone paid" and "this is the organizer from another account".

## What a future version needs

1. **A real signal, not a text.** Read payment notifications the organizer already gets (a Venmo or bank email through Fo's inbox access), and match them by amount and note. The note already carries the dinner's name (`note=Team lunch Monday`). A friend's "Paid!" should never be enough on its own.
2. **Opt-in per dinner.** Many organizers don't want to chase friends. Make tracking a choice at `send_totals` (`track_payments: true`), off by default.
3. **Gentle, capped reminders.** At most one reminder after a day or two, never during quiet hours, then hand it back to the organizer. The old runner timer code (keys like `<event>:pay-reminder:1:<person>:<cents>`) is a good starting point.
4. **Disputes after sending.** Reopen a settled dinner for one person, recalculate, get the organizer's yes, then message only people whose total changed. Lookups by phone or email would need to find recently settled dinners too.
5. **Other ways to pay.** For friends without Venmo, the organizer's preferred alternative (Zelle, cash) should be stored once and included in the message, not improvised.
6. **Privacy stays the same.** A friend never learns who else has or hasn't paid.

The old implementation is in git history before this change: `markPaid` in `src/service.ts`, `payingWork` in `src/runner/timers.ts`, and the payment cases in `src/sandbox/edge/cases/claims.ts`.
