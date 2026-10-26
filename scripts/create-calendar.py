#!/usr/bin/env python3
"""
scripts/create-calendar.py — create (or adopt) the dedicated "Workshop Bookings"
Google Calendar, wire its ID into the Config tab and .env, and prove write access.

Idempotent: if a calendar with the configured summary already exists in the account's
calendar list, it is adopted instead of duplicated.

Usage
    python3 scripts/create-calendar.py
    python3 scripts/create-calendar.py --name "Workshop Bookings" --timezone Australia/Melbourne
    python3 scripts/create-calendar.py --sheet-id <ID>      # Config tab to patch

Auth: Hermes Google OAuth token (~/.hermes/google_token.json), needs `calendar` and
`spreadsheets` scopes.
"""
import argparse
import json
import os
import pathlib
import re
import sys
from datetime import datetime, timedelta, timezone as dtz

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKEN = pathlib.Path(os.environ.get("HERMES_GOOGLE_TOKEN", pathlib.Path.home() / ".hermes" / "google_token.json"))
CONFIG_DOC = ROOT / "calendar" / "calendar-config.json"


def creds():
    if not TOKEN.exists():
        sys.exit(f"No Google token at {TOKEN}")
    c = Credentials.from_authorized_user_file(str(TOKEN))
    if c.expired and c.refresh_token:
        c.refresh(Request())
        TOKEN.write_text(c.to_json())
    return c


def find_calendar(svc, summary):
    page = None
    while True:
        res = svc.calendarList().list(pageToken=page, maxResults=250).execute()
        for item in res.get("items", []):
            if item.get("summary") == summary:
                return item
        page = res.get("nextPageToken")
        if not page:
            return None


def ensure_calendar(svc, summary, tz):
    found = find_calendar(svc, summary)
    if found:
        print(f"adopted existing calendar: {found['id']}")
        return found["id"], False
    body = {"summary": summary, "timeZone": tz, "description": "Bookings made by the AI phone receptionist. Managed by the Workshop Voice Agent."}
    created = svc.calendars().insert(body=body).execute()
    print(f"created calendar: {created['id']}")
    svc.calendarList().insert(body={"id": created["id"]}).execute()
    return created["id"], True


def verify_write(svc, cal_id):
    """Create and immediately delete an event so 'it exists' is not mistaken for 'can write'."""
    now = datetime.now(dtz.utc)
    body = {
        "summary": "Workshop Voice Agent — deployment check (safe to ignore)",
        "description": "Created by scripts/create-calendar.py to verify write access. Deleted immediately.",
        "start": {"dateTime": (now + timedelta(days=2)).isoformat(), "timeZone": "Australia/Melbourne"},
        "end": {"dateTime": (now + timedelta(days=2, minutes=15)).isoformat(), "timeZone": "Australia/Melbourne"},
    }
    ev = svc.events().insert(calendarId=cal_id, body=body).execute()
    svc.events().delete(calendarId=cal_id, eventId=ev["id"]).execute()
    return ev["id"]


def patch_config_tab(cal_id, sheet_id, tz):
    s = build("sheets", "v4", credentials=creds(), cache_discovery=False)
    vals = s.spreadsheets().values().get(spreadsheetId=sheet_id, range="Config!A2:B200").execute().get("values", [])
    row = next((i for i, r in enumerate(vals, start=2) if r and r[0] == "calendar_id"), None)
    if row is None:
        print("warning: no calendar_id row in Config — add one by hand", file=sys.stderr)
        return False
    s.spreadsheets().values().update(
        spreadsheetId=sheet_id,
        range=f"Config!B{row}",
        valueInputOption="RAW",
        body={"values": [[cal_id]]},
    ).execute()
    print(f"patched Config!B{row} = {cal_id}")
    return True


def patch_env(cal_id):
    env = ROOT / ".env"
    if not env.exists():
        print("warning: no .env — skipping", file=sys.stderr)
        return
    txt = env.read_text()
    if re.search(r"^CALENDAR_ID=", txt, re.M):
        txt = re.sub(r"^CALENDAR_ID=.*$", f'CALENDAR_ID="{cal_id}"', txt, flags=re.M)
    else:
        txt += f'\nCALENDAR_ID="{cal_id}"\n'
    env.write_text(txt)
    print("wrote CALENDAR_ID into .env")


def write_config_doc(cal_id, summary, tz):
    CONFIG_DOC.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "_comment": "Recorded state of the dedicated booking calendar. The live ID is in Sheet Config.calendar_id and .env CALENDAR_ID.",
        "summary": summary,
        "time_zone": tz,
        "calendar_id": cal_id,
        "event_template": {
            "summary": "[Service] - [Customer] - [Rego]",
            "description": "Phone: [phone]\nVehicle: [year] [make] [model] ([rego])\nAdd-ons: [addon names or 'none']\nEstimated price: $[low] - $[high] (GST inclusive)\nBooking ID: [booking_id]\nBooked by: AI receptionist",
            "start": "booking start_datetime in workshop timezone",
            "end": "booking end_datetime in workshop timezone",
            "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 60}]},
            "transparency": "opaque",
        },
        "settings": {
            "timezone": tz,
            "week_start": "monday",
            "default_reminders": "disabled (events carry their own reminder)",
        },
        "access": {
            "owner": "the deploying Google account",
            "sharing": "share with the mechanic's personal account as 'Make changes to events' if they use a different login",
        },
    }
    CONFIG_DOC.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {CONFIG_DOC.relative_to(ROOT)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="Workshop Bookings")
    ap.add_argument("--timezone", default="Australia/Melbourne")
    ap.add_argument("--sheet-id", default=os.environ.get("SHEET_ID", "").strip('"'))
    ap.add_argument("--skip-verify", action="store_true")
    args = ap.parse_args()

    svc = build("calendar", "v3", credentials=creds(), cache_discovery=False)
    cal_id, _created = ensure_calendar(svc, args.name, args.timezone)

    if not args.skip_verify:
        ev = verify_write(svc, cal_id)
        print(f"write access verified (created and deleted test event {ev[:12]}...)")

    write_config_doc(cal_id, args.name, args.timezone)
    patch_env(cal_id)

    if not args.sheet_id:
        env = ROOT / ".env"
        if env.exists():
            m = re.search(r'^SHEET_ID="?([A-Za-z0-9_-]+)"?$', env.read_text(), re.M)
            args.sheet_id = m.group(1) if m else ""
    if args.sheet_id:
        patch_config_tab(cal_id, args.sheet_id, args.timezone)
    else:
        print("warning: no sheet id; set Config.calendar_id by hand", file=sys.stderr)

    print(json.dumps({"calendar_id": cal_id, "summary": args.name}, indent=2))


if __name__ == "__main__":
    main()
