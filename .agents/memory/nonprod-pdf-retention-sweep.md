---
name: Non-prod PDF retention sweep
description: How/why old _nonprod/ invoice+LN PDFs are cleaned from the shared object-storage bucket
---
The shared object-storage bucket had NO retention for PDFs: prod writes bare `invoices/…` (GoBD-kept), non-prod isolates under `_nonprod/<NODE_ENV>[/run-<RUN_ID>][/w-<WORKER_ID>]/…`, but nothing ever called `.delete()` and DB-row cleanup leaves the PDF objects orphaned ⇒ bucket grows monotonically.

Retention lives in `scripts/lib/object-storage-pdf-sweep.ts` (`sweepNonprodPdfArtifacts` pure/injectable core + `runNonprodPdfSweep` wired wrapper). Age-based only (default 24h `DEFAULT_PDF_RETENTION_MS`), NOT dead-run-ID-aware (deferred follow-up).

**Why the guards matter:** symmetric to the write-guard. `assertNonprodPdfDeleteKeyAllowed` (in `server/lib/object-storage-helpers.ts`) throws for any non-`_nonprod/` key; list-prefix must contain `_nonprod/`; wrapper hard-refuses NODE_ENV=production; no-op without configured object storage (CI no-sidecar).

**How to apply:** run via `npm run test:sweep-pdfs` (dry-run) / `scripts/sweep-nonprod-pdfs.ts --apply`. Auto-runs fail-safe from `scripts/with-ephemeral-db.ts` (orchestrator boot) and `scripts/sweep-test-dbs.ts` (`npm run test:unblock`, --force ⇒ retention 0). Age comes from GCS `metadata.timeCreated`; null age skipped conservatively. Doc: docs/test-infrastructure.md "Object-Storage-Retention".
