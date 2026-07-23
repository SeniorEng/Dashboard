---
name: §45b inflated card = expired carryover; fix by soft-delete (no GoBD bypass)
description: When a customer's §45b "Gesamt zugewiesen" card is inflated by an expired prior-year carryover that a later Startwert did NOT supersede, and how to remediate.
---

# §45b inflated "Gesamt zugewiesen" = leftover expired carryover

An inflated §45b "Gesamt zugewiesen" on a customer card can be an **expired
prior-year `budget_allocations` row with `source='carryover'`** (valid only to
30.06 of the carryover year) that is STILL active (`deleted_at IS NULL`).

**Why it lingers:** a later `initial_balance` "Startwert" re-baseline (#1812
semantics) re-bases monthly *accrual* but does NOT automatically drop/supersede
an independent carryover allocation row. So `calculateAllocated45b` keeps summing
the carryover on top of the Startwert → the card and the reader both over-report
§45b, which can suppress the intended cascade overflow to §39/§42a and let a month
be wrongly billed entirely on §45b.

**Fix = soft-delete the carryover row** (set `deleted_at`). The real baseline is
the latest Startwert (`initial_balance`). Precondition before deleting: an active
§45b `initial_balance` must exist, or you'd strip the only §45b anchor.

## Soft-delete of budget_allocations needs NO GoBD bypass
The `ensure-gobd-table-immutability` triggers on `budget_allocations` only block:
- **resurrect** (`deleted_at` NOT NULL → NULL) via `budget_allocations_prevent_resurrect`
- **hard DELETE** via `budget_allocations_prevent_delete`

There is **no value-column immutability / no update-block** on the table (unlike
`budget_transactions`). So a plain `UPDATE ... SET deleted_at = now()` (soft-delete)
is allowed WITHOUT `SET LOCAL app.allow_gobd_mutation='on'`. Same for invoice
status transitions (`entwurf → versendet`): the invoices trigger only blocks
hard-delete of non-`entwurf` rows, not status updates.

**How to apply:** remediate in ONE `withAudit` tx — advisory-lock customer →
soft-delete active §45b carryover(s) (assert a Startwert exists) → finalize any
hanging stornorechnung drafts → `assertRebookAllowed` → `rebookNetZeroAppointmentCore`
per appt (ascending date) with `overflowRestriction.allowedPots` limited to
`[entlastungsbetrag_45b, ersatzpflege_39_42a]`, `privatePotOverride:null` →
ledger-assert `netAvailable45bAt(...,{projectFuture:false,holds:"ignore"})` raw
`allocatedCents − consumedNetCents === 0`. Then post-commit `generateInvoiceCore`
+ `persistInvoicePdf` (render OUTSIDE the tx). Reference deliverable:
`server/scripts/fix-ursula-99-june-rebill.ts` (dry-run simulates the whole tx in a
rolled-back transaction; the real dry-run/apply must run in prod — dev app db pool
can't reach prod and dev has no matching customer state).
