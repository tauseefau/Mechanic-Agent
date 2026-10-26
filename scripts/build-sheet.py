#!/usr/bin/env python3
"""
scripts/build-sheet.py — build the "Workshop Voice Agent" spreadsheet from scratch
without opening a browser.

This is the CLI twin of sheet/create_sheet.gs. Both implement sheet/schema.md and load
the same seed rows from sheet/seed/*.csv, so a new workshop can be stood up either
from the Apps Script editor (create_sheet.gs) or from a terminal (this script).

Usage
    python3 scripts/build-sheet.py            # create a new spreadsheet
    python3 scripts/build-sheet.py --sheet-id <ID>   # rebuild tabs in an existing one

Auth: reuses the Hermes Google OAuth token (~/.hermes/google_token.json). Override the
token path with HERMES_GOOGLE_TOKEN. Requires the `spreadsheets` scope.

Prints the spreadsheet ID and URL on success and writes them into .env when present.
"""
import argparse
import csv
import json
import os
import re
import sys
from pathlib import Path

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "sheet" / "seed"
TOKEN = Path(os.environ.get("HERMES_GOOGLE_TOKEN", Path.home() / ".hermes" / "google_token.json"))

HEADER_BG = {"red": 0.12, "green": 0.23, "blue": 0.37}
ACCENT = {
    "config": {"red": 0.85, "green": 0.55, "blue": 0.10},
    "catalogue": {"red": 0.11, "green": 0.45, "blue": 0.35},
    "data": {"red": 0.20, "green": 0.30, "blue": 0.55},
    "log": {"red": 0.35, "green": 0.35, "blue": 0.35},
}

# type tokens: text | number | money | date | datetime | bool | enum:a,b,c
TABS = [
    {
        "name": "Config",
        "group": "config",
        "seed": "config.csv",
        "cols": [("key", "text", 190), ("value", "text", 420), ("notes", "text", 480)],
    },
    {
        "name": "Working_Hours",
        "group": "config",
        "seed": "working_hours.csv",
        "cols": [
            ("day_of_week", "enum:Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday", 130),
            ("open", "text", 90),
            ("close", "text", 90),
            ("is_closed", "bool", 90),
            ("lunch_start", "text", 100),
            ("lunch_end", "text", 100),
        ],
    },
    {
        "name": "Holidays_Closures",
        "group": "config",
        "seed": "holidays_closures.csv",
        "cols": [
            ("date", "date", 110),
            ("reason", "text", 260),
            ("full_day", "bool", 90),
            ("open", "text", 90),
            ("close", "text", 90),
        ],
    },
    {
        "name": "Services",
        "group": "catalogue",
        "seed": "services.csv",
        "cols": [
            ("service_id", "text", 100),
            ("service_name", "text", 180),
            ("category", "enum:Servicing,Repairs,Inspection,Tyres,Electrical", 130),
            ("description", "text", 460),
            ("price_from", "money", 110),
            ("price_to", "money", 110),
            ("duration_minutes", "number", 130),
            ("requires_full_day", "bool", 120),
            ("active", "bool", 80),
            ("notes", "text", 300),
        ],
    },
    {
        "name": "Products_Addons",
        "group": "catalogue",
        "seed": "products_addons.csv",
        "cols": [
            ("item_id", "text", 100),
            ("item_name", "text", 200),
            ("category", "enum:Parts,Labour,Consumables,Electrical,Tyres", 130),
            ("price", "money", 100),
            ("extra_duration_minutes", "number", 150),
            ("applies_to_services", "text", 220),
            ("active", "bool", 80),
            ("notes", "text", 300),
        ],
    },
    {
        "name": "Customers",
        "group": "data",
        "seed": "customers.csv",
        "cols": [
            ("customer_id", "text", 110),
            ("full_name", "text", 200),
            ("phone", "text", 150),
            ("email", "text", 240),
            ("first_seen", "datetime", 150),
            ("last_contact", "datetime", 150),
            ("notes", "text", 380),
        ],
    },
    {
        "name": "Vehicles",
        "group": "data",
        "seed": "vehicles.csv",
        "cols": [
            ("vehicle_id", "text", 110),
            ("customer_id", "text", 110),
            ("rego", "text", 110),
            ("make", "text", 130),
            ("model", "text", 150),
            ("year", "number", 80),
            ("odometer", "number", 110),
            ("last_service_date", "date", 140),
            ("notes", "text", 320),
        ],
    },
    {
        "name": "Bookings",
        "group": "data",
        "seed": "bookings.csv",
        "cols": [
            ("booking_id", "text", 110),
            ("created_at", "datetime", 150),
            ("customer_id", "text", 110),
            ("vehicle_id", "text", 110),
            ("service_id", "text", 100),
            ("addons", "text", 160),
            ("start_datetime", "datetime", 150),
            ("end_datetime", "datetime", 150),
            ("estimated_price_low", "money", 150),
            ("estimated_price_high", "money", 150),
            ("status", "enum:Confirmed,Cancelled,Completed,No-show", 120),
            ("calendar_event_id", "text", 220),
            ("source", "enum:phone,walk-in,web,manual", 110),
            ("notes", "text", 320),
        ],
    },
    {
        "name": "Call_Log",
        "group": "log",
        "seed": "call_log.csv",
        "cols": [
            ("timestamp", "datetime", 150),
            ("call_id", "text", 200),
            ("caller_number", "text", 150),
            ("tool_called", "text", 160),
            ("request_json", "text", 420),
            ("response_json", "text", 420),
            ("outcome", "text", 140),
        ],
    },
    {"name": "README", "group": "config", "seed": None, "cols": [("A", "text", 900)]},
]

