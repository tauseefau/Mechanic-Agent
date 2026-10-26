# Deploying the Apps Script backend

The backend is one Apps Script project with seven modules. It must be deployed in the
**workshop's own Google account**, because it writes to that account's spreadsheet and
calendar. That is the only reason deployment is manual: the OAuth consent and the
"Anyone" access choice are account-level decisions.

Estimated time: 6 minutes for a first deploy, 40 seconds for each update.

## The modules

Push all of `apps-script/src/*.js` plus `appsscript.json`. Order does not matter
(function declarations are hoisted), but the reference order is:

| File | Responsibility |
|---|---|
| `util.js` | sheet access, tab reading, timezone-safe date maths, phone normalisation, JSON output, money formatting |
| `config.js` | Config / Services / Products_Addons / Working_Hours / Holidays readers |
| `availability.js` | slot generation, capacity, lunch, closures, quote maths (read-only) |
| `customers.js` | phone-keyed customer and vehicle upsert, `lookup_customer` |
| `bookings.js` | `create_booking` / `reschedule_booking` / `cancel_booking`, LockService, calendar events |
| `logging.js` | `Call_Log` writers, `log_call_summary` |
| `api.js` | `doPost` / `doGet` router, token check, action map, error handling |

## Path A — clasp (recommended for updates)

```bash
npm install -g @google/clasp
clasp login                     # MANUAL: browser consent, paste the code back
cd apps-script
cp .clasp.json.example .clasp.json
$EDITOR .clasp.json             # scriptId from Project Settings, or:
                                # clasp create --type webapp --title "Workshop Voice Agent"
clasp push
clasp deploy --description "workshop-voice-agent $(date +%Y-%m-%d)"
```

`clasp login` needs a browser, so it cannot run headless — that is the one step a
person must do.

## Path B — web editor (no tooling)

1. Open the `Workshop Voice Agent` spreadsheet -> **Extensions -> Apps Script**.
   This creates a bound script, which is the simplest setup (no `SHEET_ID` property
   needed).
2. **Project Settings** -> tick *Show `appsscript.json` manifest file in editor*, then
   paste [`appsscript.json`](appsscript.json).
3. Create one file per module — `util`, `config`, `availability`, `customers`,
   `bookings`, `logging`, `api` — and paste the contents of the matching `src/*.js`.
4. **Project Settings -> Script Properties** -> add:

   | Property | Value |
   |---|---|
   | `SHARED_TOKEN` | a long random string — `openssl rand -hex 32` |
   | `SHEET_ID` | *optional*: only if the script is standalone, not sheet-bound |

5. **Deploy -> New deployment -> Web app**:
   - Description: `v1`
   - **Execute as: Me**
   - **Who has access: Anyone**
   - Deploy -> authorise -> copy the `/exec` URL into `.env` as
     `APPS_SCRIPT_WEBAPP_URL`.

## Why the token goes in the body, not a header

Apps Script web apps **do not expose request headers** — `doPost(e)` only gives you
`e.postData.contents` and `e.parameter`. An `X-Auth-Token` header would be silently
invisible to the script, and every request would fail as unauthorised.

So the token is accepted from, in order:

1. `token` in the JSON body (preferred — a Vapi tool body can carry it as a static field)
2. a `token` form or query parameter (`?token=...`)
3. an `X-Auth-Token` header, if a future runtime exposes headers

Requests without a valid token return `{"success":false,"error":"unauthorised"}` and are
logged to `Call_Log` with outcome `unauthorised`.

## Verify the deployment

```bash
TOKEN=$(grep '^APPS_SCRIPT_SHARED_TOKEN=' .env | cut -d= -f2- | tr -d '"')
URL=$(grep '^APPS_SCRIPT_WEBAPP_URL=' .env | cut -d= -f2- | tr -d '"')

curl -s -X POST "$URL" -H 'Content-Type: application/json' \
  -d "{\"action\":\"ping\",\"token\":\"$TOKEN\"}"
# {"success":true,"pong":true,"message":"ok"}

curl -s -X POST "$URL" -H 'Content-Type: application/json' -d '{"action":"ping"}'
# {"success":false,"error":"unauthorised",...}

node tests/api-tests.js --live     # full suite against the deployment
```

Interpretation:

| Response | Meaning |
|---|---|
| `{"success":true,...}` | good |
| `error: unauthorised`, `reason: no_token_configured` | `SHARED_TOKEN` script property missing |
| `error: unauthorised`, `reason: bad_token` | mismatch with `.env` |
| HTML / 302 to `googleusercontent.com` | you used the `/dev` URL or an undeployed version |
| `exception` mentioning a range or sheet | a tab name or header was renamed — check `sheet/schema.md` |

## After a redeploy

The `/exec` URL of the *current* deployment is stable across `clasp deploy`. If you
create a new deployment instead, update `APPS_SCRIPT_WEBAPP_URL` in `.env` and the tool
URLs in `vapi/tools/*.json`.

## Permissions needed

| Scope | Why |
|---|---|
| `spreadsheets` | read Config/catalogue, write bookings + log |
| `calendar` | create/update/delete booking events |
| `script.scriptapp` | script properties |
| `script.external_request` | reserved (SMS/email later) |

The deploying account must own, or have edit access to, both the spreadsheet and the
`Workshop Bookings` calendar.
