---
name: planHold §45b projectFuture horizon
description: Why the hold/booking path must project §45b like the overview, not read it strictly as-of the appointment date
---

# planHold §45b availability must mirror the overview's projectFuture horizon

The unified reader (`readUnifiedBudgetAvailability`) reads §45b strictly as-of the
appointment date WITHOUT the `projectFuture` accrual horizon that the
"Verfügbar (nach Planung)" overview uses. For a FUTURE appointment,
`calculateAllocated45b` caps the accumulation horizon at *today's* month, so the
monthly §45b top-ups that accrue between today and the appointment month are
missing. A booking whose cost fits the projected entitlement but exceeds the
accrued-through-today amount would be falsely hard-blocked — stricter than the
displayed availability.

**Rule:** In `planHold` (server/storage/budget/reservation-storage.ts), when §45b
is enabled+inRange, build the §45b cascade capacity from a PROJECTED allocation:
`calculateAllocatedCents(customerId, "entlastungsbetrag_45b", {asOfDate:
lastDayOfMonth(apptMonth), projectFuture:true})` minus `consumedNetCents` minus
`holdsActiveCents` (both taken from the same in-lock unified read). §45a/§39 stay
on their monthly/yearly cap availability.

**Why:** The booking path and the overview must agree on what's available, or
users see a budget in the UI they cannot actually book against. Subtracting active
holds + already-booked net keeps the no-overdraw guarantee intact — the projected
entitlement is the ONLY thing that changes vs. the bare read.

**How to apply:** Any new code that decides §45b bookability/availability for a
future-dated transaction must use the projectFuture horizon to the transaction's
month, not the bare as-of read. Test it by direct engine calls (planHold) against
a §45b `validFrom` set to a future month's first day → bare reader = 0, planHold
succeeds. The whole thing only enforces a block when `BUDGET_HARD_HOLDS=1|true`
(read in-process via `hardHoldsEnabled()`; HTTP/e2e can't reach gated branches).
