# Architecture

## Components

| # | Component | Role | Why |
|---|---|---|---|
| 1 | Vapi phone number | Public PSTN entry point | Free US number now; an AU number can be imported later via Twilio/Telnyx without changing the assistant |
| 2 | Vapi assistant | Speech-to-speech orchestration: transcriber, LLM, voice, tools | Handles VAD, interruption, tool calling and webhooks without us running realtime infrastructure |
| 3 | ElevenLabs voice | TTS persona | Best naturalness/latency trade-off via a Flash/Turbo model |
| 4 | Apps Script web app | The only backend. Stateless JSON router. | Zero hosting cost, native access to Sheet + Calendar under the owner's own Google identity |
| 5 | Google Sheet | Config + catalogue + CRM + bookings + logs | Owner-editable single source of truth; no deploy needed to change a price |
| 6 | Google Calendar | Human-visible schedule | The mechanic already lives in a calendar; also the conflict source for availability |

## Data flow

1. Caller dials the Vapi number. Vapi answers with the assistant.
2. Assistant calls `lookup_customer` with the caller ID before greeting (returning
   customer recognition).
3. For a quote: `list_services` -> `get_price_quote`.
4. For a slot: `check_availability` (computed from Working_Hours, Holidays_Closures,
   Bookings and live Calendar events).
5. On confirmation: `create_booking` -> `LockService` -> re-validate slot -> upsert
   customer/vehicle -> append Bookings row -> create Calendar event -> write event ID
   back -> return spoken confirmation.
6. End of call: Vapi webhook -> `log_call_summary` -> `Call_Log`.
7. Every tool call is appended to `Call_Log` with request/response JSON.

## Trust boundaries

- The web app is deployed "Execute as me / Anyone", so it is reachable by URL. The
  shared token (`X-Auth-Token` header, or `token` body/query param) is the gate;
  requests without it are rejected with `{success:false}` and logged as
  `unauthorised`.
- The Sheet itself is never shared publicly.
- The assistant is instructed never to read out stored personal data for a number
  other than the caller-ID match.

## Concurrency

All writes go through `LockService.getScriptLock()` with a 30 s timeout. Inside the
lock the slot is re-validated from scratch, so two simultaneous calls for the same
slot cannot both succeed; the loser gets `success:false` plus the three nearest
alternatives.

## Why Apps Script and not a Node service

- Calendar + Sheets OAuth is already solved by the owner's Google identity.
- No server to patch, no TLS, no uptime monitoring, no cost.
- Cold start is ~0.5-1.5 s; acceptable because the agent speaks a filler line
  ("let me check that for you") before every tool call.
- The trade-off is a hard ~6 min execution cap and no websockets. Neither matters for
  request/response tool calls.

## Failure behaviour

| Failure | Behaviour |
|---|---|
| Sheet unreachable / exception | `{success:false, message:"I'm having trouble reaching the booking system..."}`; agent retries once then offers transfer |
| Slot taken between check and book | `success:false` + 3 alternatives, agent re-offers |
| Calendar API quota | booking is still written to the Sheet with empty `calendar_event_id`, flagged in `notes`; owner sees it in the sheet |
| Token missing/wrong | `success:false`, logged as `unauthorised`, no data in response |
