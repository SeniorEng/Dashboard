---
name: One-time master-data delete must gate the seeders too
description: A one-time exactly-once cleanup of SEEDED reference rows resurrects on the next boot unless the idempotent seeders also consult the migration-ledger flag.
---

A one-time startup migration that DELETES seeded reference/master data (e.g. unused
Pflegekassen in `insurance_providers`) is NOT sufficient on its own. The idempotent
seeders that repopulate that table on every boot will RE-CREATE the deleted rows the
next time they decide the table is "empty" / "none of my known rows exist".

**Why:** The exactly-once #895 pattern (migration-ledger gate + advisory xact lock +
conservation tripwire + atomic audit log) guarantees the DELETE runs only once — but
it says nothing about the seeders. `importPflegekassen` bulk-inserts when the table is
empty; `seedPkvProviders` bulk-inserts when no known PKV name exists. If the cleanup
emptied those out (because nothing referenced them), the very next boot resurrects the
whole list, violating the user rule "delete once, never re-create".

**How to apply:** Make the SAME migration-ledger flag the single source of truth.
Export a predicate (`hasUnusedInsuranceCleanupRun()`) from the cleanup module and
AND it into every seeder's `allowInsert` (keep the explicit `forceInsert` escape
hatch). Ordering trap: on first boot the seeders run BEFORE `ensureMigrationLedger`,
so the predicate must tolerate a missing `budget_migrations` table (try/catch ->
false). In dev/test the production-gated cleanup never runs, so the flag is always
false and seeder behavior is unchanged.
