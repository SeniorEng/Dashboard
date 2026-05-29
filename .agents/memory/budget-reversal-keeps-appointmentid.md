---
name: Reversal rows keep appointmentId (GoBD)
description: Budget consumption reversals now retain the original appointmentId instead of decoupling to NULL; how to aggregate "live" consumption.
---

# Budget reversal rows keep the original appointmentId

When a budget consumption is re-booked (km-rebook, reconcile-trimmed-imports,
import-update path), the storno/reversal `budget_transactions` row now carries
`appointmentId = orig.appointmentId`. The old behavior of setting the reversal to
`appointmentId = null` AND nulling the original consumption's appointmentId was
removed.

**Why:** a CHECK constraint now requires `consumption`/`reversal` rows to have a
non-null `appointment_id` (GoBD: every ledger movement must trace to its
appointment). Decoupling to NULL produced orphan ledger rows and would violate the
constraint.

**How to apply:** any query/aggregation that sums consumption "currently attached
to an appointment" can no longer just filter `type='consumption' AND appointmentId=X`
— that now also picks up the cancelled (reversed) original. To get the *live*
consumption, exclude rows that have a reversal pointing at them: build a set of
`reversedTransactionId` from `type='reversal'` rows and skip consumptions whose `id`
is in that set. The pre-check in `createCascadeConsumption` already does this via
`getTransactionByAppointmentId` (excludes rows referenced by `reversedTransactionId`).
