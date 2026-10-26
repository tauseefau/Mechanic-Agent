# Test plan and results

Status: **not yet run** — populated in Phase 6.

## Test plan

### 1. Action coverage (`tests/api-tests.js`)

| Action | Cases |
|---|---|
| `get_workshop_info` | default; with holiday in range |
| `list_services` | all active services; inactive hidden; add-ons grouped |
| `get_price_quote` | single service; service + 1 add-on; service + 3 add-ons; unknown add-on; GST in/out |
| `lookup_customer` | known phone; unknown phone; with vehicles; with upcoming bookings |
| `check_availability` | normal day; lunch excluded; holiday; past date; beyond max_days_ahead; bays 1 vs 2; full-day service |
| `create_booking` | happy path; double-book; past date; outside hours; invalid phone; new customer; returning customer with new vehicle |
| `reschedule_booking` | happy path; to a taken slot; to a holiday |
| `cancel_booking` | by booking_id; by phone+date; already cancelled |
| `log_call_summary` | writes a Call_Log row |

### 2. Edge-case matrix

| # | Case | Expected |
|---|---|---|
| 1 | Booking in the past | `success:false`, friendly message |
| 2 | Booking during lunch | `success:false`, alternatives |
| 3 | Booking on a holiday | `success:false`, reason quoted |
| 4 | Booking at 06:00 | `success:false`, outside hours |
| 5 | Two calls for the same slot | first succeeds, second fails with 3 alternatives |
| 6 | `bays_available = 1` | second overlapping slot refused |
| 7 | `bays_available = 2` | second overlapping slot accepted |
| 8 | Full-day major service | whole working day blocked |
| 9 | Unknown add-on id | quote still works, unknown id ignored with note |
| 10 | Invalid phone `12345` | `success:false`, asks for number again |
| 11 | Returning customer | greeted by name, vehicle confirmed |

### 3. No-code-change proofs

- Add `Headlight globe replacement` to `Products_Addons` -> `list_services` shows it and
  a booking can include it, with zero code/prompt change.
- Change `Minor Service.price_from` and `Working_Hours[Monday].open` -> the next
  `get_price_quote` and `check_availability` reflect both.

### 4. Live call scenarios

| Scenario | Expected |
|---|---|
| New customer books a minor service | Correct service, add-on offer, 3 slots, readback, booking written to Sheet + Calendar |
| Returning customer reschedules | Named greeting, correct booking found, new slot, old event updated |
| Price enquiry then cancel | Quote given from sheet, existing booking cancelled, event removed |

## Results

_To be filled in Phase 6._
