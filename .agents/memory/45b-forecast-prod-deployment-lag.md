---
name: §45b forecast prod symptom — deployment-lag vs served-assembler bug
description: A negative §45b "Verfügbar nach Planung" in PROD has TWO possible causes — an old deployed build (lag) OR a real bug in the SERVED assembler. Reproduce via the served path, not just the isolated readers.
---

# §45b Forecast: same prod symptom, two distinct root causes

A negative §45b „Verfügbar (nach Planung)" reported on LIVE (typical shape: a
carryover still valid at the month horizon + a small Startwert + one H1
consumption booked against the carryover, all open appts inside that month, yet
shown as a negative remainder) can come from **either** of two unrelated causes.
Do not stop at the first.

## Cause 1 — deployment lag (old asymmetric forecast math)
The classic shape is the signature of the OLD asymmetric forecast: projected
month-end allocation dropped the still-valid carryover/Startwert while the H1
consumption against it stayed, double-charging the pot. That was fixed: forecast
allocation + consumption-exclusion both come from the ONE SSoT
`netAvailable45bAt(..., {projectFuture:true})`. If current repo code yields the
correct **positive** value for the exact prod data ⇒ classify as deployment lag,
re-publish, no new logic.

## Cause 2 — served assembler leaks the §45b monthly cap into the forecast
The §45b path is assembled by TWO layers: the isolated reader
(`getBudgetSummary`) **and** the served merge (`getAllBudgetSummariesServed` →
`mergeServed45b`). The unified reader intentionally monthly-caps
`pot.availableCents` to the per-customer §45b monthly limit (a deliberate hard
THIS-MONTH booking cap where display==booking). `mergeServed45b` then shifts the
year-horizon `availableAfterPlannedCents` by a delta — and that delta MUST be
derived from the **uncapped** pot remaining
(`pot.allocatedCents − pot.consumedNetCents`, the same expression legacy uses
for `signedAvailable`), so it reduces to the manual_adjustment exclusion (plus,
in post-carryover-expiry windows, the symmetric carryover-expiry exclusion). If
the delta is taken from the monthly-**capped** `pot.availableCents`, the (large)
monthly-cap subtraction contaminates the year horizon and the forecast flips
falsely negative — even though `getBudgetSummary` alone is correct.

**Why:** a per-customer §45b monthly limit makes the served `availableCents`
(this-month cap) and the legacy `availableCents` (yearly pot) diverge by a large
amount; the merge was originally written assuming the only divergence was the
small manual_adjustment exclusion. Customers with a §45b monthly limit are the
trigger.

## How to apply (before re-investigating from a prod screenshot)
1. Pull the customer's §45b type-settings (incl. `monthlyLimitCents`),
   allocations, transactions, and open-appt dates read-only from prod
   (`PROD_DATABASE_URL` + `pg`, `BEGIN TRANSACTION READ ONLY`).
2. Reproduce in DEV by seeding that exact data and calling **both**
   `getBudgetSummary` AND `getAllBudgetSummariesServed` at the same asOfDate.
3. If `getBudgetSummary` is positive but `getAllBudgetSummariesServed` is
   negative ⇒ it's the served-assembler bug (Cause 2), not deployment lag. A
   regression test that only drives the isolated readers will NOT catch it — it
   must drive `getAllBudgetSummariesServed`.
4. Only classify as deployment lag (Cause 1) when BOTH paths are correct on
   current code for the real prod data.
