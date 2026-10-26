# Scenario 1 — new customer books a minor service

_Phase 6: expected transcript and outcome recorded here._

**Preconditions:** caller number not in Customers; Tuesday 10:00 free; 2 bays.
**Caller:** "Hi, my Corolla needs a service, how much and when can I get in?"
**Expected:** asks which service, explains minor vs major, quotes Minor Service range,
offers 3 slots, collects name/rego/make/model/year, reads back rego letter by letter +
phone + date + time, books, states booking reference and price estimate.
**Assertions:** one Bookings row with `status=Confirmed`; Calendar event titled
`Minor Service - <name> - <rego>`; `Call_Log` has get_price_quote,
check_availability, create_booking rows.
