# Sheet schema — "Workshop Voice Agent"

_Phase 1 deliverable. This is the authoritative definition; `sheet/create_sheet.gs`
implements exactly this and `sheet/seed/*.csv` holds the seed rows._

Tabs, in order: Config, Working_Hours, Holidays_Closures, Services, Products_Addons,
Customers, Vehicles, Bookings, Call_Log, README.

Conventions: row 1 is a frozen, bold header with a filter. Dates are `YYYY-MM-DD`.
Timestamps are ISO 8601 in the workshop timezone. `TRUE`/`FALSE` for booleans.
Money is a number in the currency set by `Config.currency`.

## 1. Config
| Column | Type | Notes |
|---|---|---|
| key | text | unique, snake_case |
| value | text/number/boolean | parsed by type at read time |
| notes | text | shown to the owner only |

Keys: `workshop_name`, `phone`, `address`, `timezone`, `currency`,
`slot_granularity_minutes` (30), `booking_lead_time_hours` (4), `max_days_ahead` (60),
`bays_available` (2), `buffer_minutes_between_jobs` (15), `calendar_id`,
`greeting_name_for_agent`, `transfer_phone_number`, `after_hours_message`,
`gst_percent` (10), `prices_include_gst` (TRUE), `currency_symbol` ($),
`phone_country_code` (61), `cancellation_policy_text`.

## 2. Working_Hours
| Column | Type | Validation |
|---|---|---|
| day_of_week | text | Monday..Sunday, one row each |
| open | time | `HH:MM` |
| close | time | `HH:MM` |
| is_closed | boolean | TRUE closes the day |
| lunch_start | time | optional |
| lunch_end | time | optional |

## 3. Holidays_Closures
| Column | Type | Validation |
|---|---|---|
| date | date | `YYYY-MM-DD`, future |
| reason | text | spoken to callers |
| full_day | boolean | TRUE = whole day closed |
| open | time | used when full_day is FALSE |
| close | time | used when full_day is FALSE |

## 4. Services
| Column | Type | Validation |
|---|---|---|
| service_id | text | unique, e.g. `SVC001` |
| service_name | text | spoken name |
| category | text | list: Servicing, Repairs, Inspection, Tyres, Electrical |
| description | text | one plain sentence the agent can read |
| price_from | number | > 0 |
| price_to | number | >= price_from |
| duration_minutes | number | 15..1440 |
| requires_full_day | boolean | TRUE blocks the day |
| active | boolean | FALSE hides from agent |
| notes | text | internal |

## 5. Products_Addons
| Column | Type | Validation |
|---|---|---|
| item_id | text | unique, e.g. `ADD001` |
| item_name | text | spoken name |
| category | text | list: Parts, Labour, Consumables, Electrical, Tyres |
| price | number | >= 0 |
| extra_duration_minutes | number | 0..480 |
| applies_to_services | text | semicolon-separated service names; blank = any |
| active | boolean | FALSE hides |
| notes | text | internal |

## 6. Customers
| Column | Type |
|---|---|
| customer_id | text (`CUS0001`) |
| full_name | text |
| phone | text, E.164 `+61412345678` — lookup key |
| email | text, optional |
| first_seen | timestamp |
| last_contact | timestamp |
| notes | text |

## 7. Vehicles
| Column | Type |
|---|---|
| vehicle_id | text (`VEH0001`) |
| customer_id | text, FK -> Customers |
| rego | text, uppercase, no spaces |
| make | text |
| model | text |
| year | number 1900..2100 |
| odometer | number |
| last_service_date | date |
| notes | text |

## 8. Bookings
| Column | Type |
|---|---|
| booking_id | text (`BK00001`) |
| created_at | timestamp |
| customer_id | FK |
| vehicle_id | FK |
| service_id | FK |
| addons | text, semicolon-separated item_ids |
| start_datetime | timestamp ISO |
| end_datetime | timestamp ISO |
| estimated_price_low | number |
| estimated_price_high | number |
| status | list: Confirmed, Cancelled, Completed, No-show |
| calendar_event_id | text |
| source | list: phone, walk-in, web, manual |
| notes | text |

## 9. Call_Log
| Column | Type |
|---|---|
| timestamp | timestamp |
| call_id | text |
| caller_number | text, E.164 |
| tool_called | text |
| request_json | text (truncated 50k) |
| response_json | text (truncated 50k) |
| outcome | text (success / error / unauthorised / no_slot) |

## 10. README
Free-text owner instructions. Mirrors `docs/owner-guide.md`.
