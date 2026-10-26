# Workshop Voice Agent

An end-to-end AI phone receptionist for a car mechanic workshop. Customers call a
phone number, a voice agent answers, quotes services from a Google Sheet, and books
servicing into Google Calendar. No code changes are required for the owner to change
prices, hours, services, products or holidays.

## Architecture

```mermaid
flowchart LR
    A[Caller] -->|PSTN| B[Vapi phone number<br/>US free number]
    B --> C[Vapi assistant<br/>ElevenLabs voice + fast LLM]
    C -->|HTTPS POST JSON<br/>X-Auth-Token| D[Apps Script web app<br/>doPost router]
    D --> E[(Google Sheet<br/>Workshop Voice Agent)]
    D --> F[(Google Calendar<br/>Workshop Bookings)]
    C -.->|end-of-call webhook| D
    E --> G[Config / Services / Products<br/>Working_Hours / Holidays]
    E --> H[Customers / Vehicles / Bookings]
    D --> I[Call_Log]
```

Everything the agent says about the business is read live from the Sheet. The agent
never invents prices, hours or availability.

## Repository map

| Path | What it is |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components, data flow, decision rationale |
| [docs/setup-guide.md](docs/setup-guide.md) | Replicate for a NEW workshop, start to finish |
| [docs/owner-guide.md](docs/owner-guide.md) | Non-technical guide for the mechanic |
| [docs/call-flow.md](docs/call-flow.md) | Conversation design, edge cases, escalation |
| [docs/decisions.md](docs/decisions.md) | Design decision log (incl. defaults chosen) |
| [docs/testing.md](docs/testing.md) | Test plan and latest results |
| [docs/limitations-and-next-steps.md](docs/limitations-and-next-steps.md) | Known limits, roadmap |
| [sheet/schema.md](sheet/schema.md) | Every tab, column, type, validation rule |
| [sheet/create_sheet.gs](sheet/create_sheet.gs) | Builds the whole spreadsheet from scratch (browser / Apps Script) |
| [scripts/build-sheet.py](scripts/build-sheet.py) | Same build from a terminal via the Sheets API |
| [calendar/calendar-config.json](calendar/calendar-config.json) | Recorded calendar state + event template |
| [apps-script/DEPLOY.md](apps-script/DEPLOY.md) | Deploying the web app with clasp |
| [server/README.md](server/README.md) | Running the same backend as a self-hosted service |
| [deploy/deploy.sh](deploy/deploy.sh) | One-command deploy to `/workshop-api/` |
| [tests/api-tests.js](tests/api-tests.js) | All-action test suite (harness + `--live`) |
| [tests/phase6-proofs.js](tests/phase6-proofs.js) | Owner-edit proofs: add-on, price, hours — live, then reverted |
| [tests/phase6-conversations.js](tests/phase6-conversations.js) | Three unscripted calls through the deployed prompt + live tools |
| [tests/scenarios/](tests/scenarios) | The three call scenarios, with real transcripts |
| [vapi/export-assistant.js](vapi/export-assistant.js) | Re-export the live assistant, sanitised |
| [tests/harness/gas.js](tests/harness/gas.js) | Apps Script shim so tests run under Node |
| [vapi/system-prompt.md](vapi/system-prompt.md) | The assistant system prompt |
| [vapi/tools/](vapi/tools) | Nine function-tool definitions (one file each) |
| [vapi/create-assistant.js](vapi/create-assistant.js) | Rebuild the assistant from this repo |
| [vapi/assistant.export.json](vapi/assistant.export.json) | Live assistant, exported and sanitised |
| [vapi/assistant.json](vapi/assistant.json) | Sanitised exported assistant config |
| [elevenlabs/voice-settings.json](elevenlabs/voice-settings.json) | Voice choice, tuning, shortlist |
| [elevenlabs/samples/](elevenlabs/samples) | Five voices reading the same script |
| [sheet/seed/](sheet/seed) | Seed rows per tab (no real customer data) |
| [CHANGELOG.md](CHANGELOG.md) | Phase-by-phase history |

## Quick start (summary)

1. `cp .env.example .env` and fill in the values.
2. Run `sheet/create_sheet.gs` from the Apps Script editor bound to a new spreadsheet
   (or follow [sheet/schema.md](sheet/schema.md) manually). Put the spreadsheet ID in
   `Config.sheet_id`-adjacent env var.
3. Create the `Workshop Bookings` calendar and paste its ID into `Config.calendar_id`.
4. `clasp push` the Apps Script project, deploy as web app (*Execute as me*,
   *Anyone*), set the `SHARED_TOKEN` script property, copy the `/exec` URL.
5. `node vapi/create-assistant.js` to create the assistant and attach the phone number.
6. Run `tests/api-tests.js` against the web app URL.

## Prerequisites

- A Google account with Sheets + Calendar (and permission to deploy Apps Script).
- Node.js 18+ and `@google/clasp` (`npm i -g @google/clasp`).
- A Vapi account (phone number + API key).
- An ElevenLabs account (voice + API key).
- `git`.

## Configuration principle

Nothing business-specific is hardcoded. Workshop name, phone, address, timezone,
currency, GST, opening hours, services, add-ons, lead times, bay count and the calendar
ID all live in the **Config**, **Working_Hours**, **Holidays_Closures**, **Services**
and **Products_Addons** tabs. Code reads them at call time.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Repository skeleton + docs | done |
| 1 | Google Sheet | done (10 tabs, live) |
| 2 | Google Calendar + availability | done (`Workshop Bookings`, Australia/Melbourne) |
| 3 | Apps Script API + self-hosted runtime | done — same modules under Apps Script and systemd |
| 4 | ElevenLabs voice | done (Charlie, `eleven_flash_v2_5`) |
| 5 | Vapi assistant | done (`c936ac26-…c1d3`), **no phone number** — Vapi needs a card |
| 6 | Testing | done — 44/44 harness, 44/44 live, 8/8 owner-edit proofs, 23/23 conversations |
| 7 | Replicability audit | pending |

Known gap: there is no phone number attached, so the audio path (transcription → model →
ElevenLabs) is configured but has not been exercised end to end. Everything else is
verified against the live sheet, calendar and endpoint — see
[docs/testing.md](docs/testing.md).
