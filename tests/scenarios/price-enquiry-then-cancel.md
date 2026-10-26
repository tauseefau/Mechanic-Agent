# Scenario 3 — price enquiry then cancels

_Phase 6: run 2026-10-26 22:30 UTC against the live endpoint, model `openai/gpt-4o-mini`._

**Preconditions:** seeded customer Priya Raman, Hyundai i30 PRX221, one confirmed booking
(BK00001, Monday 2 November 08:00) created through the API before the call.
**Caller:** "How much is a major service? ... Actually I need to cancel my booking."
**Expected:** quotes Major Service range from the sheet, then confirms which booking, reads
the cancellation policy, cancels, confirms cancellation.

## Transcript

```
Charlie:  Thanks for calling Riverbend Auto Service, this is Charlie. How can I help today?
Priya:    Hi Charlie, I'd like to know the price range for a major service on my Hyundai i30.
Charlie:  Hi Priya, for a major service on your Hyundai i30, it's normally between four
          hundred and eighty and seven hundred and fifty dollars, and we'd need the car
          for about four hours. That's an estimate — the final price is confirmed after
          we've had a look. Is there anything else you need?
Priya:    Yes, I actually need to cancel my existing booking.
Charlie:  I can help with that. Your current booking is for a major service on Monday the
          second at eight am. Just to confirm, are you sure you want to cancel that?
Priya:    Yes, I want to cancel that booking.
Charlie:  Your booking for the major service on Monday the second at eight am has been
          successfully cancelled. Thanks for letting us know. Is there anything else I can
          help you with today?
Priya:    No, that's all. Thank you!
```

## Tool calls

| Tool | Result | Latency |
|---|---|---|
| `lookup_customer` | "Welcome back, Priya … already have Monday 2 November at 8 am" | 1,710 ms |
| `list_services` | catalogue names | 1,710 ms |
| `get_price_quote` | $480–$750, 240 min | 615 ms |
| `cancel_booking` | status Cancelled, event deleted | 3,224 ms |
| `log_call_summary` | outcome `cancelled` | 626 ms |

## Outcome — 7/7 assertions

- Booking row set to `Cancelled` (kept for history, not deleted).
- Calendar event deleted; the slot is free again.
- Major-service quote came from `get_price_quote` ($480–$750), matching the sheet.
- No `Call_Log` row contains the shared token.

## Why the price assertion is exact

The first Phase 6 run passed on everything except the quote: the agent answered
"$480 to $750" from `list_services`, which carries a reference range and no add-ons. The
number happened to be right, but the same shortcut would misquote a job with add-ons, so
`list_services`' description now says its ranges are orientation only and
`get_price_quote` is the only source for a spoken figure. See `docs/decisions.md` D-027.
