---
name: Storno/reversal transactionDate inheritance
description: Why reversal rows must copy the original consumption's transactionDate, and the test-booking traps for past-dated consumptions.
---

# Storno/reversal must inherit the original's transactionDate

A reversal (storno) budget_transactions row MUST set `transactionDate = orig.transactionDate`, NEVER `todayISO()`.

**Why:** budget availability is windowed (`transactionDate <= asOfDate`). If a storno happens on a later calendar day than the appt and the reversal is dated "today", an as-of-date query at the appt date keeps the original consumption but drops the credit → pot looks overdrawn → a real documentable appt is falsely hard-blocked. (created_at / audit timestamps stay real — only the business `transaction_date` couples to the original; GoBD-safe.)

**How to apply:** every path that writes a `transaction_type='reversal'` row must copy the source row's `transaction_date` (core path transaction-storage.ts; rebook-storage.ts and km-rebook.ts already do). `budget_transactions` is NOT GoBD-trigger-protected (only `budget_ledger` is), so a backfill UPDATE needs no bypass.

# Test-booking traps when forcing a PAST-dated consumption via createConsumptionTransaction
To reproduce date-window bugs you need consumption.transactionDate in the past. Pitfalls (all silently book 0 rows / 0 cents instead of throwing):
- Pass ALL four numeric params (hauswirtschaftMinutes, alltagsbegleitungMinutes, travelKilometers, customerKilometers). Omitting any → undefined/60 = NaN → totalCents NaN → hasUsage false → no real consumption.
- §45b `upsertBudgetTypeSettings` item needs `validFrom: <startDate>`; default validFrom=today makes the pot invalid at a past date → 0 allocation.
- `/api/budget/:id/initial-budget` 400s if `currentMonthAmountCents` exceeds the §45b statutory monthly cap (~131€); use a small value (e.g. 40_00).
- Cost falls back to service `defaultPriceCents` (no date restriction), so pricing itself is fine at past dates once the above are right.
