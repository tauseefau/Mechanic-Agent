# Scenario 2 — returning customer reschedules

_Phase 6: expected transcript and outcome recorded here._

**Preconditions:** caller number matches a seeded customer with one upcoming booking.
**Caller:** "It's Sam — something came up, can we move Thursday's booking?"
**Expected:** greets by name, confirms vehicle, identifies the booking, offers 3 new
slots, confirms, updates the same booking (no duplicate row), moves the calendar event.
**Assertions:** same `booking_id`; one calendar event with the new time; old time free
again in availability.
