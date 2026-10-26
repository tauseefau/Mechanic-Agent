# Changelog

All phases of this project are recorded here. Format: date, phase, what landed.

## [0.1.0] - 2026-10-26 — Phase 0: Repository + docs

### Added
- Repository skeleton: `docs/`, `sheet/`, `apps-script/`, `vapi/`, `elevenlabs/`,
  `scripts/`, `tests/`.
- `README.md` with mermaid architecture diagram, repo map, quick start, prerequisites.
- `docs/architecture.md`, `docs/setup-guide.md`, `docs/owner-guide.md`,
  `docs/call-flow.md`, `docs/decisions.md`, `docs/testing.md`,
  `docs/limitations-and-next-steps.md`.
- `.env.example` covering every workshop-specific value; `.gitignore` blocking
  `.env`, `.clasprc.json`, credentials and personal-data exports.
- Design decision log seeded with 12 defaults (GST-inclusive pricing, 2 bays,
  30-minute grid, 4-hour lead time, 60-day horizon, token auth, sheet-as-CRM, ...).

### Notes
- GitHub repository creation was blocked in this session (no API token; `gh` not
  authenticated; Bitwarden vault locked). The repo exists locally with an SSH remote
  configured — `git push -u origin main` publishes it once the private repo is created.

## [0.2.0] - 2026-10-26 — Phase 1: Google Sheet

### Added
- Live spreadsheet **Workshop Voice Agent** (10 tabs) built and verified:
  <https://docs.google.com/spreadsheets/d/1SW46eWRWEg2hgJDbZ9-pEEozVFiodCHQSvWQOed9RZE/edit>
- `sheet/create_sheet.gs` — full Apps Script builder (tabs, styling, validation, seed,
  README tab, idempotent re-run).
- `scripts/build-sheet.py` — same build via the Sheets API, reads `sheet/seed/*.csv`.
- `sheet/seed/*.csv` — config, working hours, closures, services, add-ons, and clearly
  marked SAMPLE customers/vehicles (no real data).
- `sheet/schema.md` — authoritative column/validation reference.

### Fixed
- Seed rows are clamped to the schema width, and values starting with `+ = - @` are
  text-guarded so E.164 phone numbers keep their leading `+` (USER_ENTERED would
  otherwise eat it as a formula).
- Tab grid width trimmed to the schema instead of the default 26 columns.

## [0.3.0] - 2026-10-26 — Phase 2: Google Calendar

### Added
- Dedicated calendar **Workshop Bookings** (Australia/Melbourne), ID
  `61bc2e3d...@group.calendar.google.com`, written to `Config.calendar_id` and `.env`.
- `scripts/create-calendar.py` — idempotent create/adopt + write-access proof + Config
  and `.env` patching, so a new workshop gets the same calendar from one command.
- `calendar/calendar-config.json` — recorded calendar state and the event title /
  description template.
- `docs/architecture.md`: authoritative availability algorithm (duration, full-day,
  slot grid, lead time, weekday hours, lunch, holidays, capacity vs bays, buffer
  rule, dual occupancy sources, ranking) and calendar conventions.

### Verified
- Calendar exists with the right name and timezone; write access proven by creating
  and deleting a test event (0 events remain); Config!B12 and `.env` both carry the ID.

## [0.4.0] - 2026-10-26 — Phase 3: Apps Script API

### Added
- `apps-script/src/` — seven modules: `util`, `config`, `availability`, `customers`,
  `bookings`, `logging`, `api`. All nine actions: `get_workshop_info`, `list_services`,
  `get_price_quote`, `lookup_customer`, `check_availability`, `create_booking`,
  `reschedule_booking`, `cancel_booking`, `log_call_summary` (+ `ping`).
- Every response carries a speech-friendly `message`; every call is written to
  `Call_Log` with request/response JSON and an outcome.
- `LockService` around every booking write, with slot re-validation inside the lock and
  alternatives returned on a lost race.
- `tests/harness/gas.js` — Apps Script shim (SpreadsheetApp, CalendarApp, LockService,
  PropertiesService, ContentService, Utilities) so production code runs under Node.
- `tests/api-tests.js` — 39 tests through the real `doPost`/`doGet` path, plus a
  `--live` mode that runs the same suite against a deployment.
