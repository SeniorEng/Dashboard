---
name: §45b prior-year initial-balance API guard
description: The §45b initial-balance route rejects prior-year stichmonate; tests that need a prior-year §45b initial_balance must seed via the storage layer, not the API.
---

# §45b prior-year initial-balance guard vs. test setup

The `POST /:customerId/initial-balance/entlastungsbetrag_45b` route rejects any
`validFrom` whose year is before the current year (400, code
`BUDGET_45B_PRIOR_YEAR_INITIAL_BALANCE`). Such amounts are legally a carry-over
(Übertrag aus Vorjahr, expires 30.06.), not a permanent Startwert. The guard is
**§45a/§39-exempt** and lives only at the route (and the admin UI), **not** in the
storage layer.

**Why:** prior-year §45b "Restguthaben" is rechtlich ein Übertrag; entering it as a
Startwert mis-models the budget. The storage layer stays open so migration/backfill
(epoch sentinel) and superadmin/historical-correction tooling keep working — and so
existing prior-year rows are NOT migrated away.

**How to apply:**
- Integration tests that genuinely need a prior-year §45b `initial_balance` to exist
  (e.g. testing the §959 prior-year→carryover roll / anti-double-count) must seed it
  **directly via `upsertInitialBalanceAllocation`** (dynamic import of
  `server/storage/budget/allocation-storage`) — the preserved correction path — not
  via `apiPost` to the route. See `tests/helpers/budget-scenarios.ts`
  `seed45bInitialBalanceDirect` for the established pattern.
- Tests that just exercise the initial-balance CRUD API (set/list/delete) should use a
  **current-year** `validFrom` (e.g. `${new Date().getFullYear()}-01`).
- When seeding via storage without preferences, the §45b auto-renewal anchor falls back
  to the earliest `initial_balance.validFrom` (allocation-storage), so it resolves the
  same anchor the route would have set — math in downstream assertions stays equivalent.
