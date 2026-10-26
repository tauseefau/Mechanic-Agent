# Test plan and results

Status: **Phase 1 verified; Phases 3-6 tests not yet run.**

Sheet build verification (Phase 1, run against the live spreadsheet):

| Check | Result |
|---|---|
| 10 tabs present in order | pass |
| Header row frozen on every tab | pass (frozenRowCount=1) |
| Grid width matches schema (3/6/5/10/8/7/9/14/7/1) | pass |
| Money columns formatted `$#,##0.00` | pass (`$49.00`, `$180.00` read back) |
| Date/datetime columns formatted | pass |
| Checkbox validation on bool columns | pass (BOOLEAN rule on 5 columns) |
| Dropdown validation on enum columns | pass (status/source/category/day) |
| E.164 phone keeps leading `+` | pass (`+61400000001`) |
| Seed services/pricing present | pass (3 services, 6 add-ons) |
| Sample rows clearly marked | pass ("SAMPLE ROW - delete before go-live") |

Calendar verification (Phase 2, run against the live calendar):

| Check | Result |
|---|---|
| `Workshop Bookings` calendar exists | pass |
| Timezone `Australia/Melbourne` | pass |
| Write access (insert + delete event) | pass, 0 events left behind |
| `Config.calendar_id` = calendar ID | pass (`Config!B12`) |
| `.env` `CALENDAR_ID` set | pass |
| `calendar/calendar-config.json` matches live state | pass |

## Phase 5 — Vapi assistant

| Check | Result |
|---|---|
| Assistant created | `c936ac26-ccd6-4780-a2dd-0ea88d06c1d3` |
| Name / first message | "Riverbend Auto Service Receptionist" / "Thanks for calling Riverbend Auto Service, this is Charlie. How can I help today?" |
| Model | openai `gpt-4o-mini`, temperature 0.4 |
| Voice | 11labs `IKne3meq5aSn9XLyUdCD`, `eleven_flash_v2_5`, stability 0.45, similarity 0.75, streaming-latency opt 3 |
| Transcriber | deepgram `nova-3`, `en-AU`, smart format, numerals |
| Tools attached | 9 of 9, server URL `https://diyyourdata.com/workshop-api/?token=...` |
| System prompt | 6,032 chars resolved from `vapi/system-prompt.md`, **0 unresolved `{{PLACEHOLDER}}`** |
| Workshop values | pulled live from Config (`Riverbend Auto Service`, agent `Charlie`, transfer number) — nothing hardcoded |
| Call controls | silence timeout 20 s, max duration 600 s, 5 end-call phrases |
| End-of-call webhook | `serverMessages: end-of-call-report, status-update, tool-calls` |
| Sanitised export | `vapi/assistant.export.json` (token and IDs replaced; asserted token-free) |
| Vapi-envelope adapter | 4 new tests, all pass in harness **43/43** and live **8/8** |
| Phone number | **blocked** — see below |

Phone number blocker: Vapi refuses `POST /phone-number` without a card on file
("You must provide a credit card payment method to create additional phone numbers"). The
account's three numbers are all attached to the existing plumbing assistant, so none can be
taken without breaking it. Verified alternative: `POST /call/web` with the **public** key
returns a browser room (`webCallUrl`) for a real spoken test, no number needed.

## Phase 3b — live endpoint on diyourdata.com

Target: `https://diyyourdata.com/workshop-api/` (PHP bridge → Node service →
`apps-script/src` modules → Google REST).

| Check | Result |
|---|---|
| `/health` reads the live sheet | pass (`Riverbend Auto Service`, `Australia/Melbourne`) |
| valid token → `ping` | pass (`{"success":true,"pong":true}`) |
| no token → rejected | pass (`unauthorised` / `no_token`) |
| prices read as numbers | pass (`$49 to $79`, `$180 to $260`, `$480 to $750`) |
| closures read as dates | pass (`2026-12-25 Christmas Day`) |
| availability on a normal weekday | pass (3 slots, 08:00-09:30 first) |
| booking written to sheet + calendar event created | pass |
| latency: ping / list_services / check_availability | 0.07 s / 0.6 s / 1.2-1.6 s |
| `node tests/api-tests.js --live --slice 1:20` | **20/20 pass** |
| `node tests/api-tests.js --live --slice 21:45` | **19/19 pass** |

**39/39 pass against the live endpoint**, run as two batches 70 s apart.

Why batches: the Sheets API default quota is **60 read requests per minute per user**
(not 300 — that is the per-project figure). A full 39-test sweep issues ~100 reads in
under two minutes and inevitably returns `429` partway through, which shows up as
whichever test happened to be running. `server/http-sync.js` retries 429/5xx with
backoff (1.5 s, 4 s), and `tests/api-tests.js` now defaults to a 2 s pace plus a
`--slice a:b` selector so a live run can be split. Production traffic is a handful of
reads per call, far below 60/minute; if a workshop ever needs headroom, raise the quota
on the Google Cloud project.

Reproduce the green run:

```bash
node scripts/reset-data.js --apply
node tests/api-tests.js --live --slice 1:20
sleep 70
node tests/api-tests.js --live --slice 21:45
```

Bugs the live deployment caught that the harness could not:
1. Header-row cache hit returned a flat array (miss returned nested) → every single-row
   tab read threw. Only reproducible in a long-lived process.
