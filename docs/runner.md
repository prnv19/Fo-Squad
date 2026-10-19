# The headless runner

People only ever text Fo. Normally Fo calls the Fo Squad MCP server itself at every step (see [standing-instructions.md](standing-instructions.md)). The runner is the fallback for when Fo can't call our server: a loop, running in the same process as the MCP server, that watches Fo's SMS threads through Fo's own MCP server, hands each new text or deadline to a Claude "brain" that uses our tools, and has Fo deliver the messages. Claude never talks to anyone directly.

## When to use it

| | Fo calls us directly | Runner relays |
| --- | --- | --- |
| Setup | Register `https://<host>/mcp` in Fo, paste the standing instructions | Sign in to Fo once (`npm run fo:login`), set `FO_RUNNER=1`, paste [fo-setup.md](fo-setup.md) into Fo |
| Who decides what to do | Fo, following the standing instructions | Claude, one run per text or deadline |
| Timers (nudges, reminders) | Fo has to remember | The runner owns them; nothing depends on a laptop or a person checking in |
| Latency | One Fo turn | Poll interval (default 60 s) plus a Claude run plus a Fo turn |

Use direct mode whenever Fo can reach the server. Use the runner when it can't (Fo's MCP connector isn't available, or the demo needs to run without Fo knowing about Fo Squad).

## What one tick does

