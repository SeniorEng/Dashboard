---
name: Billing pot-split is a pure read of consumption rows
description: Why §45b "low budget" billing-flow split tests fail while §45a split works — it's a consumption-engine trait, not a billing-route bug.
---

# Billing per-pot invoice split reflects consumption rows verbatim

`getBudgetSplitForAppointments` + `splitLineItemsByPot` (now in
`server/services/invoice-calc.ts` / `invoice-data.ts`) do **not** recompute any
budget cascade. They `SELECT` `budget_transactions` rows with
`transaction_type='consumption'` for the appointments, **drop the ones that
were reversed/stornoed**, and bucket the survivors by `budget_type`.
`needsBudgetSplit = potItems.size > 1`. So a multi-invoice (Kasse + Privat)
split is produced **only if the consumption engine already booked the
appointment across >1 LIVE pot** at `documentAppointment` time.

**Task #1012 — stornoed pots no longer bill:** the split now excludes any
consumption whose `id` is reversed, via the pure
`buildBudgetSplitFromLedger(consumptions, reversals)` in
`shared/domain/budget-invoice-split.ts`. "Reversed" = a reversal row links it
(`reversed_transaction_id`) OR a NOTE-orphan references it ("Storno … von
Transaktion #<id>", parsed by `parseStornoReference`). A pot whose consumption
is entirely stornoed (e.g. a phantom-§45a split born from a cancelled booking)
drops out → no superfluous follow-up invoice. Drift test:
`tests/equality/phantom-storno-split.test.ts`. **Why:** before this, the split
ignored reversals entirely, so a fully-cancelled pot still spawned its own
invoice (Egon Uhlig April 2026). **How to apply:** any new aggregation over
`budget_transactions` for billing/preview must net out reversed consumptions,
not blind-SUM `consumption` rows.

**Observed asymmetry (DB-verified):** the consumption engine books
`{private, umwandlung_45a}` two-row splits for §45a overflow, but for
`entlastungsbetrag_45b` it always books a **single** pot row — there are zero
`{entlastungsbetrag_45b, private}` appointments in the entire DB. A §45b "low
budget" customer whose appointment exceeds the configured `monthlyLimitCents`
does NOT get a §45b→private overflow consumption row, so billing has nothing to
split.

**Why:** the billing-flow tests `BF-2.x / 3.4 / 6.2 / 6.3 / 7.3 / 8.2` use
`configureLowBudgetPV` (sets §45b `monthlyLimitCents` low, budgetStartDate=month
start) and expect a Kasse+Privat split. They fail because §45b consumption does
not split to private at the row level (likely the §45b yearly-balance /
materialization path uses the full accrued §45b balance, ignoring the low
monthly limit). This lives in `server/storage/budget/consumption-engine.ts`,
NOT in the billing route layer.

**How to apply:** if these split tests are red, do NOT look for the bug in
`billing.ts` / `invoice-calc.ts` (the split read is a faithful, byte-identical
pure read). Investigate §45b overflow booking in the consumption engine. A
billing-route refactor cannot fix or break this without changing consumption
behavior.
