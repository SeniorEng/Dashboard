---
name: §45b/§45a/§39 budget anchor — computed at runtime PER POT from Pflegegrad history
description: There is NO persisted budget anchor anymore. Each pot derives its anchor at runtime from the earliest Pflegegrad start — §45a/§39 raw (uncapped), §45b floored to current-year Jan1. There is no single shared anchor and no 'manual' override.
---

# §45b/§45a/§39 budget anchor — runtime, per pot (Task #1204)

The budget anchor is a **pure runtime function of the Pflegegrad (care-level)
history**, recomputed on every read. There is **no persisted anchor**: the
columns `customer_budget_preferences.budget_start_date` +
`budget_start_date_origin` and the origin value `'manual'` were **removed**.

Source of truth at runtime is `earliestCareLevelStart(customerId, asOfDate)` in
`server/storage/budget/allocation-storage.ts` (earliest entry in
`care_level_history`). Each pot applies it differently:

- **§45a (`umwandlung_45a`) / §39+§42a (`ersatzpflege_39_42a`)** — read the
  **RAW** earliest Pflegegrad start, **uncapped**, with their existing fallbacks
  (initial_balance/setting anchor → `1.1.` of current year). A PG far in the past
  counts in full (these pots are uncapped).
- **§45b (`entlastungsbetrag_45b`)** — read the SAME earliest PG start but
  **floored to current-year Jan-1** via `floorAutoAnchor45bToCurrentYear`
  (`shared/domain/budgets.ts`). A date before Jan-1 is raised; a future date is
  left. Applied in BOTH `calculateAllocated45b` AND `ensureYearlyCarryover45b`,
  and the `/initial-budget` §45b write floors its Stichmonat param identically.

**Why one shared floored anchor is WRONG:** an earlier attempt unified all pots
onto one `max(earliest PG, Jan-1)` anchor — correct for §45b but wrong for
§45a/§39 (they need the uncapped PG start). Keep them per-pot.

**How to apply:**
- Never reintroduce a persisted `budget_start_date`/origin column or a `'manual'`
  override. The drift-guard `tests/architecture/budget-anchor-ssot.test.ts`
  fails if the persisted anchor returns.
- §45a/§39 read raw `earliestCareLevelStart`; only §45b floors. Keep all three
  §45b sites (read, carryover, /initial-budget write) on the same floor or the
  displayed sum and the materialized carryover rows drift apart.
- FORWARD-ONLY: existing `budget_allocations` are NOT rewritten; only future
  recomputes read the runtime anchor. Startup column drop:
  `server/startup/drop-budget-start-date-columns.ts`.
- `clampDerived45bAnchor` / `earliest45bRelevantAnchor` still exist but are
  unit-test-only helpers, NOT in the runtime path (see 45b-onboarding-baseline.md).
