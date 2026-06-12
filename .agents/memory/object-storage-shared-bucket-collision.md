---
name: Object storage bucket is shared across ephemeral test DBs (now run+worker-scoped)
description: Why invoice-PDF integration tests USED to flake under concurrent harness runs; non-prod PDF keys now carry a per-run AND per-worker id so the bucket is logically isolated.
---

# Object storage bucket is shared, but non-prod PDF keys are now per-run + per-worker scoped

**Update:** non-prod invoice/LN PDF object keys now include BOTH a per-run AND a
per-worker component. `getInvoicePdfKeyPrefix()`
(`server/lib/object-storage-helpers.ts`) builds the `_nonprod/<NODE_ENV>/` prefix,
then appends `/run-<sanitized EPHEMERAL_RUN_ID>` when `EPHEMERAL_RUN_ID` is set,
then appends `/w-<EPHEMERAL_WORKER_ID>` when `EPHEMERAL_WORKER_ID` is set.
Production is unaffected (prefix stays `""`).

**Why the worker segment was needed:** the per-run scope alone was NOT enough.
Multiple workers WITHIN one run each get their own throwaway DB, so they all mint
the SAME invoice numbers (e.g. RE-2026-0001) and — before the worker segment —
produced the SAME object key → they clobbered each other inside a single `test`
run. The orchestrator (`scripts/with-ephemeral-db.ts`) now passes
`EPHEMERAL_WORKER_ID: String(workerIndex)` into each worker app-server's spawn env,
and `tests/setup.ts` sets it per vitest fork (idx = `(VITEST_POOL_ID-1) % baseUrls.length`,
matching the orchestrator's positional worker indexing) so in-process renders /
direct object-storage writes land on the same prefix as their paired app-server.
Both sides agree on a 0-based index; segment format is `w-<id>`.

**Related provisioning fix (same task):** worker DB clones from the per-run
template are now SERIAL (a for-loop calling `cloneDbFromTemplate`, which retries 8×
on "source database … is being accessed by other users") BEFORE the parallel
worker-server boot, instead of cloning all workers concurrently via `Promise.all`.
Concurrent clones of one template intermittently hit the "being accessed by other
users" Postgres error.

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
