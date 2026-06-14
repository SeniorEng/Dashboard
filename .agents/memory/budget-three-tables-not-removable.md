---
name: budget_reservations + budget_migrations are live infra; budget_ledger was removed (staged)
description: Why budget_reservations / budget_migrations cannot be dropped, and how budget_ledger was correctly decommissioned in stages (A→B→C).
---

# budget_reservations / budget_migrations are NOT dead shadow tables (budget_ledger was removed)

A recurring "simplification" idea was to delete the budget_* side tables and point
GoBD immutability directly at `budget_transactions`, treating them as toxic shadow
copies. The read-only reference analysis (`docs/budget-ledger-removal-analysis.md`)
showed two of them are **productive and not replaceable by `budget_transactions`**:

- **`budget_reservations`** — read on EVERY budget-availability computation
  (`unified-reader.ts` `activeHoldsCents()` queries `state='hold'` for all three
  statutory pots), independent of the feature flag. Holds are a distinct
  operational concept (planned/not-yet-consumed), deliberately non-GoBD. PERMANENT.
- **`budget_migrations`** — once-only guard for budget data migrations
  (`budget-migration-runner.ts`); orthogonal to `budget_transactions`. PERMANENT.

**`budget_ledger` HAS been removed (Stufe C, Task #1274).** It was the last pure
mirror of `budget_transactions` (capture-insert in the hard-hold path). Removal was
done **only** via a staged sequence, never a big-bang drop, with the hard-block path
staying sharp the whole time:

1. **Stufe A** — add `budget_reservations.captured_transaction_id` linking each
   captured reservation back to its `budget_transactions` source (dual-link).
2. **Stufe B** — move GoBD immutability + conservation/invariants onto
   `budget_transactions` (it becomes the ONE append-only finance layer).
3. **Stufe C** — drop the now-redundant mirror table `budget_ledger` AND the old
   second link `budget_reservations.captured_ledger_id`, via idempotent raw SQL
   (`server/startup/drop-budget-ledger.ts`), NOT `drizzle-kit push`. Drop the FK
   column first, then the table. The append-only guard was retargeted from
   `budget_ledger` to `budget_transactions`
   (`tests/architecture/budget-transactions-write-path.test.ts`): a direct
   `update/delete(budgetTransactions)` or raw `UPDATE/DELETE budget_transactions`
   is a violation UNLESS the same file sets the `app.allow_gobd_mutation` bypass
   GUC (the audit-pflichtige correction path).

**Why this was a behavioral change, not just cleanup:** `budget_ledger` +
`budget_reservations` were the Phase-5 hard-hold layer, gated by `BUDGET_HARD_HOLDS`
(enabled in production, see `budget-hard-holds-prod-cutover.md`). Stufe B/C kept the
holds-read (`budget_reservations`) and the hard-block engine fully intact; only the
mirror table and its dead second link were removed.

**The facade trap (still true):** `budgetLedgerStorage` / `BudgetLedgerStorage` /
`server/storage/budget-ledger.ts` is the central budget FACADE (~90 imports) over
`budget_transactions`, NOT the dropped `budget_ledger` table. It was deliberately
left untouched. Only count real Drizzle/raw-SQL access to the schema objects
`budgetReservations` / `budgetMigrations` when reasoning about table usage.
