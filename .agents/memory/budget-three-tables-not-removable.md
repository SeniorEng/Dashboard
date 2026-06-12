---
name: The three budget_* tables are live infra, not removable shadow tables
description: Why budget_ledger / budget_reservations / budget_migrations cannot be dropped in favor of budget_transactions.
---

# budget_ledger / budget_reservations / budget_migrations are NOT dead shadow tables

A recurring "simplification" idea is to delete these three tables and point GoBD
immutability directly at `budget_transactions`, treating them as toxic shadow
copies. The read-only reference analysis (`docs/budget-ledger-removal-analysis.md`)
showed all three are **productive and not replaceable by `budget_transactions`**:

- **`budget_reservations`** — read on EVERY budget-availability computation
  (`unified-reader.ts` `activeHoldsCents()` queries `state='hold'` for all three
  statutory pots), independent of the feature flag. Holds are a distinct
  operational concept (planned/not-yet-consumed), deliberately non-GoBD.
- **`budget_ledger`** — GoBD-immutable capture target of the hard-hold engine
  (`captureHolds` `.insert(budgetLedger)`) AND the data source of the
  conservation/invariants checks (`budget-conservation.ts` → CLI scripts,
  `GET /api/admin/invariants-report`, and the budget-migration-runner pre/post
  guard). Runs in PARALLEL to the legacy `budget_transactions` SSoT.
- **`budget_migrations`** — once-only guard for budget data migrations
  (`budget-migration-runner.ts`); orthogonal to `budget_transactions`.

**Why removal is a behavioral rollback, not cleanup:** `budget_ledger` +
`budget_reservations` are the Phase-5 hard-hold layer, gated by `BUDGET_HARD_HOLDS`
which is **enabled in production** (see `budget-hard-holds-prod-cutover.md`).
Dropping them = decommissioning a live prod feature, which needs an explicit
product decision first (flag off in prod → remove engine + holds-read + capture →
move conservation/invariants onto `budget_transactions` → only then drop tables).

**The facade trap:** `budgetLedgerStorage` / `BudgetLedgerStorage` /
`server/storage/budget-ledger.ts` is the central budget FACADE (~90 imports), NOT
the `budget_ledger` table. Only count real Drizzle/raw-SQL access to the schema
objects `budgetLedger` / `budgetReservations` / `budgetMigrations` when reasoning
about table usage.

**Alrik's refinement (the "härten, Ledger entfernen" review):** Of the three,
ONLY `budget_ledger` is a future removal candidate, and only via a SEPARATE,
STAGED ticket — never a big-bang drop:
1. add `capturedTransactionId` linking ledger rows back to their `budget_transactions` source,
2. dual-write + backfill,
3. move the conservation/invariants gate onto `budget_transactions`,
4. only then drop `budget_ledger` — and the hard-block path must stay sharp the whole time.
`budget_reservations` (live holds read on every availability calc) and
`budget_migrations` (once-only migration journal) are PERMANENT — not removal
candidates at all.

**C-02 (silent cascade-reconcile skip) decision:** the cascade-end reconcile's
"deeper inconsistency, do not auto-correct" branch (Σ leg-field Δ ≠ 0) now emits a
best-effort audit_log entry (non-tx, never rolls back the booking; observability
only) instead of a bare `return`. The append-only-on-`budget_transactions`
triggers and the direct-SQL negative-proof test were explicitly DE-SCOPED by
Alrik to the future staged ledger ticket — do NOT re-add them as part of the same
work.
