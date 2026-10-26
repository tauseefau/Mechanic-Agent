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

## [Unreleased]
- Phase 5 Vapi assistant
- Phase 5 Vapi assistant
- Phase 6 Testing
- Phase 7 Replicability audit
