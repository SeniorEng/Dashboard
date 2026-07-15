---
name: §45b mid-year Startwert allocStart-shift undercount
description: calculateAllocated45b's initial_balance allocStart-shift must be gated to IB-derived anchors only, else mid-year Startwert cuts off preceding months.
---

The `initialBalanceMonths` allocStart-shift in `calculateAllocated45b`
(server/storage/budget/allocation-storage.ts) pushes allocStart to the month
AFTER the latest initial_balance row. If the accrual anchor comes from
pflegegrad history (not the IB), a mid-year Startwert then cut off ALL preceding
months' accumulation (an affected customer: 131 € instead of ~917 €, false "über Budget").

**Rule:** gate the shift with `anchorFromInitialBalance` — apply it ONLY when the
anchor was actually derived from an active initial_balance row. The
`initialBalanceSet` skip-set already prevents double-counting the Startwert month
independently, so the shift is not needed for correctness when the anchor is
pflegegrad-derived.

**Why:** the shift exists to avoid double-counting an IB-anchored month; when the
anchor is pflegegrad-derived the shift is pure loss (drops real accrual months).

**How to apply:** for a prior-year IB the shift is a no-op regardless (afterYear <
current allocStartYear), so gating it changes nothing there; the observable fix is
only for CURRENT-year mid-year Startwert on a pflegegrad-anchored customer.

**Display:** BudgetLedgerSection derives attributedUsed = max(0, allocated -
available), expiredUsed = totalUsed - attributed, and splits the card into
"Davon X verbraucht" + amber "+ Y aus verfallenem Übertrag" so expired-carryover
consumption never reads as over-budget. Client-only, no DTO change.
