---
name: §45b forecast signed-available SSoT
description: How the §45b "Verfügbar nach Planung" forecast must read availability from the SSoT, and where the #1340 carryover-exclusion lives.
---

# §45b forecast must read raw signed-available from netAvailable45bAt

The two §45b forecast projection loops in `server/storage/budget/summary-queries.ts`
(`getBudgetSummary` + `getMonthlyBudgetFitByAppointment`) derive their per-month
availability from the SSoT:

    netAvailable45bAt(customerId, monthEnd, { projectFuture: true, holds: "ignore", typeSettings })
    signedAvailable = net.allocatedCents − net.consumedNetCents   // raw, can go negative

**Rule:** use the raw `allocatedCents − consumedNetCents`, NOT the 0-floored
`net.availableCents`. Use `holds: "ignore"` because the forecast counts the
planned costs itself (cumulativePlanned), so subtracting live holds too would
double-count.

**Why:** the forecast must surface a real shortfall as a negative balance
(Alrik-gate #95). The 0-floor hides over-planning. `holds:"ignore"` keeps
`holdsCents` visible in the composition but not subtracted from availability.

**Where the carryover-expiry logic lives:** the #1340 carryover-expiry exclusion
(dropping an expired prior-year carryover from BOTH allocation and the H1
consumption booked against it, across the July boundary) + the floor live ONLY
inside `netAvailable45bAt` / `computeNetAvailable45b` (shared/domain). Do NOT
re-hand-roll `allocAtEnd − (cumulativeUsed − excluded)` with
`getExcluded45bConsumption` in summary-queries — an arch test
(`tests/architecture/budget-single-reader.test.ts`) guards both: summary-queries
is on `ALLOWLIST_45B`, and a scoped negative guard fails if it ever calls
`getExcluded45bConsumption(` again. `getExcluded45bConsumption` stays legitimate
in `consumption-engine.ts`.

**How to apply:** any new §45b availability surface (display or write) goes
through `netAvailable45bAt`; pick `holds` by whether the caller separately
accounts for planned/held amounts. §45a/§39 are a different SSoT
(`computeCapSlot`) and have no per-month forecast loop.
