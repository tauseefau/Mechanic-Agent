# Scenario 1 — new customer books a minor service

_Phase 6: run 2026-10-26 22:30 UTC against the live endpoint, model `openai/gpt-4o-mini`
(the assistant's own model). Caller is a second LLM with a fixed persona; every tool call
goes to `https://diyyourdata.com/workshop-api/` and touches the real Sheet and Calendar._

**Preconditions:** caller number not in Customers; 2 bays; no bookings for the day.
**Caller:** "Hi, my Corolla needs a service, how much and when can I get in?"
**Expected:** asks which service, quotes Minor Service range, offers 3 slots, collects
name/rego/make/model/year, reads back rego letter by letter + date + time, books, states
booking reference and price estimate.

## Transcript

```
Charlie:  Thanks for calling Riverbend Auto Service, this is Charlie. How can I help today?
Nadia:    Hi Charlie, I'd like to book a minor service for my 2016 Toyota Corolla.
Charlie:  No worries, I can help with that. Can I have your full name, please?
Nadia:    Sure, it's Nadia Okafor.
Charlie:  Thanks, Nadia. What's the registration number for your Corolla?
Nadia:    It's RVB442.
Charlie:  Great, and just to confirm, what sort of car is it? I have a 2016 Toyota Corolla.
Nadia:    Yes, it's a 2016 Toyota Corolla.
Charlie:  Thanks for that. Can I have a contact number, just in case I need to reach you?
Nadia:    My mobile number is +61 478 901 234.
Charlie:  Thanks, Nadia. Is there anything else we should look at while the car is in for
          the minor service?
Nadia:    No, I don't need anything extra. Just the minor service, please.
Charlie:  For the minor service, it's normally between one hundred and eighty and two
          hundred and sixty dollars, and we'd need the car for about an hour and a half.
          I have a few slots available: Wednesday the twenty-eighth at eight, at eight
          thirty, or at nine. Which one suits you?
Nadia:    I can do Wednesday the twenty-eighth at eight.
Charlie:  Perfect! Just to confirm, that's a minor service on the Corolla, rego R V B four
          four two, for Nadia Okafor, on Wednesday the twenty-eighth at eight. Is that all right?
Nadia:    Yes, that's correct. Thank you!
Charlie:  You're booked in for a minor service on Wednesday the twenty-eighth at eight,
          reference B K zero zero one. The estimate is one hundred and eighty to two
          hundred and sixty dollars, and the final price is confirmed after we inspect it.
          Thanks for calling Riverbend Auto Service, see you then!
```

## Tool calls

| Tool | Result | Latency |
|---|---|---|
| `lookup_customer` | new customer | 818 ms |
| `get_price_quote` | $180–$260, 90 min | 1,361 ms |
| `check_availability` | 3 slots on Wed 28 Oct | 1,936 ms |
| `create_booking` | BK00001, event created | 5,329 ms |
| `log_call_summary` | outcome `booked` | 767 ms |

## Outcome — 8/8 assertions

- One `Bookings` row, `status=Confirmed`, linked to a calendar event id.
- Calendar event titled `Minor Service - Nadia Okafor - RVB442`.
- `Call_Log` has a row for every tool call plus the summary; no row contains the token.
- Booking sits inside opening hours, not on a closure.

**Deviation worth knowing:** it asked for a contact number even though the caller number
was already in the prompt. Harmless, but a real caller hears a redundant question — see
`docs/testing.md` "Known behaviour" for what was and was not changed.
