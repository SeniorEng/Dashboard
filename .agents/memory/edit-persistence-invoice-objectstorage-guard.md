---
name: edit-persistence invoice tests need object-storage guard
description: Why the two km/duration drift tests in e2e/smoke/edit-persistence.spec.ts fail in no-sidecar GitHub CI, and the correct fix.
---

The two "Anzeige↔Buchung" drift round-trip tests in `e2e/smoke/edit-persistence.spec.ts`
(km `7,3 → 12,7` and Hauswirtschaft `45 → 72 Min`) fail DETERMINISTICALLY (all retries)
in the isolated GitHub-Actions CI at the `expect(invoiceRow).toBeVisible()` assertion — the
`/admin/billing` invoice row never appears.

**Root cause:** Verification 3/4 of those tests call `POST /api/billing/generate` and then
read the invoice back in the admin UI. That path needs the object-storage sidecar
(`PRIVATE_OBJECT_DIR` + `PUBLIC_OBJECT_SEARCH_PATHS`) + Chromium PDF rendering. The no-sidecar
CI has neither, so `persistInvoicePdf` writes nothing and the invoice never surfaces in the
billing list. This is the SAME reason `billing-bulk.spec.ts` is already CI-skipped via its
`hasObjectStorage` guard.

**NOT** a formatting drift (formatKm/formatDuration) and **NOT** a harness timing flake — an
earlier triage mislabeled it a "harness flake". Verifications 1 (Termin-Detail km/duration)
and 2 (Budget-Ledger) do NOT need object storage and pass in CI; only the invoice segment fails.

**Fix (matches repo convention):** module-level
`const hasObjectStorage = !!process.env.PRIVATE_OBJECT_DIR && !!process.env.PUBLIC_OBJECT_SEARCH_PATHS;`
then `if (!hasObjectStorage) return;` right before the invoice-generation block in each test.
The `return` sits inside the `try`, so the `finally { deactivateEmployee }` cleanup still runs.
Locally/Replit object storage IS configured, so the full invoice check still runs there.

**Why:** CI intentionally has no object storage; the established pattern is to skip the
invoice/PDF portion, not to make CI render PDFs. Any NEW e2e test that calls
`/api/billing/generate` or asserts persisted-PDF/invoice-UI must carry the same guard.