- `apps-script/DEPLOY.md` — clasp and web-editor paths, script properties, the
  token-in-body explanation, and a response-interpretation table.

### Fixed
- ISO timestamps now include the workshop UTC offset (D-017).
- A start time before opening is rejected instead of being silently snapped to opening.
- Shared token is read from the JSON body / query string, because Apps Script does not
  expose request headers (D-016).

### Verified
- `node tests/api-tests.js` → 39/39 pass.

## [0.5.0] - 2026-10-26 — Phase 4: ElevenLabs voice

### Added
- `elevenlabs/voice-settings.json` — chosen voice (Charlie, Australian male,
  `IKne3meq5aSn9XLyUdCD`), model `eleven_flash_v2_5`, tuning with per-setting rationale,
  five-voice shortlist with measured render latency, Vapi mapping block, and the
  documented swap path to Alice/Ava.
- `elevenlabs/samples/*.mp3` — five voices reading the same 19-second script
  (greeting, minor-service quote, three slot options) for a like-for-like listen.

### Changed
- `Config.greeting_name_for_agent` = `Charlie` (was `Ava`) so the agent's name matches
  the voice; mirrored in `sheet/seed/config.csv` and `sheet/create_sheet.gs`.

### Verified
- All five renders HTTP 200; Charlie fastest at 1,055 ms for 19.5 s of audio.

## [0.6.0] - 2026-10-26 — Phase 3b: live HTTPS endpoint on diyourdata.com

Apps Script deployment needs a browser consent in the workshop's Google account, so the
same backend is now served from the web host instead of blocking Phases 5-6.

### Added
- `server/gas-runtime.js` — `SpreadsheetApp` / `CalendarApp` / `LockService` /
  `PropertiesService` / `ContentService` / `Utilities.formatDate` over the Google REST
  APIs, with per-tab read caching (Config/catalogue 10 s, Customers/Vehicles 5 s,
  Bookings deliberately uncached), sheet-serial → `Date` coercion, and header-row caching.
- `server/http-sync.js` + `server/http-worker.js` — synchronous HTTPS with a worker thread
  and a pooled connection (Apps Script code is blocking; curl-per-call cost ~300 ms and
  a TLS handshake each time).
- `server/serve.js` — HTTP front for the unchanged modules; `/health` probe; per-request
  `vm` context; request logging.
- `deploy/deploy.sh`, `deploy/workshop-api.service`, `deploy/workshop-api/index.php` —
  rsync to `/opt/workshop-api`, `/etc/workshop-api.env` (0600), systemd unit, PHP bridge.
- `scripts/reset-data.js` — clears bookings/logs/test customers and deletes calendar
  events, for repeatable test runs.
- `tests/api-tests.js --pace <ms>` and `--live` pacing to stay inside Google's
  per-minute Sheets quota.

### Verified
- `https://diyyourdata.com/workshop-api/?health=1` → `ok:true`, workshop + timezone read
  live from the sheet.
- Token gate both ways over the public URL: valid → `pong`, missing → `unauthorised`.
- Latency: `ping` 70 ms, `list_services` 0.6 s, `check_availability` 1.2-1.6 s,
  `create_booking` ~2 s (all dominated by Google API round trips).
- `node tests/api-tests.js --live` → **39/39** when split with `--slice` (Google's Sheets
  quota is 60 reads/minute/user; a single 39-test sweep exceeds it by design).
- `--slice a:b` selector and a 2 s default pace for live runs.

### Fixed
- Header-row cache returned a flat array on a hit and a nested array on a miss, which
  broke `readTab_` on any single-row tab (Bookings before its first booking).
- Sheets returns date cells as serial numbers when read unformatted; without conversion
  `2026-12-25` never matched serial `46381` and **every holiday was ignored**.
- `getLastColumn()` forced a full-tab read on every logged request (~2 s per call on a
  growing Call_Log); the header read is now bounded to 40 columns.

## [0.7.0] - 2026-10-26 — Phase 5: Vapi assistant

