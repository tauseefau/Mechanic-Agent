# Owner guide — running the workshop with the AI receptionist

Everything you need is in one spreadsheet: **Workshop Voice Agent**.
You never need to touch code. Changes take effect on the next phone call.

## 1. Change your opening hours

Tab **Working_Hours**. One row per weekday.

- `open` / `close` — 24-hour time, e.g. `08:00` and `17:30`.
- `is_closed` — `TRUE` to close that whole day.
- `lunch_start` / `lunch_end` — leave blank if you don't take a lunch break.

## 2. Change a price or a service duration

Tab **Services**. Find the row, edit `price_from`, `price_to` or `duration_minutes`.

- `price_from` / `price_to` make the agent quote a **range** ("from $X to $Y").
  If they are the same number it quotes a single price.
- `requires_full_day` = `TRUE` for jobs that occupy a whole day.
- `active` = `FALSE` hides a service from the agent without deleting it.

Prices include GST by default (see `gst_percent` and `prices_include_gst` in Config
if you ever need to change that).

## 3. Add a new product or add-on

Tab **Products_Addons**. Add a row at the bottom:

| item_id | item_name | category | price | extra_duration_minutes | applies_to_services | active |
|---|---|---|---|---|---|---|
| ADD009 | Headlight globe replacement | Electrical | 45 | 15 | Minor Service;Major Service | TRUE |

- `item_id` must be unique (anything you like, e.g. `ADD009`).
- `applies_to_services` — semicolon-separated `service_name`s, or leave blank for
  "any service".
- `extra_duration_minutes` is added to the booking length.

The agent picks it up on the next call. No code change, no restart.

## 4. Block a holiday or a day off

Tab **Holidays_Closures**. Add a row:

| date | reason | full_day | open | close |
|---|---|---|---|---|
| 2026-12-25 | Christmas Day | TRUE | | |
| 2026-12-24 | Christmas Eve (early close) | FALSE | 08:00 | 12:00 |

Dates are `YYYY-MM-DD`. The agent will not offer those slots and will mention the
closure if asked about the day.

## 5. See your bookings

- **Calendar** `Workshop Bookings` — every booking appears there automatically with
  the customer, rego, add-ons and estimated price in the description.
- Tab **Bookings** — the same bookings in table form, plus `status`
  (Confirmed / Cancelled / Completed / No-show) and `estimated_price_low/high`.

Tick `status` to `Completed` or `No-show` after the job — the agent does not do that
for you.

## 6. Look up a customer

Tab **Customers** — search by phone (stored as `+61412345678`). Vehicles are in
**Vehicles** keyed by the same `customer_id`. The agent greets returning callers by
name using this table.

## 7. What the agent will never do

- It will never quote a price that isn't in the Services/Products tabs.
- It will never book outside your hours or on a holiday.
- It will never diagnose a fault. For brakes failing, smoke, an accident or a
  breakdown it transfers the call to your mobile (`transfer_phone_number` in Config).

## 8. Things you can edit in Config

| Key | Meaning |
|---|---|
| `workshop_name` | Said in the greeting |
| `phone`, `address` | Quoted to callers |
| `transfer_phone_number` | Where emergencies and "give me a human" go |
| `after_hours_message` | Said when the caller rings outside hours |
| `bays_available` | How many cars you can work on at once (2 = two overlapping bookings allowed) |
| `booking_lead_time_hours` | Minimum notice before a slot can be booked |
| `max_days_ahead` | How far into the future the agent will book |
| `slot_granularity_minutes` | Slot grid (30 = 8:00, 8:30, 9:00 ...) |
| `buffer_minutes_between_jobs` | Cleanup time counted as busy between jobs |
| `cancellation_policy_text` | Read out when someone asks about cancelling |

## 9. If something looks wrong

1. Check the **Call_Log** tab — every call and every tool call is there with the
   exact request and response.
2. Check that the date you're testing isn't blocked in **Holidays_Closures**.
3. If the agent says "I'm having trouble reaching the booking system", the web app
   deployment or its token is broken — that needs whoever maintains the repo.