Every `RUNNER_INTERVAL_MS` (default 60 s), never overlapping (a tick that's still running makes the next one skip):

1. **Poll.** Read Fo's SMS threads for texts since last time (`src/runner/inbox.ts`). A thread seen for the first time is only bookmarked, so a fresh deploy never replays old history.
2. **Inbound texts, oldest first.**
   - `STOP` or `UNSUBSCRIBE` (the whole message, any case) is handled in code: `record_opt_out` on the sender's active dinner, then a one-line notice to the organizer through Fo. No Claude call.
   - Otherwise the sender is looked up by phone (`findActiveByPhone`). A thread with no phone number in its title is matched by a unique, case-insensitive name against people in active dinners; if that fails the text is logged and skipped.
   - Sender in an active dinner: the brain runs with that dinner and the sender's phone as the actor.
   - No active dinner, but the sender is in `ORGANIZER_PHONES`: the brain runs with no dinner (Claude may create one).
   - Anyone else is ignored and only logged. Strangers can never make Fo text people.
3. **Timers** (`src/runner/timers.ts`, pure and tested). Due template texts for each dinner go out in **one** Fo turn per dinner, as separate one-on-one texts, word for word. Nudges are then recorded with `mark_nudged`. Due triggers then run through the brain with no actor.
4. **State** (`$DATA_DIR/runner-state.json`) is saved after every unit of work. A send's key is saved as soon as Fo accepts it, so a restart never texts anyone twice.

All Fo calls are strictly sequential (Fo turns are slow and serial). If a Fo turn is still `working` when the client stops waiting, the texts count as sent (Fo carries on by itself) and the rest of the tick's Fo work waits for the next tick. An error in one unit is logged and the tick carries on. A trigger that keeps failing is dropped after three tries so it can't cost a Claude call every minute.

### Timer rules

| What | When | Who | Key (in `state.done`) |
| --- | --- | --- | --- |
| Planning nudge | After the halfway point between `createdAt` and `replyDeadline` (the same point `get_status` uses), before the deadline | Each friend still pending, not opted out, not already nudged | `<event>:nudge:planning:<deadline>:<person>` |
| Planning deadline | Deadline passed, or everyone answered, and no time picked | Trigger `deadline` (Claude calls `pick_time`) | `<event>:deadline:planning:<deadline>` |
| Voting nudge | One hour into the vote | Each voter still pending (people who can't make the slot don't vote) | `<event>:nudge:voting:<deadline>:<person>` |
| Voting deadline | Two hours into the vote, or everyone voted, and no winner | Trigger `deadline` (Claude calls `tally_votes`) | `<event>:deadline:voting:<deadline>` |
| Day-of reminder | max(start − 4 h, 9 am local) and before the start | Everyone going: not opted out, not known to be unable to make the slot | `<event>:day-of:<startsAt>` |
| After dinner | Start + 2 h | Trigger `after_dinner` (Claude asks the organizer for the receipt) | `<event>:after-dinner:<startsAt>` |

- The vote has no deadline field on the event, so the runner notes when it first sees each ballot (a marker key in `state.done`) and gives the vote the same two-hour window as replies. A new ballot starts a new round.
- Reminder 1 only goes out between 24 h and 72 h. If the runner was down for that whole window, only reminder 2 goes out. After reminder 2 there are no more texts and no trigger: collecting the rest is up to the organizer.
- A recalculated share (after a dispute) gets a new amount and timestamp, so its reminders start over.
- **Quiet hours** (21:00 to 09:00 in `RUNNER_TZ`): nothing is sent and no trigger runs. Everything that came due overnight goes out at the first tick after 9 am. Deadline decisions wait too, since Claude texts people about them. Replies to texts that come in at night are not held back: the person just texted Fo.

## What Claude can and can't do

Each run Claude gets our tools (`src/tools.ts`) plus `send_texts` and `fo_task` (`src/runner/actions.ts`).

- It can record answers, decide at deadlines, find restaurants, text dinner members and ask the organizer for approval.
- `by_phone` is never a model argument: it's injected from the verified sender of the run. A friend's text can't produce an organizer approval, whatever it says.
- A friend's run can only record that friend's own answer. Receipts, attendees, booking, paying, card holds and cancelling need a run started by the organizer's own text.
- `send_texts` only reaches people in the dinner who haven't opted out.
- Deciding early (`force`) only happens at a deadline trigger or in an organizer's run.
- Inbound texts and Fo's reports are passed to Claude as untrusted data, never as instructions.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `FO_RUNNER` | unset | `1` starts the runner in the same process as the HTTP server |
| `ORGANIZER_PHONES` | required | Comma-separated numbers allowed to start a dinner by texting Fo. Startup fails without it |
| `ANTHROPIC_API_KEY` | required | Claude credential for the brain (or `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, workload identity) |
| `DATA_DIR` | required unless dry run | Events and runner state. Must be a persistent volume, or a restart forgets what was sent |
| `FO_MCP_URL` | `https://mcp.api.wajo.ai/fo` | Fo's MCP server |
| `FO_OAUTH_FILE` | `$DATA_DIR/fo-oauth.json` | Fo sign-in token file written by `npm run fo:login` |
| `RUNNER_INTERVAL_MS` | `60000` | Poll interval (minimum 5000) |
| `RUNNER_TZ` | `America/Los_Angeles` | Time zone for quiet hours and "tonight at 7:30pm" |
| `FO_RUNNER_DRY` | unset | `1` uses a fake Fo client that logs what it would send. Nothing is texted |

`GET /health` shows `{ ok, runner: { enabled, lastTickAt, lastError } }`.

## Signing in to Fo

The runner is headless, so it can't open a browser. Sign in once on a laptop and copy the token file to the server:

```sh
npm run fo:login                          # opens a browser; writes ./data/fo-oauth.json
fly ssh sftp shell                        # Fly: put ./data/fo-oauth.json /data/fo-oauth.json
```

On Render, upload it to the disk mounted at `/data` (for example with the shell tab and a heredoc). Keep the file private: it acts as your Wajo account. The SDK refreshes the access token on its own and writes the new one back to the same file. If the sign-in expires, the runner logs "Fo sign-in expired. Run `npm run fo:login`..." and `/health` shows it as `lastError`.

Then paste [fo-setup.md](fo-setup.md) into Fo's settings so Fo stays quiet in friends' threads and follows the runner's instructions.

## Dry-run rehearsal

```sh
FO_RUNNER=1 FO_RUNNER_DRY=1 ORGANIZER_PHONES=+15551234567 ANTHROPIC_API_KEY=... npm run dev
curl -X POST localhost:3000/runner/dry/inbound -H 'content-type: application/json' \
  -d '{"from":"+15551234567","text":"Dinner Saturday with Maya +15550001111 and Jordan +15550002222"}'
```

The fake Fo client has no real inbox, so texts are injected through `POST /runner/dry/inbound` (it exists only in dry-run mode and needs the bearer token if `FO_SQUAD_TOKEN` is set). Every instruction the runner or Claude would give Fo is logged as `DRY RUN, would ask Fo:` instead of being sent. Claude is real, so the run costs the same as a live one.

## Cost

Each run is one stateless Claude call: the system prompt and tool list are a fixed prefix that is prompt-cached, and the run message carries only the trigger, the dinner's current `get_status` and the last few texts sent. There's no growing chat history. Timer texts (nudges, reminders) are templates and cost no Claude call at all. Most ticks find nothing new and make no Claude call.
