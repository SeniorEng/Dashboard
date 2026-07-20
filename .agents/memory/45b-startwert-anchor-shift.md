---
name: §45b Startwert = Reset/Re-Baseline (nicht additiv)
description: A §45b "Startwert (Restguthaben)" reported at month M REPLACES all accumulation ≤ M (new baseline); only months after M keep accruing. Consumption before M must not be double-subtracted.
---

The §45b "Startwert (Restguthaben)" (an `initial_balance` allocation row) is a
RESET / re-baseline, NOT an additive top-up. The LATEST §45b Startwert whose
month-start ≤ the read's `asOfDate` (month M) becomes the new baseline for the
pot: it replaces ALL accumulation ≤ M (monthly accruals AND carryovers). Only
months AFTER M keep accruing (clamped to the yearly statutory max).

**Model:** available(N≥M) = Startwert(M) + Ansammlung(M+1…N) − Verbrauch(≥M) −
geplant(≥M).

**Where (calculateAllocated45b, server/storage/budget/allocation-storage.ts):**
- Reset month M = latest active `initialBalanceMonths` row with month-start ≤
  `resetDateLimit` (= `opts.asOfDate`), computed AFTER all allocStart shifts
  (expiryFloor/carryover) to avoid the expiryFloor collision that reset
  allocStartMonth→1. Gated on `opts.year == null` (NOT in `{year}` pool mode).
- `enumStart = max(allocStart-after-all-shifts, M+1)` is passed to
  `enumerate45bStatutoryMonths` as a LOCAL var — never mutate the shared
  `allocStart`.
- `ibCounted` additionally requires `hasReset && a.year===resetYear &&
  a.month===resetMonth` so ONLY the latest Startwert is the baseline; earlier
  IBs auto-fall into `excludedSpecialAllocationIds`.
- `Allocated45bResult.resetCutoffDate` (= `${M}-01`, else null) is consumed by
  `getExcluded45bConsumption`, which net-excludes consumption where
  `allocationId IN excludedIds OR transactionDate < resetCutoffDate` in ONE
  OR'd query (dedup) — so pre-reset consumption is never double-subtracted.
  Symmetric across unified-reader + consumption-engine (both call it).

**Why:** a reported remaining balance at M already reflects everything spent
before M; adding the full pflegegrad-anchored accrual on top (old #1766 additive
behavior) overstated the pot (prod: 835,68 € Startwert from July showed as
1.621,68 € at anchor 01/2026).

**How to apply:** backdated reads BEFORE M see no reset (Startwert not yet
effective) → normal accrual up to that date. `{year}` pool mode (carryover
computation) is out of scope — keep allocStart there. Do NOT re-introduce the
old additive `anchorFromInitialBalance` allocStart-shift or expect the full
7×131 € accrual after a mid-year Startwert.

**Display coherence caveat:** overview `totalAllocatedCents` reflects the reset,
but legacy `totalUsedCents` still sums ALL consumption (not excluding pre-reset);
only served `availableCents` is corrected via the unified reader (same pattern as
the #1340 carryover exclusion). Assert on `availableCents`, not `allocated −
used`. BudgetLedgerSection labels the pre-reset consumption line accordingly.