### Added
- `vapi/system-prompt.md` — the full receptionist prompt (persona, caller-lookup-first,
  service clarification, add-on discipline, quote-with-range, slot offering, mandatory
  rego/phone/date readback, booking confirmation, reschedule/cancel, hours, after-hours,
  transfer triggers, prohibitions, sign-off). Workshop-specific values are `{{PLACEHOLDER}}`s.
- `vapi/tools/*.json` — nine function tools, one file each, with JSON-Schema parameters,
  a 20 s server timeout and a spoken "one moment" filler on the slow ones.
- `vapi/assistant.json` — the sanitised template (model, voice, transcriber, call controls,
  analysis plan, end-call phrases, server URL).
- `vapi/create-assistant.js` — resolves placeholders from `.env` **and the live Config tab**,
  merges the tools, then creates/patches the assistant and optionally attaches or creates a
  number. `--dump` prints the payload without calling Vapi.
- `vapi/assistant.export.json` — the live assistant as exported and sanitised (token and IDs
  replaced; asserted token-free before writing).
- `handleVapi_` in `apps-script/src/api.js` — maps Vapi's `tool-calls` envelope onto the
  existing actions and logs `end-of-call-report` to `Call_Log`; also handles `status-update`.
- Four new tests for the Vapi envelope (harness 43/43, live 8/8).

### Fixed
- Placeholder substitution was running on `JSON.stringify` output, so the prompt's real
  newlines landed inside a JSON string and the payload would not parse. Substitution now
  walks the object.
- `voicemailDetection: {enabled:false}` is rejected by the API; the field is omitted.
- PHP bridge dropped the query string on POST, which would have 401'd every Vapi tool call
  (the token travels as `?token=`).

### Blocked
- No additional phone number: Vapi requires a card on file. Verified `POST /call/web`
  instead, which returns a browser call room for spoken testing.

## [0.8.0] - 2026-10-26 — Phase 6: testing

### Added
- `tests/phase6-proofs.js` — the three owner-edit proofs run against the live sheet and
  the live endpoint, then reverted: new add-on row, changed service price, changed Monday
  opening time. 8/8 assertions; each edit visible through the API without a deploy.
- `tests/phase6-conversations.js` — three unscripted calls driven through the deployed
  prompt and the nine real tools at `https://diyyourdata.com/workshop-api/`, with an LLM
  caller on a fixed persona. 23/23 assertions; every tool call, sheet write and calendar
  write is verified against ground truth afterwards.
- `tests/phase6-runs/*.json` — machine-readable transcript + assertion record per scenario.
- `vapi/export-assistant.js` — regenerate the sanitised live-assistant export; refuses to
  write if a secret survives. The export is now reproducible instead of hand-copied.
- `tests/api-tests.js` — a test that fails if the shared token is ever written to
  `Call_Log`.
- `tests/scenarios/*.md` — real transcripts and outcomes replace the placeholders.

### Fixed
- **The prompt had no current date and no caller number.** The agent computed 2023 dates
  (so every availability check failed) and called `lookup_customer` with an invented
  number. The prompt now carries Vapi Liquid `{{ "now" | date: ... }}` and
  `{{customer.number}}`.
- **A reschedule created a second booking.** `create_booking` now returns
  `duplicate_booking` with the existing reference when the same customer + rego already
  has a confirmed booking for that service, and the prompt forbids using it to move one.
- **Prices were quoted from `list_services`**, whose range ignores add-ons. Its tool
  description now marks those ranges as orientation only; `get_price_quote` is the only
  source for a spoken figure.
- **`log_call_summary` was never called** — the tool existed but the prompt never asked
  for it, so `Call_Log` had tool traffic and no summary. Now a hard rule at the end of the
  prompt.
- **The shared token was stored in every `Call_Log` row.** `logCall_` strips the `token`
  key before writing.
- The live Vapi assistant was rebuilt from the repo (`c936ac26-…c1d3`), so the deployed
  prompt and the committed prompt are the same 7,494 characters.

### Verified
- Harness `node tests/api-tests.js` **44/44**; live endpoint **44/44** in two quota-safe
  slices; owner-edit proofs **8/8**; conversations **23/23**.

### Not verified
- The audio path: Vapi refuses a new phone number without a card on file, so ASR/TTS,
  barge-in and real latency remain untested (see `docs/testing.md`).

## [Unreleased]
- Phase 7 Replicability audit
