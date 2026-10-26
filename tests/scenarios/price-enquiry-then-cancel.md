# Scenario 3 — price enquiry then cancels

_Phase 6: expected transcript and outcome recorded here._

**Preconditions:** caller has one upcoming booking.
**Caller:** "How much is a major service? ... Actually I need to cancel my booking."
**Expected:** quotes Major Service range from the sheet, states what's included, then
confirms which booking, reads the cancellation policy, cancels, confirms cancellation.
**Assertions:** `status=Cancelled`; calendar event deleted; slot free again.
