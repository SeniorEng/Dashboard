---
name: Object storage bucket is shared across ephemeral test DBs (now run-scoped)
description: Why invoice-PDF integration tests USED to flake under concurrent harness runs; non-prod PDF keys now carry a per-run id so the bucket is logically isolated.
---

# Object storage bucket is shared, but non-prod PDF keys are now per-run scoped

**Update:** non-prod invoice/LN PDF object keys now include a per-run component.
`getInvoicePdfKeyPrefix()` (`server/lib/object-storage-helpers.ts`) appends
`/run-<sanitized EPHEMERAL_RUN_ID>` to the `_nonprod/<NODE_ENV>/` prefix when the
`EPHEMERAL_RUN_ID` env var is set; the orchestrator (`scripts/with-ephemeral-db.ts`)
exports that var (its `runId`) into `baseEnv` so every worker app-server AND the
vitest process inherit it. Production is unaffected (prefix stays `""`). This means
two concurrent test runs no longer clobber each other's PDF objects even though the
underlying bucket is still physically shared. The history below explains the failure
mode this prevents.

The ephemeral-DB orchestrator (`scripts/with-ephemeral-db.ts`) gives each
run/worker its own throwaway Postgres DB, but the **object storage bucket is the
real shared bucket**. Before the run-id fix, invoice/LN PDF object keys were only
namespaced by `_nonprod/<NODE_ENV>/...` (`server/lib/object-storage-helpers.ts`
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
The run-id key scoping (above) is the implemented fix, so concurrent runs no
longer clobber. Any NEW non-prod PDF write path must still route through
`buildInvoicePdfObjectKey`/`assertInvoicePdfWriteKeyAllowed` (which use
`getInvoicePdfKeyPrefix`) so it inherits the run scope — do not hand-build keys.
If you ever run a PDF object-key test WITHOUT the orchestrator (no
`EPHEMERAL_RUN_ID`), keys fall back to the bare `_nonprod/<NODE_ENV>/` prefix and
the old clobber race returns; prefer running via `with-ephemeral-db.ts`. Reads
stay verbatim on the stored path. (See also validation-env-concurrency-flakes.)
