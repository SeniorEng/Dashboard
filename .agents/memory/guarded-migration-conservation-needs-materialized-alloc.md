---
name: Guarded budget migrations need materialized allocations
description: Why conservation-guarded budget migrations/tests trip on §45b projection-only funding, and how to fund pots so the no-overdraw guard passes
---

# Conservation guard vs §45b projection-only funding

`runGuardedBudgetMigration` (server/startup/budget-migration-runner.ts) wraps any
budget-mutating migration in a pre/post no-overdraw check
(server/lib/budget-conservation.ts): per (customer, pot), `netConsumed` must be
`<= SUM(budget_allocations.amountCents)`. The check counts only **materialized**
`budget_allocations` rows; `UNCAPPED_POTS = {private, selbstzahler}` are excluded.

§45b availability is computed by FIFO **projection** of future monthly accruals,
NOT by materialized allocation rows. So a §45b pot can have available budget the
engine will happily book against while `budget_allocations` shows allocated=0. A
migration that books such consumption then trips the conservation guard
(`BudgetConservationViolationError`, e.g. `<custId>|entlastungsbetrag_45b`) and
the whole migration rolls back.

**Why this bites in tests:** the `/api/budget/:id/initial-budget` endpoint
**silently rejects (400)** a §45b `currentMonthAmountCents` above the statutory
start-value cap (≈ 131 €/eligible month, `max45bStartValueCents`). Test helpers
that don't assert the response status (e.g. funding with 500000) end up with NO
materialized §45b allocation; the booking still succeeds via projection, but the
guard sees allocated=0 vs consumed>0.

**How to apply:**
- When a test/migration must pass the conservation guard, fund capped pots with a
  materialized allocation **within** the statutory cap and ASSERT the
  initial-budget POST returned 200/201.
- §45b: 13100 (one eligible month) is always within cap; keep appointment cost
  below it (e.g. travelKilometers=0, 60-min HW) so allocated >= consumed.
- Production §45b backfills passed the guard because real data already had
  materialized monthly allocations — a fresh ephemeral test DB does not.
- Alternatively route consumption to an uncapped private/selbstzahler pot (guard
  excludes it), but that doesn't exercise the capped-pot invariant.
