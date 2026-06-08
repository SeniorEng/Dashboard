---
name: Object storage bucket is shared across ephemeral test DBs
description: Why invoice-PDF integration tests flake under concurrent harness runs even though the database is isolated per run.
---

# Object storage is NOT isolated per ephemeral test DB

The ephemeral-DB orchestrator (`scripts/with-ephemeral-db.ts`) gives each
run/worker its own throwaway Postgres DB, but the **object storage bucket is the
real shared bucket**. Invoice/LN PDF object keys are only namespaced by
`_nonprod/<NODE_ENV>/...` (`server/lib/object-storage-helpers.ts`
`buildInvoicePdfObjectKey`), and `NODE_ENV=test` for every run.

**Consequence:** two test runs executing the same invoice-PDF test concurrently
(e.g. the `test` workflow + a manual standalone `with-ephemeral-db.ts` run, or
two workers) both generate the SAME invoice numbers from their fresh DBs → SAME
object key → they overwrite each other's bucket objects. This produces sporadic,
confusing failures in `tests/billing/regenerate-clobbered-invoice-pdfs.test.ts`
such as `alreadyCorrect=0` (the seeded KNOWN bytes got clobbered) and duplicate
`invoice_pdf_manually_regenerated` audit rows (a cascade once one test
misclassifies and repairs under apply:true).

**Why it's a trap:** those tests use an INJECTED re-render fn, so they don't even
exercise PDF-render code — a failure there during a PDF change is almost always
bucket collision, not a regression.

## How to apply
Verify invoice-PDF tests in ISOLATION: run the single file via
`with-ephemeral-db.ts` with NOTHING else touching the bucket (let the `test`
workflow finish first). A green isolated run + green typecheck/lint is the
trustworthy signal. Do not trust failures observed while the harness/`test`
workflow runs the same file concurrently. (See also
validation-env-concurrency-flakes.) Real fix would be a run-unique component in
the non-prod PDF object key.
