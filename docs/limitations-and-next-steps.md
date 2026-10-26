# Limitations and next steps

## Known limitations

1. **No phone number attached.** Vapi refuses to create a number without a card on file,
   and the account's three numbers belong to the live plumbing assistant. The assistant is
   configured and tested through a browser web-call room; an Australian local number still
   needs a Twilio/Telnyx trunk pointed at Vapi by SIP.
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

11. **The audio path is unproven.** No Vapi phone number is attached (creating one needs a
    card on file), so the transcription → model → voice round trip, barge-in and real
    latency have never run. The conversation behaviour is verified by
    `tests/phase6-conversations.js`; the audio is not.
12. **Prompt-following is model-specific.** Four of the six defects Phase 6 found were the
    model ignoring an instruction it had been given. The backend now has a guard against
    the worst one (duplicate bookings), but a model change needs the three scenarios
    re-run before go-live.
13. **Catalogue edits take up to 10 s to appear** in a running service (per-tab read cache).
    Fine for an owner changing a price at 8 pm; worth knowing if someone edits during a
    call.

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
