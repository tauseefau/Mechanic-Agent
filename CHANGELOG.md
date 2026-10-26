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

## [Unreleased]
- Phase 1 Google Sheet
- Phase 2 Google Calendar
- Phase 3 Apps Script API
- Phase 4 ElevenLabs voice
- Phase 5 Vapi assistant
- Phase 6 Testing
- Phase 7 Replicability audit
