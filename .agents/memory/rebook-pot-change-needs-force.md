---
name: Pot-only rebook needs force
description: Rebooking an appointment whose budget POT changes but km/minutes/date are unchanged is skipped unless force:true.
---

`rebookAppointmentConsumption` (server/storage/budget/km-rebook.ts) early-returns
without doing anything when km, minutes and date are all unchanged (`!kmDrift &&
!minutesDrift && !dateDrift`). A pure reclassification — same appointment, same
quantities, but the consumption must move from one budget pot to another (e.g.
Privat → §45b after a customer is corrected from `selbstzahler` to
`pflegekasse_privat`) — produces NO drift, so the rebook is silently a no-op.
A one-off guarded budget migration that reclassifies a customer's pot mix hit
exactly this.

**Why:** the drift guard exists to avoid needless storno+rebook churn on edits
that don't change consumption inputs; it never anticipated the pot itself
changing while inputs stay identical.

**How to apply:** for pot-only re-bookings pass `force: true` (added for this
case) to force the storno + cascade re-booking. Any future "move existing
consumption into a different pot" correction must set `force`, otherwise the
ledger keeps the old pot.
