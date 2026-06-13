---
name: Test-data backlog & purge performance
description: Why the dev test suite can grind to a halt, and how the test-data cleanup scales.
---

# Test-data cleanup scales as O(n) transactions and chokes on big backlogs

`runTestDataCleanup()` (server/services/test-data-cleanup.ts) purges via
`purgeCustomerCascade(id)` — **one DB transaction per customer**. On a large
accumulated backlog (observed ~20k stale test customers, ~11k with appointments)
this takes far longer than any test/tool timeout and never completes.

**Why it matters:** `tests/globalSetup.ts` purges the stale backlog before every
run. When the backlog is huge, globalSetup hangs, the `Start application` server
restarts mid-purge, and the whole `test` workflow can never reach individual test
files. The backlog grows unbounded when runs are killed before their afterAll
cleanup (and the periodic safety scheduler isn't keeping up in dev).

**How to recover fast:** a **batched set-based** purge clears it in seconds, not
hours. Mirror `purgeCustomerCascade`'s order but operate on id-batches with one
transaction per batch (detach NO-ACTION FK refs — invoices/appointments
self-refs, qonto/payment_advice matched_invoice_id,
invoice_line_items.appointment_id, customer_budget_recipients — then delete;
everything else cascades). Use the exact `CUSTOMER_TEST_FILTER` / `PROSPECT_TEST_FILTER`
/ `USER_TEST_FILTER` from the service so only test-pattern rows are ever touched.

**Trap — budget_transactions.appointment_id must be DELETED, not NULLed:** the
CHECK `budget_transactions_appointment_required_check` FORBIDS NULL appointment_id
for `consumption`/`reversal` rows. So the old "NULL the appointment_id before
deleting the appointment" step throws on any customer that actually consumed
budget — i.e. exactly the realistic test customers. In every customer-cascade
mirror (`purgeCustomerCascade` + `purgeCustomerCascadeBulk` in
server/services/test-data-cleanup.ts, and the raw-SQL one in
server/scripts/cleanup-test-data.ts) DELETE the customer's budget_transactions
rows instead of NULLing their appointment_id. The teardown path that hits this is
`/test-cleanup/purge-customers` → `purgeTestCustomersBulk` → `purgeCustomerCascadeBulk`.

**Caution:** the test-user purge does `ALTER TABLE audit_log DISABLE RULE
audit_log_no_delete/no_update` and re-enables in a `finally`. If the process is
hard-killed (SIGKILL) mid user-purge, the rules can be left DISABLED. After any
killed purge, re-check `pg_rewrite.ev_enabled` for `audit_log` ('O' = enabled).

**Verifying a global-purge test:** any assertion on *global* test-data counts is
racy if a second vitest process (e.g. the `test` workflow) mutates shared test
data concurrently. The integration project is single-process/sequential, so it's
fine in-suite — but verify a single file in isolation with no other vitest
running, or assert deltas + your own seeded ids rather than global == 0.
