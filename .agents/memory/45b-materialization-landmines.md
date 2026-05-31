---
name: §45b materialization double-count landmines
description: Hidden row-consumers that make persisting statutory_monthly §45b rows a coordinated, atomic change — read before continuing Task #872 Phase 2.
---

§45b monthly top-ups have historically been **virtual** (computed month-by-month in
`calculateAllocated45b`, never persisted). Materializing them as real
`budget_allocations` rows with `source='statutory_monthly'` is NOT additive — several
paths blind-sum or list ALL allocation rows and would double-count or double-display.

**The rule:** switching §45b from virtual to materialized rows must be ONE atomic change
that updates every consumer in lockstep, then verified against the full budget + statistics
+ equality suites. Do not persist statutory_monthly rows while `calculateAllocated45b`
still virtually walks the same months.

**Why (the landmines, from the audit):**
- `server/storage/statistics/budgets.ts` (`aggregateForYear`, `getBudgetStats` CTE) does a
  blind `SUM(amount_cents)` over all rows for a year — it would now include statutory_monthly
  rows (it previously excluded virtual §45b entirely, i.e. it *under-counted*). New rows change
  statistics output.
- `getBudgetAllocations` (`/allocations` listing) returns all rows to the frontend → UI would
  show both the virtual summary and the new rows.
- `calculateAllocated45b` builds its skip-set from `source='initial_balance'` only; the
  consumption-engine FIFO filter is `source IN ('carryover','initial_balance','manual_adjustment')`.
  Both must be taught about statutory_monthly when it becomes real.

**How to apply:** equality is guaranteed only if SUM(statutory_monthly rows for past+current,
validFrom=month-start) reproduces the legacy enumeration at every asOfDate/year. Reconcile rows
to the pure enumerator (`shared/domain/budget/statutory-45b.ts`) — it is both the materializer
source and the backfill reconciliation oracle. Carryover shifts allocStart forward (condensing
pre-year months into one carryover amount), so pre-carryover-year statutory rows must be
soft-deleted (GoBD bypass `SET LOCAL app.allow_gobd_mutation='on'`) or excluded by the live
window, or the carryover-no-pre-year-double-count invariant breaks.
