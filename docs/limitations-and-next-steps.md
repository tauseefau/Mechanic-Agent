# Limitations and next steps

## Known limitations

1. **US phone number.** Vapi's free US number is not local for Australian customers;
   some callers won't answer or will treat it as spam. Importing an AU number needs a
   Twilio/Telnyx number pointed at Vapi by SIP.
2. **Apps Script execution limits.** 6 minutes per execution and daily quota caps.
   Fine for per-call tool requests; not suitable for batch jobs.
3. **No payment or deposit.** Bookings are free to make, so no-shows cost a bay.
4. **No SMS/email confirmation.** The caller hears the confirmation and the booking
   lands in the sheet/calendar, but nothing is sent to them.
5. **No day-before reminder.** Needs a time-driven Apps Script trigger plus SMS.
6. **Single calendar, no per-mechanic allocation.** `bays_available` is a count, not
   per-technician capacity, so a bay isn't tied to a specific mechanic.
7. **No roadworthy/inspection workflow**, no parts ordering, no invoicing.
8. **Call recording/transcripts** live in Vapi, not in the Sheet. `Call_Log` holds the
   summary and tool traffic only.
9. **Availability is computed, not optimised.** It offers the nearest slots on a fixed
   grid rather than packing the day.
10. **Owner edits are live and unvalidated** beyond sheet data validation — a typo in
    `Working_Hours` can produce a strange day.

## Recommended next steps

1. **SMS confirmation + day-before reminder** (Twilio + Apps Script time trigger).
2. **Import an Australian local number** into Vapi (Twilio/Telnyx SIP trunk).
3. **Deposit / payment link** for major services to cut no-shows.
4. **Per-bay capacity model** (`Bays` tab: bay_id, name, skills) instead of a count.
5. **Owner dashboard** (Apps Script sidebar or Looker Studio) for utilisation,
   no-show rate and average quote-to-booking conversion.
6. **Parts and labour breakdown** on the quote, so the agent can explain the estimate.
7. **Callback queue** when a slot doesn't exist but the caller wants to be told.
8. **Multi-language** (Greek, Italian, Vietnamese, Mandarin) — large share of AU
   workshop customers; Vapi supports per-call language.
9. **Automatic `Completed` status** from a post-service checklist rather than the
   owner editing the Bookings tab.
10. **Ops alerting** — if `unauthorised` or `error` rows spike in `Call_Log`, ping the
    owner.
