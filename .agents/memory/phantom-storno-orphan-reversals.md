---
name: Phantom-Storno orphan reversals (import drift)
description: Why budget_transactions has double-credit "Storno von Transaktion #N" orphans and how the corrector decides phantom vs legit.
---

Excel-imported customer history produced **orphan reversal rows** in
`budget_transactions`: `transaction_type='reversal'`, `reversed_transaction_id
IS NULL`, but `notes` says "Storno von Transaktion #N". These credit the
referenced consumption a second time → net used too low / remaining too high.

**Why the partial unique index doesn't catch them:** the dedup guard
`budget_transactions_reversal_unique_idx` is partial on a *set* `reversed_transaction_id`.
NULL-link orphans bypass it entirely.

**Phantom vs legit decision (SSoT: `shared/domain/budget/phantom-storno.ts`):**
an orphan is **phantom** (must be neutralized) iff the referenced original is
EITHER (a) additionally reversed via a *linked* reversal row, OR (b) tied to a
**live** appointment (`deleted_at IS NULL AND status <> 'cancelled'`). A single
orphan storno of a cancelled/soft-deleted appointment is a **legit** cancellation
— skip it. (In the 2026 import all 28 orphans were phantom; total drift 1.473,00 €.)

**Correction is append-only (GoBD):** never DELETE/UPDATE. Write an inverse
`consumption` row with ALL service columns sign-flipped (hauswirtschaft/
alltagsbegleitung minutes+cents, travel/customer km+cents) so Σ(orphan+correction)=0
per column. The orphan stays in the ledger. Idempotent via a unique note marker.

**Net-used measurement that matches drift exactly:**
`net_used = Σ|consumption+write_off| − Σ|reversal|`;
`true_used = Σ|consumption NOT linked-reversed|`; `drift = true_used − net_used`
and `drift == Σ(phantom orphan amounts)` per customer/pot.

**Prevention:** `reverseBudgetTransaction` now also matches note-based orphans of
the same original (`notes ~ 'Storno.*Transaktion #<id>(\\D|$)'`, same customerId)
and returns the existing orphan instead of booking a second storno.

**How to apply:** any new budget_transactions reversal/aggregation path must treat
note-only "Storno von Transaktion #N" rows as real reversals when summing used,
and any importer must update-not-duplicate so it never emits NULL-link stornos.