README_LINES = [
    "WORKSHOP VOICE AGENT — OWNER INSTRUCTIONS",
    "",
    "The AI receptionist reads every number it quotes from this spreadsheet. You never need to touch code.",
    "",
    "CHANGE OPENING HOURS",
    "  Open the Working_Hours tab. One row per weekday. Use 24-hour times, eg 08:00 and 17:30.",
    "  Set is_closed to TRUE to close a whole day. Leave lunch blank if you do not take a break.",
    "",
    "CHANGE A PRICE OR DURATION",
    "  Open the Services tab and edit price_from, price_to or duration_minutes.",
    "  The agent quotes a range when price_from and price_to differ. Set active to FALSE to hide a service.",
    "",
    "ADD A NEW PRODUCT OR ADD-ON",
    "  Open Products_Addons and add a row at the bottom. item_id must be unique. applies_to_services is a",
    "  semicolon list of service names, or blank for any service. extra_duration_minutes is added to the job length.",
    "  The agent picks it up on the next call — no code change, no restart.",
    "",
    "BLOCK A HOLIDAY OR A DAY OFF",
    "  Open Holidays_Closures and add a row: date as YYYY-MM-DD, a reason the agent can say aloud, and",
    "  full_day TRUE for a whole day off. For an early close set full_day FALSE and give open/close times.",
    "",
    "SEE YOUR BOOKINGS",
    "  Every booking also appears in the 'Workshop Bookings' Google Calendar with the customer, rego,",
    "  add-ons and estimated price in the event description. The Bookings tab is the same data in table form.",
    "  After the job, set status to Completed or No-show yourself.",
    "",
    "LOOK UP A CUSTOMER",
    "  The Customers tab is keyed by phone number in international format, eg +61412345678.",
    "  Vehicles are in the Vehicles tab using the same customer_id. The agent greets returning callers by name.",
    "",
    "WHAT THE AGENT WILL NEVER DO",
    "  It never quotes a price that is not in Services or Products_Addons.",
    "  It never books outside Working_Hours or on a Holidays_Closures date.",
    "  It never diagnoses a fault. For brakes failing, smoke, an accident or a breakdown it transfers the call",
    "  to transfer_phone_number in the Config tab.",
    "",
    "IF SOMETHING LOOKS WRONG",
    "  1. Check the Call_Log tab — every call and tool request is there with the exact response.",
    "  2. Check that the date is not blocked in Holidays_Closures.",
    "  3. If the agent says it cannot reach the booking system, the web app deployment needs attention.",
    "",
    "Full guide: docs/owner-guide.md in the Mechanic-Agent repository.",
]


