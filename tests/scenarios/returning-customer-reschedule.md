# Scenario 2 — returning customer reschedules

_Phase 6: run 2026-10-26 22:30 UTC against the live endpoint, model `openai/gpt-4o-mini`._

**Preconditions:** seeded customer Sam Whitfield, Mazda BT-50 SWX889, one confirmed
booking (BK00002, Monday 2 November 08:00) created through the API before the call.
**Caller:** "It's Sam — something came up, can we move the booking?"
**Expected:** greets by name, confirms vehicle, identifies the booking, offers 3 new
slots, confirms, updates the same booking (no duplicate row), moves the calendar event.

## Transcript

```
Charlie:  Thanks for calling Riverbend Auto Service, this is Charlie. How can I help today?
Sam:      Hi Charlie, this is Sam. I need to move my booking for my Mazda BT-50 to
          another morning later in the week or early next week.
Charlie:  Hi Sam, is this about the Mazda BT-50? You already have a booking for Monday,
          the second of November at eight. What day or time were you thinking of moving it to?
Sam:      Yes, that's correct. I was hoping to move it to either later in the week or
          early next week.
Charlie:  I have a few slots available for you on Tuesday, the third of November: at eight,
          at eight thirty, or at nine. Which one suits you best?
Sam:      Could I move it to eight thirty on Tuesday, the third of November?
Charlie:  You're all set! Your minor service for the Mazda BT-50 is now on Tuesday, the
          third of November at eight thirty.
Sam:      Thank you, Charlie! See you then.
```

## Tool calls

| Tool | Result | Latency |
|---|---|---|
| `lookup_customer` | "Welcome back, Sam … you already have Monday 2 November at 8 am booked" | 1,481 ms |
| `check_availability` | 3 slots on Tue 3 Nov | 2,647 ms |
| `reschedule_booking` | same booking, new time | 3,353 ms |
| `log_call_summary` | outcome `rescheduled` | 821 ms |

## Outcome — 7/7 assertions

- Still exactly one booking row, same `booking_id` (BK00002) — no duplicate.
- Start moved 2026-11-02T08:00 → 2026-11-03T08:30.
- Same calendar event id, moved; the old time is no longer occupied.

## Why this scenario matters

On the first Phase 6 run the agent greeted Sam by name, heard "change that booking", and
still called `create_booking` — leaving two confirmed bookings and two references. The
prompt rule was not enough for `gpt-4o-mini`, so `create_booking` now refuses a second
booking for a car that already has one ahead of it and returns `duplicate_booking` with
the existing reference. This transcript is from after that fix; see
`docs/decisions.md` D-025.
