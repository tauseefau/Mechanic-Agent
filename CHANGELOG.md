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

## [Unreleased]
- Phase 2 Google Calendar
- Phase 3 Apps Script API
- Phase 4 ElevenLabs voice
- Phase 5 Vapi assistant
- Phase 6 Testing
- Phase 7 Replicability audit
