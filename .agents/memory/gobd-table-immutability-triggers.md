---
name: GoBD table immutability triggers
description: DB-side raising BEFORE triggers protecting budget/invoice tables; shared bypass GUC and which legit paths must set it.
---

GoBD-critical tables beyond `audit_log` are protected DB-side by raising BEFORE
triggers (`server/startup/ensure-gobd-table-immutability.ts`, idempotent startup
hook). A forbidden direct mutation fails with ERRCODE `restrict_violation`, not
silently. Protections:

- `budget_allocations`: no resurrect (`deleted_at` NOT NULL → NULL), no hard
  DELETE, no TRUNCATE. (Soft-delete NULL→Date and other column UPDATEs stay OK.)
- `customer_budget_type_settings`: no hard DELETE, no TRUNCATE. UPDATE stays
  allowed (the phase-append / in-place re-clamp path legitimately edits closed rows).
- `invoices`: no hard DELETE when `status <> 'entwurf'`, no TRUNCATE. UPDATE stays
  allowed (status transitions, Qonto paidAt, PDF-cache columns).
- `invoice_line_items`: no UPDATE/DELETE when the parent invoice is finalized
  (`status <> 'entwurf'`), no TRUNCATE. Draft line items stay freely mutable.

**Bypass:** single transaction-local GUC `SET LOCAL app.allow_gobd_mutation = 'on'`
(separate from audit_log's `app.allow_audit_log_mutation`). Production never sets it.
For Vitest teardowns deleting these tables, use `withGobdMutation(tx => ...)` from
`tests/helpers/gobd.ts` instead of hand-rolling the GUC — a plain `db.delete(...)`
in `afterAll`/`cleanup` fails with `restrict_violation` and reds the whole suite.

**Why these legit paths MUST set the bypass** (miss one → breaks prod or the test
suite): customer-merge tx in `duplicates.ts` (direct deletes), the two test-purge
`purgeCustomerCascade` txns in `test-data-cleanup.ts` + `cleanup-test-data.ts`
(customer hard-delete CASCADES into both budget tables — FK `onDelete: cascade` —
plus explicit invoice/line-item deletes), the prospect-purge tx in
`test-data-cleanup.ts` (sets `invoice_line_items.appointment_id = NULL`, which is a
finalized-line-item UPDATE), and `migrate-budget-sources.ts` (must wrap its
soft-deleted-dup DELETE in a tx). The hook is registered BEFORE
`migrate-budget-sources` in `server/index.ts`.

**Gotcha when verifying:** the full `test` + `e2e-smoke` workflows run against the
SAME shared server/DB; running your own `vitest` concurrently corrupts state and
makes drift/rebook/Chromium tests (km-drift, appointment-edit-rebook,
document-pdf) flake — see `docs/flaky-tests.md` (load-contention). Verify isolated.
