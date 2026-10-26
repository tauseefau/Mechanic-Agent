# Deploying the Apps Script backend

_Phase 3 deliverable — the module list and deploy steps are finalised there._

Two supported paths: **clasp** (recommended, scriptable) or the **web editor**
(no tooling).

## Path A — clasp

```bash
npm i -g @google/clasp
clasp login
cd apps-script
cp .clasp.json.example .clasp.json && $EDITOR .clasp.json   # paste scriptId
clasp push
clasp deploy --description "v1"
```

With clasp the manifest is `appsscript.json`; keep `webapp.executeAs =
USER_DEPLOYING` and `webapp.access = ANYONE_ANONYMOUS`.

## Path B — web editor

1. Spreadsheet -> Extensions -> Apps Script.
2. Project Settings -> tick *Show `appsscript.json` manifest file*, paste
   `apps-script/appsscript.json`.
3. Create one file per module in `src/` (same filenames).
4. Deploy -> New deployment -> Web app -> Execute as **Me**, access **Anyone**.
5. Copy the `/exec` URL.

## Permissions needed

| Scope | Why |
|---|---|
| `spreadsheets` | read config/catalogue, write bookings + log |
| `calendar` | create/update/delete booking events |
| `script.external_request` | outbound HTTP (none today, reserved for SMS) |
| `script.scriptapp` | script properties / triggers |

The deploying account must own (or have edit access to) both the Sheet and the
`Workshop Bookings` calendar.

## Script properties

| Property | Purpose |
|---|---|
| `SHARED_TOKEN` | shared secret; must match `APPS_SCRIPT_SHARED_TOKEN` in `.env` |
| `SHEET_ID` | optional override; defaults to the bound spreadsheet |

## Post-deploy checks

```bash
curl -s -X POST "$APPS_SCRIPT_WEBAPP_URL" -H "Content-Type: application/json" \
  -H "X-Auth-Token: $APPS_SCRIPT_SHARED_TOKEN" \
  -d '{"action":"get_workshop_info"}'
```

- 200 + `success:true` -> good.
- 200 + `success:false, message:"unauthorised"` -> token mismatch.
- 302 to `googleusercontent.com` -> you used `/dev` or a non-deployed URL.
