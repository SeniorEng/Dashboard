---
name: Conservation verifier is projection-aware
description: budget no-overdraw (I13) + FIFO-equality enumerate & evaluate via the unified reader (projection), not raw budget_allocations
---

The budget no-overdraw verifier (`checkBudgetConservation` / `computePotConservation` in `server/lib/budget-conservation.ts`) and the FIFO-vs-unified equality check (`checkFifoUnifiedEquality` in `server/lib/invariants.ts`) evaluate overdraw against the PROJECTED availability from the one app reader (`readUnifiedBudgetAvailability`), NOT against summed raw `budget_allocations` rows.

**Why:** monthly/yearly statutory top-ups are no longer materialized into `budget_allocations` — they're projected at runtime. After legacy auto-allocation rows are cleaned up, a purely-projected §45b/§39 pot has zero materialized allocation rows. Reading allocated from raw rows then shows 0 (false overdraw / wrong available); enumerating the population from raw allocation rows DROPS the pot entirely and the guard goes blind ("0 overdrawn" while a real overdraw exists).

**How to apply:**
- Enumeration SSoT = exported `enumerateConservationPopulation(exec)`: population = consumption (budget_transactions) ∪ entitlement (§45b default-on for non-selbstzahler with careLevelHistory anchor; §45a/§39 only when type-settings enabled) ∪ still-materialized allocation rows. Uncapped pots (private/selbstzahler) excluded. Reuse this helper anywhere you need "which (customer,pot) pairs to check" — never re-derive the population from `budget_allocations`.
- Per candidate: call the reader once at `todayISO()`; per capped pot use `pots[pot].allocatedCents` / `.consumedNetCents`; `overdrawn = consumedNet > allocated`.
- write_off classification now lives ONLY in the reader (§45b allocation-view via `netConsumedUpToDate`; §45a/§39 window-cap view). budget-conservation.ts therefore no longer contains a `'write_off'` literal and was REMOVED from the write-off-asymmetry allowlist (`tests/architecture/budget-write-off-classification.test.ts`). That arch test fails on STALE allowlist entries too, so removing the last `'write_off'` literal from an allowlisted file requires deleting its entry AND updating the audit table in `docs/budget-ssot-inventory.md`.
- The cleanup script's dry-run shadow-diff (`simulatePostDeleteViolations`) is a no-op for legacy sources: projection ignores `monthly_auto`/`monthly`/`yearly_auto`/`statutory_monthly`, so `allocatedAfter == allocatedBefore`. The authoritative guard is the in-transaction PRE/POST check under `--apply`.
- `DbOrTx` lacks `.transaction` but the reader wants `DbClient`; cast `exec as DbClient` — both real callers (db, open Tx) have it at runtime and the reader never calls `.transaction`. Watch this if the reader ever starts relying on executor methods not guaranteed by `DbOrTx`.
