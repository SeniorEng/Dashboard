---
name: §45b Juli-Boundary Allocated/ConsumedNet symmetry
description: why §45b Allocated and ConsumedNet must drop the same pots in lockstep, or the current-year pot is double-charged after expiry/supersession
---

# §45b Allocated/ConsumedNet must be symmetric across pot drop-out

When `calculateAllocated45b` drops a special allocation from `Allocated` (an
expired prior-year carryover after 30.06., or a prior-year `initial_balance`
superseded by the current-year IB-floor in H2), the consumption that was booked
AGAINST that dropped pot in H1 must ALSO be removed from `ConsumedNet`.

**Why:** otherwise the reader keeps subtracting that H1 consumption while the pot
it belonged to is already gone, so the deduction silently lands on the running
current-year accrual → the current-year pot is double-charged. Symptom: pure §45b
Pflegekasse customers (NOT Selbstzahler) with an expiring carryover get a false
BUDGET_HARD_BLOCK in July; reader undercounts (real ~786 € shown as ~113 €).

**How to apply:** `calculateAllocated45b` returns the set of dropped special
allocation IDs (`excludedSpecialAllocationIds`); a shared helper
(`getExcluded45bConsumption`) sums the net consumption (consumption+write_off −
reversal, txDate<=asOfDate) booked against exactly those IDs. BOTH read paths
subtract it in lockstep: the overview reader (`unified-reader.ts`,
`consumedNet = max(0, raw − excluded)`) AND the booking engine
(`consumption-engine.ts`, filter excluded IDs out of `specialAllocations` and
subtract `excludedConsumedNetCents` from `totalNetConsumed`). Keep it one SSoT —
overview must equal booking. FIFO consumes special pots (carryover priority 0,
then IB by validFrom) BEFORE the general null-allocationId accrual, so small H1
consumption binds to the carryover and lands in the excluded set in July.

The drop is date-windowed: in June the carryover is still valid and the H1 IB
floor still counts the prior-year IB, so the excluded set is EMPTY and consumption
is deducted normally — do not over-correct at the June side of the boundary.

Regression test: `tests/budget/45b-july-boundary-symmetry.test.ts` (uses a
no-consumption control customer as the source of truth for the uncollapsed July
accrual instead of hardcoding month×monthly — the carryover shifts allocStart so
the accrual is not simply 7×monthly).

## Same symmetry also required in the "Verfügbar nach Planung" forecast

`getBudgetSummary` (`server/storage/budget/summary-queries.ts`) projects future
months with `calculateAllocatedCents(..., {projectFuture:true})`, which already
drops the expired carryover from `allocAtEnd` for months after 30.06. But the
consumption booked against that carryover stayed in `cumulativeUsed`/`netUsedCents`
→ same double-charge as the readers, surfacing as false negative
`availableAfterPlannedCents` / bogus `plannedShortfallMonth`.

**How to apply:** `getExcluded45bConsumption` takes an `opts.projectFuture` flag
that MUST match the `projectFuture` of the paired allocation call (else the
allocation window and the exclusion window drift). The forecast loop subtracts the
per-month `excludedConsumedNetCents` from `cumulativeUsed` (`remaining = allocAtEnd
− (cumulativeUsed − excludedConsumedNetCents)`) and tracks `excludedAtHorizon` so
`projectedAvailable = allocAtHorizon − (netUsedCents − excludedAtHorizon) −
futurePlannedTotal`. Default `projectFuture` (undefined) keeps the
reader/booking-path behaviour unchanged. Regression test:
`tests/budget/45b-forecast-carryover-symmetry.test.ts` (consumed-vs-control pair,
June no-over-correction guard, real-July-shortfall-still-flagged guard).

### There are TWO forecasts — both need the exclusion (recurring trap)

§45b has two independent "available after planning" projections that BOTH derive
`allocAtEnd − consumed` and so BOTH must subtract the exclusion in lockstep:
- the topf-level summary forecast (`getBudgetSummary`), and
- the per-appointment marker (`getMonthlyBudgetFitByAppointment`, the
  `fitsInMonthlyBudget` field).

The first round of this fix patched only the topf-level forecast; the
per-appointment marker still did naive `allocAtEnd − cumulativeUsed` → July
appointments were falsely flagged `fitsInMonthlyBudget:false`. The marker now
precomputes an `excludedByMonth` map (same `getExcluded45bConsumption(monthEnd,
{projectFuture:true})`) keyed by `YYYY-MM` and subtracts it per appointment. When
touching either forecast, fix BOTH or the asymmetry returns.

### Full consolidation onto one availability fn is deliberately DEFERRED

**Why:** the obvious "one `netAvailable45bAt` for reader + both forecasts" cleanup
is NOT safe to do as a side effect, because the two layers compute "used"
differently on purpose: the forecasts' `netUsedCents` INCLUDES `manual_adjustment`
and ignores holds, while `unified-reader`'s `netConsumedUpToDate` EXCLUDES
`manual_adjustment` and subtracts active holds. Merging them would silently change
accounting/GoBD-relevant forecast numbers in edge cases (existing tests have no
such corrections/holds, so they would NOT catch it). This is the deferred "Phase 6"
manual_adjustment shadow drift. **How to apply:** keep the per-forecast exclusion
fix as the durable guarantee; only consolidate as its own approved task with a
shadow-mode cent-diff over real customers signed off first.
