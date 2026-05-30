---
name: Reversal keeps appointmentId, but originals are re-detached
description: Budget consumption reversals retain the original appointmentId; the ORIGINAL consumptions are detached to NULL again after the reversal loop. No CHECK constraint forbids this.
---

# Budget rebook: reversals keep appointmentId, originals get detached

When a budget consumption is re-booked (km-rebook, reconcile-km-drift,
import-update path), two things happen in the same transaction:

1. The storno/`reversal` `budget_transactions` row carries
   `appointmentId = orig.appointmentId` (so every storno stays traceable to its
   appointment via `appointmentId` + `reversedTransactionId`).
2. The ORIGINAL `consumption` rows are then detached from the appointment
   (`appointmentId = null`) via an `inArray(...)` update over the existing tx ids.

**Why:** if the originals stay attached, any aggregation that naively sums
`type='consumption' AND appointmentId=X` (drift detectors, stats cross-checks,
the `getTransactionByAppointmentId` pre-check, and the budget tests) double-counts
the cancelled original **and** the new live booking — consumption against caps and
km-drift then diverge. This was the double-counting regression: a prior change had
removed the detach step on the (incorrect) assumption that a CHECK constraint
required a non-null `appointment_id` on consumption/reversal rows.

**There is NO such CHECK constraint in the DB.** The startup
`budget_transactions_appointment_required_check` is logged as SKIPPED (hundreds of
legacy rows without `appointment_id`), so detaching originals is GoBD-safe — the
cancelled booking is still fully reconstructable from the reversal row.

**How to apply:** detach originals AFTER writing the reversal rows, never before
(the reversal must copy `orig.appointmentId` first). Keep the detach and the
reversal-insert in one transaction. To compute *live* consumption you can now
filter `type='consumption' AND appointmentId=X` directly — detached originals drop
out — but excluding rows referenced by a `reversedTransactionId` remains the robust
belt-and-suspenders approach for paths that don't detach.
