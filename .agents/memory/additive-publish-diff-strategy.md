---
name: Additive-only publish diff strategy
description: Why Replit publish breaks on dev-DB objects absent from prod, and how to keep each publish additive + data-safe.
---

Replit's "Publish" diffs the **actual dev DB ↔ actual prod DB** (introspection),
NOT the Drizzle schema TS. It applies the generated DDL **hard, in a migration
step BEFORE the app starts** — so it bypasses any runtime guard in the app's own
startup migrations.

**Two failure classes seen (both same root cause = dev-DB has an object prod
lacks, added by a conditional/idempotent startup hook):**

1. **Redundant DROP ordering** — dropping a table + its inbound FK in the same
   publish emits a `DROP CONSTRAINT` in the wrong order → publish aborts.
   Fix: keep the legacy objects in dev (restore them), defer removal to a later
   FK-free clean publish. (budget_ledger / captured_ledger_id.)

2. **CHECK/constraint validated against legacy prod rows** — a startup hook adds
   a CHECK constraint only when dev data is clean (skips on violations). After a
   dev reseed, dev HAS it, prod (with legacy rows) does NOT → publish tries to
   add it hard → "violated by some row" abort. The startup hook's skip-guard and
   its prerequisite backfill run only at app start, i.e. AFTER the failing
   migration step, so they can't help the publish.
   Fix: neutralize the startup hook call (keep the file: SQL constant + function
   + drift-guard test stay green) AND `DROP CONSTRAINT IF EXISTS` it from the
   dev DB, then restart so it isn't re-added. Defer constraint+data-remediation
   to a dedicated follow-up. (budget_transactions_appointment_required_check:
   99 legacy import rows = 51 consumption + 48 reversal w/ NULL appointment_id.)

**Verification before telling the user to publish — check BOTH directions:**
- DROPs (prod-not-in-dev) for accidental data loss.
- ADDs (dev-not-in-prod): a new CHECK/UNIQUE/FK/NOT-NULL on an EXISTING table is
  DDL-additive but can FAIL on existing prod rows. New empty tables + brand-new
  nullable columns + their FK/index/pkey are always safe.
Compare via `executeSql` (dev) vs `executeSql({environment:"production"})`
(READ-ONLY replica — strip the wrapper's `START TRANSACTION`/`ROLLBACK` lines;
GROUP-BY/`||` concat queries sometimes return only those wrapper lines on the
replica, so fall back to plain column selects).

**Always tell the user: use the normal Publish button, NEVER "Copy dev schema &
data to production".**
