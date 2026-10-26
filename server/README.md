# Running the backend outside Apps Script

`apps-script/` is the canonical backend. Google Apps Script web apps can only be
deployed through an interactive browser consent inside the owner's Google account, which
cannot be automated from a server. This directory closes that gap: it runs the *same*
`apps-script/src/*.js` modules behind a normal HTTPS URL.

```
Vapi -> https://diyyourdata.com/workshop-api/  (public)
          -> PHP bridge  (deploy/workshop-api/index.php, no logic)
             -> Node service 127.0.0.1:8790  (server/serve.js)
                -> vm sandbox with Apps Script globals  (server/gas-runtime.js)
                   -> Google Sheets API + Calendar API (OAuth refresh token on disk)
-> the same doPost router that apps-script/DEPLOY.md deploys
```

## Why the business logic is not duplicated

`server/gas-runtime.js` implements `SpreadsheetApp`, `CalendarApp`, `LockService`,
`PropertiesService`, `ContentService` and `Utilities.formatDate` on top of the Google
REST APIs, then `server/serve.js` compiles the unchanged `apps-script/src/*.js` into a
fresh `vm` context per request. One set of rules, two deployment targets — the same
tests (`node tests/api-tests.js`) cover both, and `--live` points at either URL.

Every Google call is synchronous (`curl` via `execFileSync`) because the Apps Script
code is synchronous. That costs ~15-30 ms per round trip; a `create_booking` is ~10
calls, so ~300 ms of overhead, well inside a voice agent's tolerance.

## Differences from the Apps Script target

| Concern | Apps Script | This runtime |
|---|---|---|
| Request isolation | new execution per request | new `vm` context per request (caches reset, same as Apps Script) |
| Lock scope | `LockService` script lock | single Node process; handlers are synchronous so writes cannot interleave. `LockService` is still called, and is the hook for a multi-process future |
| Timezone | `Utilities.formatDate` | identical implementation, shared with the test harness |
| Cold start | 0.5-1.5 s | ~40 ms |
| Secrets | Script Properties | `/etc/workshop-api.env` (0600) |

## Operate

```bash
systemctl status workshop-api
journalctl -u workshop-api -n 50 --no-pager
curl 'https://diyyourdata.com/workshop-api/?health=1'
```
