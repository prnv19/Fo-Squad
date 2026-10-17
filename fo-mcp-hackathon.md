# Fo MCP: hackathon spec

Fo gets things done in the real world from your Wajo account: email, calendar, calls, purchases, your connected apps. The Fo MCP server lets any MCP client talk to Fo, by text or by live voice.

**Fo's actions are real.** Emails go to real people, calls ring real phones, purchases spend real money. Test on yourself first.

## 1. Connect

| | |
|---|---|
| Endpoint | `https://mcp.api.wajo.ai/fo` (Streamable HTTP) |
| Auth | OAuth: your client opens a browser and you sign in with your Wajo account |
| Account | Your Wajo account needs the **OG Fo** plan (hackathon accounts have it). On Fo mini, sign-in is refused with "that account's plan doesn't include this". |

```sh
claude mcp add --transport http fo https://mcp.api.wajo.ai/fo   # then run /mcp to sign in
```

```json
{ "mcpServers": { "fo": { "url": "https://mcp.api.wajo.ai/fo" } } }
```

For Claude.ai or ChatGPT, add the endpoint as a custom connector and sign in when prompted.

## 2. Tools

| Tool | Input | Output |
|---|---|---|
| `ask_fo` | `message` (required), `conversationId`?, `newConversation`? | `status`, `conversationId`, `response`?, `progress`?, `elapsedSeconds`? |
| `get_fo_reply` | `conversationId`?, `waitSeconds`? (0–40, default 40) | same as `ask_fo`, with `response` always set |
| `list_fo_conversations` | none | `conversations[]`: `conversationId`, `title`, `channel`, `startedAt`? |
| `get_fo_conversation` | `conversationId` (required) | `conversation` (same fields as a list row) + `turns[]`: `role`, `text`, `at`?, `runId`? |
| `start_fo_call` | none | `joinUrl`, `expiresAt` |

- `status` is `complete`, `working` or `failed`.
- Omit `conversationId` to use your current conversation. `newConversation: true` starts a fresh one. You can't pass both.
- Ids come from the server. A made-up `conversationId` returns an error. Don't show ids to end users.
- Errors come back as tool results with `isError: true` and a readable message.
- `list_fo_conversations` returns every channel (`chat`, `email`, `sms`, `whatsapp`, `telegram`, `slack`, `voice`, …), newest first, at most 50.
- `get_fo_conversation` returns the last 40 text turns, oldest first.

## 3. The text loop

```
ask_fo(message)            waits up to 45 s
   ├── complete ──► show response
   └── working ───► get_fo_reply   waits up to 40 s; returns early on each new step
                       ├── working ──► show progress, call again
                       ├── complete ─► show response
                       └── failed ───► show response
```

- While Fo works, `progress` is a one-line update you can show, e.g. `Working for 2m 10s: 6 tool calls so far, most recently web_search`.
- If `response` says Fo is waiting on the user (a question, or confirmation before it emails or calls someone), show it and send the answer with `ask_fo`.
- Otherwise, don't send another `ask_fo` while a turn is `working`.
- Long tasks can take 10+ minutes. Fo keeps going even if your client disconnects.

## 4. Live audio

MCP only carries text. For two-way voice, the device joins Fo's call over WebRTC (LiveKit):

```
1. start_fo_call                                       → joinUrl = https://wajo.ai/call/<ticket>
2. POST https://mcp.api.wajo.ai/v1/fo-calls/<ticket>:join   (no auth; the ticket is the credential)
                                                       → { signalUrl, participantToken, room, … }
3. LiveKit client SDK: connect(signalUrl, participantToken), publish mic, play Fo's audio track
```

A browser can simply open `joinUrl` instead.

Step 2 returns:

```json
{ "sessionId": "…", "signalUrl": "wss://livekit.api.wajo.ai", "room": "…",
  "participantToken": "…", "participantIdentity": "…",
  "tokenExpiresAt": "…", "iceTransportPolicy": "relay" }
```

Errors come back as `{ "error", "message" }`:

| HTTP | `error` | Meaning |
|---|---|---|
| 404 | `ticket_unknown` | Malformed, used or expired |
| 409 | `call_in_progress` | User already has a live call |
| 403 | `forbidden` | Account can't call Fo |
| 502/503 | `unavailable` | Call couldn't start |

Constraints:

- **The ticket.** Single use, valid for 10 minutes, and spent on redeem even if the join fails. Every call or retry needs a new `start_fo_call`.
- **The token.** Join within its ~2-minute lifetime (`tokenExpiresAt`).
- **Relay-only.** Your WebRTC stack must support relay-only ICE (TURN).
- **One call per user.**

**No WebRTC?** Run the text loop and speak `response` with on-device text-to-speech.

## 5. Notes

- Everything is scoped to your account. Connect Gmail, Calendar etc. at wajo.ai first if you need them.
- Before emailing anyone but you, or calling anyone, Fo checks that you asked for it explicitly.
