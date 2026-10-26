# Design decision log

Newest first. Every default chosen without asking the user is recorded here.

## D-012 Prices include GST by default
`gst_percent = 10`, `prices_include_gst = TRUE`. Australian retail expectation for a
consumer-facing service quote; the agent quotes the number on the sticker. Flip the
flag to quote ex-GST with a spoken note.

## D-011 Two bays, 30-minute grid, 4-hour lead time, 60-day horizon
`bays_available = 2`, `slot_granularity_minutes = 30`, `booking_lead_time_hours = 4`,
`max_days_ahead = 60`, `buffer_minutes_between_jobs = 15`. A two-bay suburban
workshop with same-morning fill being realistic but not instant. All owner-editable.

## D-010 Shared-secret auth via `X-Auth-Token`, not Google OAuth
The web app is *Execute as me / Anyone*, so it is publicly reachable. A shared token
in the header (or `token` body/query param for GET) is the gate. Simpler than OAuth
for a server-to-server caller, and revocable by rotating one Script Property.

Reason a URL-only web app is acceptable: no personal data is returned without the
token, and the token is high-entropy (32 bytes hex).

## D-009 Sheet as the CRM, not a separate database
One spreadsheet holds Config, catalogue, customers, vehicles, bookings and logs. The
owner can edit and read everything, and Apps Script gets it for free. Scaling limit is
~10k bookings, well beyond a single workshop.

## D-008 Calendar is authoritative for human visibility, Sheet is authoritative for logic
Bookings are written to the Sheet first, then mirrored to Calendar. If Calendar fails,
the booking stands and `notes` records `calendar_sync_failed`. Availability checks
count **both** Sheet bookings and live Calendar events, so an event added by hand still
blocks the slot.

## D-007 Vapi US number now, local AU number later
A free US number keeps Phase 5 at zero cost. Importing an Australian geographic number
via Twilio/Telnyx into Vapi is a documented next step and needs no assistant change.

## D-006 One Apps Script deployment for all actions
Single `doPost` router keyed on `action`. Fewer deployments, one token, one log. The
cost is a slightly larger file; modules are kept in separate `.js` files in
`apps-script/src/`.

## D-005 Speech-friendly `message` on every response
Every payload carries `message`, a full sentence the agent can say verbatim. This keeps
the LLM from paraphrasing numbers and times wrongly, and makes failures speakable.

## D-004 `LockService` around the whole booking write
Slot re-validation + customer upsert + booking append + calendar create all happen
inside `getScriptLock()` with a 30 s timeout, so two concurrent calls cannot double-book
the same slot.

## D-003 Phone as the customer key, normalised to E.164
Caller ID arrives as `+61412345678`. Normalisation strips spaces/dashes and assumes
`+61` for local `04...` numbers (AU default; configurable in `Config.phone_country_code`).

## D-002 ElevenLabs Flash-class model for latency
Phone calls need sub-second first audio. A Flash/Turbo model plus stability ~0.45 and
speed ~1.0 is the chosen starting point; recorded in `elevenlabs/voice-settings.json`.

## D-001 Everything workshop-specific lives in `Config` + catalogue tabs
No business value appears in JS or in the prompt. The prompt contains only behaviour
and `{{PLACEHOLDER}}`s resolved at build time. A new workshop is a config change.
