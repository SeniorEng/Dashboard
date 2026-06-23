---
name: §45b forecast prod symptom vs deployment lag
description: When a §45b "Verfügbar nach Planung" negative-value bug is reported in PROD but current code + prod data are clean, suspect an older deployed build, not a new logic defect.
---

# §45b Forecast: Prod-Symptom ≠ neuer Code-Bug

A negative §45b „Verfügbar (nach Planung)" reported on the LIVE site (typical
shape: a carryover still valid at the month horizon + a small Startwert + one H1
consumption booked against the carryover, all open appts inside that month, yet
shown as a negative remainder) is the **signature of the OLD asymmetric forecast
math** — projected month-end allocation dropped the (still-valid-at-horizon)
carryover/Startwert while the H1 consumption against it stayed, double-charging
the running pot.

That asymmetry was already fixed: forecast allocation and consumption-exclusion
windows must come from the ONE SSoT `netAvailable45bAt(..., {projectFuture:true})`
(symmetric carryover-expiry exclusion). Current repo code computes the correct
**positive** value for that exact data.

**Why:** the live symptom persisted *after* the fix was merged because the
deployed build predated it — a deployment-lag, not a new defect. Re-deriving a
"new" fix would have been wasted work on already-correct code.

**How to apply:** before re-investigating a §45b forecast bug from a prod
screenshot:
1. Pull the customer's §45b allocations + transactions + open-appointment dates
   read-only from prod (`PROD_DATABASE_URL` + `pg`, `BEGIN TRANSACTION READ ONLY`).
2. Reproduce against DEV by seeding that exact data and calling the REAL
   `calculateAllocatedCents` / `netAvailable45bAt` / `getBudgetSummary`.
3. If current code yields the correct value and prod data is clean ⇒ classify as
   **deployment lag → re-publish**, no prod data change, no new logic. Only chase a
   code fix if the reproduction is actually negative.