2. Sheet dates arrive as serial numbers over REST → **holidays were silently ignored**.
3. `getLastColumn()` on `Call_Log` cost a full-tab read per request (~2 s).
4. `USER_ENTERED` formatting: the API returns `$49.00` unless
   `valueRenderOption=UNFORMATTED_VALUE` is set.

## Phase 4 — ElevenLabs voice

| Check | Result |
|---|---|
| ElevenLabs key valid (Bitwarden Secrets Manager) | pass, tier `starter`, 1,125 / 49,947 characters used before sampling |
| Voice list reachable | pass, 21 premade voices |
| Australian-accented voices available | 1 (Charlie, male, conversational) |
| Five shortlisted voices rendered from one identical script | pass, 200 each |
| Render latency (19-21 s script, `optimize_streaming_latency=3`) | Charlie 1,055 ms · Bella 1,270 ms · Alice 1,306 ms · Eric 1,391 ms · Lily 1,423 ms |
| Chosen voice written to `elevenlabs/voice-settings.json` | pass |
| Config `greeting_name_for_agent` matches the voice | pass (`Charlie`, `Config!B13` and `sheet/seed/config.csv`) |

Samples are committed under `elevenlabs/samples/` so the owner can compare before
go-live. The shared-voice **library** endpoint refused this key (401 on
`/v1/shared-voices`) - only premade voices are selectable without a console click.

## Phase 3 — Apps Script API

Run: `node tests/api-tests.js` — **39/39 passed** against the Node harness
(`tests/harness/gas.js`), which executes the real `apps-script/src/*.js` through the
real `doPost`/`doGet` path with sheet, calendar, lock, properties and content-service
shims seeded from `sheet/seed/*.csv`.

Covered: token gate (missing/wrong/valid, GET parity), `ping`, `get_workshop_info`
(hours, closures, currency), `list_services`, `get_price_quote` (base, +add-on,
3 add-ons, unknown add-on, unknown service), `lookup_customer` (known, local `04`
normalisation, unknown, invalid), `check_availability` (3 slots in hours, no lunch
slots, morning preference, closure named and skipped, closed Sunday skipped, Saturday
short hours, 240-min block), `create_booking` (row + customer + vehicle + calendar
event with the right title/description, bay capacity 2 with a third refusal and
alternatives, past date, lunch, outside hours, holiday, invalid phone, missing
fields), `reschedule_booking` (by id and by phone, event moved, sheet updated),
`cancel_booking` (status + event deleted, double cancel, unknown reference),
`log_call_summary`, and that every action lands in `Call_Log`.

Bugs this run found and fixed:
1. `USER_ENTERED` ate the `+` on phone numbers (found in Phase 1, regression-tested here).
2. A requested time *before opening* was silently snapped to opening instead of being
   refused — the caller would have been booked at a time they did not ask for.
3. Timestamps were emitted without a UTC offset (see D-017).
4. The harness had to learn Apps Script's quoted-literal date patterns (`'T'`).

Not yet run against a live deployment: the web app must be deployed from the
workshop's own Google account (see `apps-script/DEPLOY.md`). `node tests/api-tests.js
--live` runs the same suite once `APPS_SCRIPT_WEBAPP_URL` exists.

## Test plan

### 1. Action coverage (`tests/api-tests.js`)

| Action | Cases |
|---|---|
| `get_workshop_info` | default; with holiday in range |
| `list_services` | all active services; inactive hidden; add-ons grouped |
| `get_price_quote` | single service; service + 1 add-on; service + 3 add-ons; unknown add-on; GST in/out |
| `lookup_customer` | known phone; unknown phone; with vehicles; with upcoming bookings |
| `check_availability` | normal day; lunch excluded; holiday; past date; beyond max_days_ahead; bays 1 vs 2; full-day service |
| `create_booking` | happy path; double-book; past date; outside hours; invalid phone; new customer; returning customer with new vehicle |
| `reschedule_booking` | happy path; to a taken slot; to a holiday |
| `cancel_booking` | by booking_id; by phone+date; already cancelled |
| `log_call_summary` | writes a Call_Log row |

### 2. Edge-case matrix

| # | Case | Expected |
|---|---|---|
| 1 | Booking in the past | `success:false`, friendly message |
| 2 | Booking during lunch | `success:false`, alternatives |
| 3 | Booking on a holiday | `success:false`, reason quoted |
| 4 | Booking at 06:00 | `success:false`, outside hours |
| 5 | Two calls for the same slot | first succeeds, second fails with 3 alternatives |
| 6 | `bays_available = 1` | second overlapping slot refused |
| 7 | `bays_available = 2` | second overlapping slot accepted |
| 8 | Full-day major service | whole working day blocked |
| 9 | Unknown add-on id | quote still works, unknown id ignored with note |
| 10 | Invalid phone `12345` | `success:false`, asks for number again |
| 11 | Returning customer | greeted by name, vehicle confirmed |

### 3. No-code-change proofs

- Add `Headlight globe replacement` to `Products_Addons` -> `list_services` shows it and
  a booking can include it, with zero code/prompt change.
- Change `Minor Service.price_from` and `Working_Hours[Monday].open` -> the next
  `get_price_quote` and `check_availability` reflect both.

### 4. Live call scenarios

| Scenario | Expected |
|---|---|
| New customer books a minor service | Correct service, add-on offer, 3 slots, readback, booking written to Sheet + Calendar |
| Returning customer reschedules | Named greeting, correct booking found, new slot, old event updated |
| Price enquiry then cancel | Quote given from sheet, existing booking cancelled, event removed |

## Results

_To be filled in Phase 6._
