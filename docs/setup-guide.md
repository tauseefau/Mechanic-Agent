# Setup guide — replicating for a new workshop

Follow top to bottom. Steps marked **MANUAL** need a human in a browser; everything
else is scripted from this repo.

Estimated time: 60-90 minutes for a first setup.

---

## 0. Prerequisites

- Google account that will own the Sheet + Calendar (the workshop's, not yours).
- Node.js 18+, `npm i -g @google/clasp`
- Vapi account + API key, ElevenLabs account + API key
- `git`

## 1. Clone and configure (scripted)

```bash
git clone git@github.com:tauseefau/workshop-voice-agent.git
cd workshop-voice-agent
cp .env.example .env
$EDITOR .env          # fill every value you already know; leave IDs blank for now
```

## 2. Create the spreadsheet (**MANUAL**, 5 min)

Either path produces an identical sheet. Pick one.

**2a. From a terminal (recommended, fully scripted)**

```bash
python3 scripts/build-sheet.py            # creates the spreadsheet and fills every tab
```

It prints the spreadsheet ID and writes `SHEET_ID=` into `.env`. It reuses the Hermes
Google OAuth token (`~/.hermes/google_token.json`); pass `HERMES_GOOGLE_TOKEN=/path`
to override. Re-run with `--sheet-id <ID>` to rebuild the tabs of an existing sheet.

**2b. From the browser (Apps Script editor)**

1. <https://sheets.new> -> name it `Workshop Voice Agent`.
2. Extensions -> Apps Script. This binds a script project to the sheet.
3. In the editor, replace `Code.gs` with the contents of `sheet/create_sheet.gs`.
4. Run `createWorkshopSheet` once. Authorise when prompted.
5. Copy the spreadsheet ID from the URL (`/spreadsheets/d/<ID>/edit`) into `.env`
   as `SHEET_ID`.

Verify: 10 tabs exist (Config, Working_Hours, Holidays_Closures, Services,
Products_Addons, Customers, Vehicles, Bookings, Call_Log, README) with frozen headers.

## 3. Create the calendar (**scripted**, 1 min)

```bash
python3 scripts/create-calendar.py
```

Creates (or adopts) the `Workshop Bookings` calendar, proves write access, writes
`calendar/calendar-config.json`, and patches `Config.calendar_id` + `.env`.
Then, if the mechanic uses a different Google login, share the calendar with them as
*Make changes to events* (MANUAL).

The manual equivalent, if you prefer the UI:

1. Google Calendar -> *Create new calendar* -> name `Workshop Bookings`, timezone
   `Australia/Melbourne`.
2. Settings -> *Integrate calendar* -> copy **Calendar ID** (looks like
   `abc123@group.calendar.google.com`).
3. Put it in the `Config` tab as `calendar_id` **and** in `.env` as `CALENDAR_ID`.
4. Optional but recommended: share it with the mechanic's personal account as
   *Make changes to events*.

## 4. Point the backend at the sheet (**MANUAL**, 3 min)

In the same Apps Script project:

1. Project Settings -> *Show appsscript.json* -> paste `apps-script/appsscript.json`.
2. Create the source files: `apps-script/src/*.js` — one file per module (see
   `apps-script/DEPLOY.md` for the file list and the `clasp` alternative).
3. Project Settings -> *Script Properties* -> add `SHARED_TOKEN` = a long random
   string (`openssl rand -hex 32`). Copy the same value into `.env` as
   `APPS_SCRIPT_SHARED_TOKEN`.
4. Deploy -> *New deployment* -> type **Web app** ->
   *Execute as*: **Me**, *Who has access*: **Anyone** ->
   Deploy, authorise, copy the `/exec` URL into `.env` as `APPS_SCRIPT_WEBAPP_URL`.

Verify with curl:

```bash
curl -s -X POST "$APPS_SCRIPT_WEBAPP_URL" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: $APPS_SCRIPT_SHARED_TOKEN" \
  -d '{"action":"get_workshop_info"}'
```

Expect `{"success":true,...}`. Without the header expect `success:false`.

## 5. ElevenLabs voice (**scripted**, 2 min)

`elevenlabs/voice-settings.json` already records the chosen voice ID and tuning.
Either reuse that voice (it is on the account tied to `ELEVENLABS_API_KEY`) or pick a
new one from the shortlist in the same file and update the ID.

## 6. Vapi assistant + phone number (**scripted**, 5 min)

```bash
npm i                      # installs nothing heavy; script uses fetch
node vapi/create-assistant.js
```

The script reads `vapi/assistant.json` + `vapi/tools/*.json`, substitutes the
placeholders (`{{APPS_SCRIPT_WEBAPP_URL}}`, `{{SHARED_TOKEN}}`, ...) from the
environment, creates the assistant, imports the tools, and attaches
`VAPI_PHONE_NUMBER_ID`. It prints the assistant ID.

## 7. Smoke test (**scripted**)

```bash
node tests/api-tests.js
```

Expected: all actions pass; `docs/testing.md` records the current run.

## 8. Hand over to the owner

Print `docs/owner-guide.md` and tell them the only file they ever touch is the
spreadsheet.

---

## Fresh-start checklist

| Step | Manual or scripted |
|---|---|
| Create Google Cloud / Apps Script project | MANUAL |
| OAuth consent screen (only if using `clasp` with your own GCP project) | MANUAL |
| Create spreadsheet + tabs | scripted (`sheet/create_sheet.gs`) after MANUAL "open Apps Script" |
| Create calendar | MANUAL |
| Set script property `SHARED_TOKEN` | MANUAL (or `clasp run` helper) |
| Deploy web app as "Execute as me / Anyone" | MANUAL |
| Create Vapi assistant + tools | scripted (`vapi/create-assistant.js`) |
| Buy/import a phone number, attach to assistant | MANUAL if buying; scripted once `VAPI_PHONE_NUMBER_ID` exists |
| Voice select/tune | scripted once a voice ID is chosen |
| Seed test data | scripted (`scripts/seed-test-data.sh`) |
| API tests | scripted (`tests/api-tests.js`) |

## Common setup failures

| Symptom | Cause | Fix |
|---|---|---|
| `success:false, message:"unauthorised"` | token mismatch | same value in Script Properties and `.env` |
| `HtmlService: no permission` in response | web app deployed *Execute as: user accessing* | redeploy as *Execute as: me* |
| Calendar not found | wrong calendar ID or not shared | re-copy the ID-ending `@group.calendar.google.com` |
| `clasp push` 401 | not logged in | `clasp login` |
| Vapi tool returns 302 | Google redirect on unpublished deployment | use `/exec`, not `/dev`, and never a `ContentService` redirect |
