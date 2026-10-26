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
  shared token is the gate; requests without it are rejected with `{success:false}`
  and logged as `unauthorised`.
- Apps Script does not expose request headers, so the token travels in the JSON
  `body.token` (Vapi tool bodies carry it as a static field) or as a `token` query
  parameter. `X-Auth-Token` is still read if the runtime ever exposes headers. See
  [../apps-script/DEPLOY.md](../apps-script/DEPLOY.md).
- The Sheet itself is never shared publicly.
- The assistant is instructed never to read out stored personal data for a number
  other than the caller-ID match.

## Availability algorithm (authoritative spec)

Every `check_availability` / `create_booking` call must apply these rules in this
order. `create_booking` re-runs the whole test inside the lock; a slot that passes
here can still lose the race, which is why the failure path returns alternatives.

Inputs: `service_id`, `addon_ids[]`, `preferred_date`, `time_preference`
(`morning` | `afternoon` | `any` | a spoken time).

1. **Duration.** `duration = service.duration_minutes + sum(addon.extra_duration_minutes)`
   for the add-ons that resolve to an active row. Unknown add-on ids are ignored and
   reported in `notes`.
2. **Full-day services.** If `service.requires_full_day = TRUE`, the booking occupies
   the entire open→close window for that weekday, whatever `duration_minutes` says.
3. **Candidate grid.** For the preferred date, generate start times from `open` to
   `close - duration` in steps of `Config.slot_granularity_minutes` (default 30, from
   `open`, so 08:00, 08:30, 09:00 …). For a full-day service there is exactly one
   candidate: `open`.
4. **Date window.** Reject the date if `start < now + booking_lead_time_hours` or
   `start > now + max_days_ahead` days.
5. **Weekday hours.** Reject if the weekday row is missing, `is_closed = TRUE`,
   `open`/`close` are blank, or the candidate is outside `open`→`close`.
6. **Lunch.** Reject a candidate whose interval `[start, end)` intersects
   `[lunch_start, lunch_end)` when both lunch values are set.
7. **Holidays and closures.** Reject the date entirely when a `Holidays_Closures` row
   has `full_day = TRUE`. When `full_day = FALSE`, the day's usable window becomes
   that row's `open`→`close` (an early close), and a candidate outside it is rejected.
   Rejections carry the row's `reason` so the agent can say why.
8. **Capacity.** Count current occupancy of the interval
   `[start, end + buffer_minutes_between_jobs)`. A candidate is free when
   `overlapping_count < bays_available`. A candidate conflicts with an existing job
   `[e_start, e_end)` when
   `start < e_end + buffer AND e_start < end` — i.e. the buffer is charged after each
   existing job, never before the candidate.
9. **Occupancy sources.** Both, deduplicated by event id:
   - `Bookings` rows with `status = Confirmed` (cancelled/completed/no-show do not block)
   - live events in the `Workshop Bookings` calendar, read with `events.list` over the
     candidate day (± 1 day, to catch overnight events and timezone edges). This means
     an event the mechanic adds by hand still blocks the slot.
10. **Ranking.** Return up to 3 slots ordered by `time_preference` (morning = before
    12:00, afternoon = 12:00+, any = chronological), then by earliest start. If the
    preferred day yields nothing, widen day by day up to `max_days_ahead` and say the
    date had no space.

`create_booking` adds:

11. `LockService.getScriptLock()` (30 s) around steps 1-10 plus all writes.
12. Booking row first (status `Confirmed`), then the Calendar event, then write
    `calendar_event_id` back to the row. If the Calendar call fails the booking still
    stands and `notes` gets `calendar_sync_failed`, so a Google outage cannot lose a
    booking the caller was just told about.

## Calendar conventions

Calendar: **Workshop Bookings**, timezone `Australia/Melbourne`, recorded state in
[../calendar/calendar-config.json](../calendar/calendar-config.json).

- Title: `[Service] - [Customer] - [Rego]` (e.g. `Minor Service - Sam Taylor - ABC123`).
- Description: phone, vehicle, add-ons, estimated price range, `Booking ID: BK00001`,
  and `Booked by: AI receptionist`.
- Start/end come from the booking's `start_datetime` / `end_datetime`; a per-event
  60-minute popup reminder is set (calendar default reminders disabled so hand-made
  events are not double-notified).
- `transparency: opaque` so the slot looks busy to anyone reading the calendar.

## Concurrency

All writes go through `LockService.getScriptLock()` with a 30 s timeout. Inside the
lock the slot is re-validated from scratch, so two simultaneous calls for the same
slot cannot both succeed; the loser gets `success:false` plus the three nearest
alternatives.

## Two deployment targets, one backend

The business logic in `apps-script/src/` is the only implementation. It runs in two
places:

| Target | How it runs | When to use |
|---|---|---|
| **Google Apps Script** | `clasp push` + web app deployment (needs a browser consent once) | the workshop owns its Google account and a 6-minute-per-execution backend is fine |
| **Self-hosted runtime** | `deploy/deploy.sh` → `https://diyyourdata.com/workshop-api/` | you want a URL today, without an interactive Google deploy, or you want the latency and logging of a normal server |

`server/gas-runtime.js` implements `SpreadsheetApp`, `CalendarApp`, `LockService`,
`PropertiesService`, `ContentService` and `Utilities.formatDate` on top of the Google
REST APIs; `server/serve.js` compiles the unchanged modules into a fresh `vm` context
per request and calls the same `doPost`. Vapi points at whichever URL is live — the tool
definitions are identical apart from `{{APPS_SCRIPT_WEBAPP_URL}}`.

Differences worth knowing: Apps Script gives a fresh execution per request (the runtime
gives a fresh `vm` context per request), Apps Script's `LockService` serialises across
executions (the runtime's handlers are synchronous and single-process, so writes cannot
interleave — the lock call is kept for API compatibility), and the runtime adds a
10-second read cache on the Config/catalogue tabs while leaving Bookings uncached.

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
