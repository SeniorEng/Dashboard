---
name: Prod big-bang catch-up publish of staged budget_ledger removal
description: Why publishing a long-deferred staged DDL migration (budget_ledger drop) to a far-behind prod via Replit Publish was data-safe, and how that was verified.
---

# Big-bang Publish of the staged budget_ledger → budget_transactions migration

When prod has skipped many publishes, a staged DDL migration (designed for
incremental rollout) lands all at once through Replit's Publish schema-diff.
Verify it's safe instead of assuming — and instead of fearing the "prod is N
stages behind" framing.

**What was actually true (verified read-only against the live prod replica + the prod backup):**
- Despite prod being "pre-Stufe-A", the real dev↔prod schema diff was *tiny*: drop table `budget_ledger`, drop column `budget_reservations.captured_ledger_id`, add empty table `prices`. Nothing else dropped (69 tables both sides).
- `budget_ledger` was a fully **redundant** mirror in prod: every one of its rows had a matching `budget_transactions` row (match on customer_id, budget_type, transaction_date, amount_cents, appointment_id IS NOT DISTINCT FROM) ⇒ dropping it loses zero financial data.
- The new capture link `captured_transaction_id` has **no backfill anywhere** in the codebase. So historical captured reservations get NULL regardless of incremental-vs-big-bang. The conservation check **explicitly treats NULL `captured_transaction_id` as non-violation** (it filters `IS NOT NULL` before divergence checks). ⇒ big-bang end state == intended incremental end state.
- The project's startup DDL migrations (ensure-…/drop-budget-ledger) are idempotent `IF [NOT] EXISTS`, so after the Publish flow applies the diff they no-op at boot — no conflict.

**Why:** the fear was that Publish drops the old table at provision *before* the app's startup data-migration can move data over (GoBD loss). That fear only materializes if (a) the old table holds unique data, or (b) a startup backfill needs the old table/column. Here neither held, so the drop was safe.

**How to apply:** Before submitting a Publish whose diff drops a table/column on a far-behind prod: (1) confirm the dropped table's rows are already represented in the surviving SoT table (read-only prod SELECT), (2) check whether any startup migration *backfills* into a column the diff would strand — if no backfill exists, NULL is the same outcome either way, (3) confirm consumers (conservation/readers) tolerate the post-drop state. Always answer the Replit rename prompt "No, create new table" for genuinely unrelated tables — never "Yes, rename". Have a verified backup first.

## Re-armed gated drop (default-OFF flag)

The `budget_ledger` drop is wired as a **gated startup data-migration** (ledger name `drop-budget-ledger-1443`) behind the env flag `APPROVED_DROP_BUDGET_LEDGER` (parsed `/^(1|true)$/i`, Deployment/Production scope). Flag UNSET ⇒ the migration is *registered but skipped* (clean boot no-op, no DDL); flag SET ⇒ it runs once via the guarded runner inside a tx (FK-safe two-step: drop `budget_reservations.captured_ledger_id`, then drop table `budget_ledger`). So the drop is **ready to fire on a future publish** without code changes — only the flag flip.

**Permanent-mismatch-in-dev is intended:** the same drop has a descriptor in the pending-destructive-migrations preflight whose `countPending` returns 1 *while the `budget_ledger` table still exists* (it does in dev/test via the INTERIM schema marker). With the flag unset that descriptor is always `mismatch` ⇒ a loud `PREFLIGHT-WARNUNG` fires at every dev/test boot and on `/api/health`. This is the deliberate anti-silent-no-op safety net (same pattern as `cleanup-legacy-auto-allocations-1409`), NOT a bug. Any preflight test that asserts aggregate `status.ok` must set `APPROVED_DROP_BUDGET_LEDGER` for its scope to neutralize this entry.

**Post-drop only (do NOT do pre-drop):** reverting the INTERIM schema marker on `budgetLedger` + re-arming the schema-drift test's DROP assertion + removing `budget_ledger` from the schema-table allowlist are explicitly *after the prod drop actually fires*. Until then the drift test stays SUSPENDED and the table stays in the allowlist.

**Why:** the lesson from earlier silent-no-op traps is that a gated destructive migration that quietly does nothing when its flag is missing in the wrong scope is dangerous. Surfacing it loudly (boot log + health) makes a mis-scoped flag impossible to miss, at the cost of expected dev-boot noise until the drop is executed and the markers are reverted.
