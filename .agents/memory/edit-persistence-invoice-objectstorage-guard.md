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

## Second, DIFFERENT flake: Replit WITH object storage — Verification-4 UI-row render race

When object storage IS present (Replit/local), the same two tests can still flake at
Verification 4's `expect(invoiceRow).toBeVisible())` — but for an unrelated reason: pure
FRONTEND query/render timing under RAM contention (many workflows in parallel). The invoice
is already in the DB and returned by the API (Verifications 1–3 pass); the billing LIST route
(`GET /billing` → `storage.getInvoices`) does **NOT** filter by `pdfPath`, so the row appears
as soon as the TanStack-Query list (`["billing-invoices", year, month, ...]`, staleTime 30s)
loads/refetches. So a missing row is a render/query race, not a data or PDF-persist problem —
do not assume PDF-persist gates the row.

**Fix:** a reload-retry helper `openInvoiceDetailInBilling(page, invoiceId, month, year)`
that navigates to `/admin/billing`, sets the month/year selects, waits for the row, and on
miss reloads + re-applies the filters (up to 3 attempts) before opening the overflow
actions-menu → detail. Mirrors `billing-bulk.spec.ts`'s `fetchInvoiceFor` poll-then-assert.
Just bumping the single timeout is NOT enough; the reload forces a fresh list fetch.

**Note:** a truly isolated observation run is impractical in the agent harness — 6 workflows
(Start application, e2e-smoke, test, lint, typecheck, billing-cov) run concurrently, and each
heavy PDF test exceeds the 2-min bash ceiling, so the direct `playwright test --grep` run
times out before finishing. Also `npx playwright install ffmpeg` is needed once in the agent
env (video:retain-on-failure) or `newPage` throws (see e2e-playwright-ffmpeg-agent-env).
