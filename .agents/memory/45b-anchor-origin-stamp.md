---
name: §45b/budget anchor — resolveBudgetAnchor exists but is NOT wired into pot math
description: a pure runtime anchor rule (resolveBudgetAnchor) exists as a tested SSoT, but deliberately drives NONE of the §45b/§45a/§39 pot calculations; the legally-correct per-pot anchor handling is left untouched. Do not wire the rule into the readers.
---

# §45b/budget anchor — SSoT rule kept inert on purpose

`shared/domain/budget/budget-anchor.ts → resolveBudgetAnchor(careLevelHistory, today)`
is a pure, unit-tested rule (`tests/budget/budget-anchor.test.ts`). It computes
`max(earliest pflegegradSeit, Jan-1 of today's year)`, never shifts on a PG
*change* (always earliest PG), `null` if no PG history.

**It is intentionally wired into NOTHING in production.** All four budget readers
in `server/storage/budget/allocation-storage.ts` (§45b `calculateAllocated45b`,
§45a `umwandlung_45a`, §39 `ersatzpflege_39_42a`, and the §45b carryover) and the
budget routes / customer-creation helper keep their **original, legally-correct**
anchor handling:
- §45a / §39 read the raw `preferences?.budgetStartDate` (ungekappter
  Pflegegrad-Beginn), with their existing initial-balance / Jan-1 fallbacks.
- §45b reads `preferences?.budgetStartDate` and only floors it to the current year
  via `floorAutoAnchor45bToCurrentYear` when origin === `derived_pflegegrad`
  (see `45b-onboarding-baseline.md`).
- `PUT /preferences` may still write `budgetStartDate` / `'manual'` origin; the
  delete/reset paths do NOT audit-log a `budget_anchor_reset` action.

**Why (the trap that got reverted):** an earlier attempt wired
`resolveBudgetAnchor` into all four readers + the write sites. Its `max(…, Jan-1)`
floor is correct for the §45b auto-anchor but is **wrong for §45a/§39** (they need
the uncapped Pflegegrad start) and for §45b accrual edge cases — it broke ~18
budget tests across all three pots. The user explicitly chose the SAFE path: keep
the §45b/§45a/§39/§4Nr16 calculations exactly as-is and leave the rule unused.

**How to apply:**
- Do NOT replace `preferences?.budgetStartDate` reads in the pot readers with
  `resolveBudgetAnchor`. There is NO single floored anchor that is correct for all
  three pots simultaneously — §45a/§39 are uncapped, §45b is year-floored.
- If a future task (the budget-anchor unification follow-ups) wires the rule in,
  it must do so PER POT with pot-specific capping, not one shared floored value,
  and re-run the full budget suite (§45b accrual, §45a/§39 overview, historization,
  task-1143 accumulation) before trusting it.
- The persisted `customer_budget_preferences.budget_start_date(_origin)` column and
  the `'manual'` origin enum value remain live (baseline behavior); they are read
  by the §45a/§39/§45b paths as before.
