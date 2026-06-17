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