def creds():
    if not TOKEN.exists():
        sys.exit(f"No Google token at {TOKEN}. Run the google-workspace setup first.")
    c = Credentials.from_authorized_user_file(str(TOKEN))
    if c.expired and c.refresh_token:
        from google.auth.transport.requests import Request

        c.refresh(Request())
        TOKEN.write_text(c.to_json())
    return c


def sheets_svc():
    return build("sheets", "v4", credentials=creds(), cache_discovery=False)


def read_seed(name):
    path = SEED / name
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        return [row for row in csv.reader(fh)]


def num_fmt(token):
    if token == "money":
        return "$#,##0.00"
    if token == "date":
        return "yyyy-mm-dd"
    if token == "datetime":
        return "yyyy-mm-dd hh:mm"
    if token == "number":
        return "0"
    return None


def col_letter(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def build_requests(tab, sheet_id, row_count):
    """Header styling, widths, formats and validations for one tab."""
    reqs = []
    ncols = len(tab["cols"])
    accent = ACCENT[tab["group"]]

    reqs.append(
        {
            "updateSheetProperties": {
                "properties": {
                    "sheetId": sheet_id,
                    "gridProperties": {"frozenRowCount": 1, "frozenColumnCount": 0, "columnCount": ncols},
                    "tabColor": accent,
                },
                "fields": "gridProperties.frozenRowCount,gridProperties.frozenColumnCount,"
                "gridProperties.columnCount,tabColor",
            }
        }
    )

    reqs.append(
        {
            "repeatCell": {
                "range": {"sheetId": sheet_id, "startRowIndex": 0, "endRowIndex": 1},
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": HEADER_BG,
                        "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}, "fontSize": 10},
                        "verticalAlignment": "MIDDLE",
                        "wrapStrategy": "CLIP",
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)",
            }
        }
    )

    for idx, (_name, token, width) in enumerate(tab["cols"]):
        reqs.append(
            {
                "updateDimensionProperties": {
                    "range": {"sheetId": sheet_id, "dimension": "COLUMNS", "startIndex": idx, "endIndex": idx + 1},
                    "properties": {"pixelSize": width},
                    "fields": "pixelSize",
                }
            }
        )
        fmt = num_fmt(token)
        if fmt:
            reqs.append(
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": sheet_id,
                            "startRowIndex": 1,
                            "endRowIndex": row_count + 500,
                            "startColumnIndex": idx,
                            "endColumnIndex": idx + 1,
                        },
                        "cell": {"userEnteredFormat": {"numberFormat": {"type": "NUMBER", "pattern": fmt}}},
                        "fields": "userEnteredFormat.numberFormat",
                    }
                }
            )

    # validations (row 2 down to +1000)
    for idx, (_name, token, _w) in enumerate(tab["cols"]):
        rng = {
            "sheetId": sheet_id,
            "startRowIndex": 1,
            "endRowIndex": 1001,
            "startColumnIndex": idx,
            "endColumnIndex": idx + 1,
        }
        if token == "bool":
            reqs.append(
                {
                    "setDataValidation": {
                        "range": rng,
                        "rule": {"condition": {"type": "BOOLEAN"}, "strict": True, "showCustomUi": True},
                    }
                }
            )
        elif token.startswith("enum:"):
            values = [v for v in token[5:].split(",") if v]
            reqs.append(
                {
                    "setDataValidation": {
                        "range": rng,
                        "rule": {
                            "condition": {"type": "ONE_OF_LIST", "values": [{"userEnteredValue": v} for v in values]},
                            "strict": False,
                            "showCustomUi": True,
                        },
                    }
                }
            )

    if tab["name"] != "README":
        reqs.append(
            {
                "setBasicFilter": {
                    "filter": {
                        "range": {
                            "sheetId": sheet_id,
                            "startRowIndex": 0,
                            "endRowIndex": max(row_count, 1) + 1,
                            "startColumnIndex": 0,
                            "endColumnIndex": ncols,
                        }
                    }
                }
            }
        )
    return reqs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet-id", help="rebuild tabs inside an existing spreadsheet")
    ap.add_argument("--title", default="Workshop Voice Agent")
    args = ap.parse_args()
    svc = sheets_svc()

    if args.sheet_id:
        sid = args.sheet_id
        meta = svc.spreadsheets().get(spreadsheetId=sid).execute()
        existing = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta["sheets"]}
        add = [t["name"] for t in TABS if t["name"] not in existing]
        if add:
            svc.spreadsheets().batchUpdate(
                spreadsheetId=sid,
                body={"requests": [{"addSheet": {"properties": {"title": n}}} for n in add]},
            ).execute()
        meta = svc.spreadsheets().get(spreadsheetId=sid).execute()
        ids = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta["sheets"]}
    else:
        body = {
            "properties": {"title": args.title, "locale": "en_AU", "timeZone": "Australia/Melbourne"},
            "sheets": [{"properties": {"title": t["name"], "index": i}} for i, t in enumerate(TABS)],
        }
        res = svc.spreadsheets().create(body=body, fields="spreadsheetId,spreadsheetUrl,sheets.properties").execute()
        sid = res["spreadsheetId"]
        ids = {s["properties"]["title"]: s["properties"]["sheetId"] for s in res["sheets"]}
        print(f"created spreadsheet {sid}")

    # drop the default Sheet1 if it survived
    meta = svc.spreadsheets().get(spreadsheetId=sid).execute()
    junk = [s["properties"]["sheetId"] for s in meta["sheets"] if s["properties"]["title"] == "Sheet1"]
    if junk:
        svc.spreadsheets().batchUpdate(
            spreadsheetId=sid,
            body={"requests": [{"deleteSheet": {"sheetId": j}} for j in junk]},
        ).execute()

    for tab in TABS:
        rows = read_seed(tab["seed"]) if tab["seed"] else [[l] for l in README_LINES]
        if tab["name"] == "README" and not tab["seed"]:
            pass
        if not rows:
            rows = [[c[0] for c in tab["cols"]]]
        # keep every row exactly as wide as the schema; a stray comma in seed data
        # must not shift columns
        n = len(tab["cols"])
        rows = [(r + [""] * n)[:n] for r in rows]
        # USER_ENTERED would treat a leading + / = / - / @ as a formula (this is what
        # silently strips the '+' from phone numbers), so text-guard those cells
        rows = [[("'" + v if isinstance(v, str) and v[:1] in "+=-@" else v) for v in r] for r in rows]
        last_col = col_letter(len(tab["cols"]) - 1)
        rng = f"'{tab['name']}'!A1:{last_col}{max(len(rows), 1)}"
        svc.spreadsheets().values().update(
            spreadsheetId=sid, range=rng, valueInputOption="USER_ENTERED", body={"values": rows}
        ).execute()

        reqs = build_requests(tab, ids[tab["name"]], len(rows))
        if tab["name"] == "README":
            reqs.append(
                {
                    "repeatCell": {
                        "range": {"sheetId": ids["README"], "startRowIndex": 0, "endRowIndex": 2},
                        "cell": {"userEnteredFormat": {"textFormat": {"bold": True, "fontSize": 12}}},
                        "fields": "userEnteredFormat.textFormat",
                    }
                }
            )
        svc.spreadsheets().batchUpdate(spreadsheetId=sid, body={"requests": reqs}).execute()
        print(f"  {tab['name']}: {len(rows)} rows x {len(tab['cols'])} cols")

    url = f"https://docs.google.com/spreadsheets/d/{sid}/edit"
    print(json.dumps({"sheet_id": sid, "url": url}, indent=2))

    env = ROOT / ".env"
    example = ROOT / ".env.example"
    if not env.exists() and example.exists():
        env.write_text(example.read_text())
    if env.exists():
        txt = env.read_text()
        if re.search(r"^SHEET_ID=", txt, re.M):
            txt = re.sub(r"^SHEET_ID=.*$", f'SHEET_ID="{sid}"', txt, flags=re.M)
        else:
            txt += f'\nSHEET_ID="{sid}"\n'
        env.write_text(txt)
        print(f"wrote SHEET_ID into {env}")


if __name__ == "__main__":
    main()
