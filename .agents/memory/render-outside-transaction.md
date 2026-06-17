---
name: Render outside DB transaction (PDF pool-starvation guard)
description: Why bulk-print/send PDF paths must never render inside a held DB transaction, and the fitness test that enforces it.
---

# Puppeteer render must not hold a pooled DB connection

The expensive multi-second Puppeteer PDF render (and object-storage upload) must
NOT run inside a `db.transaction(...)` / `withAudit(...)` callback. Doing so pins
one of the ~20 pooled Neon connections for the whole render; under load (bulk
print / batch send render many PDFs in a row) the pool starves and unrelated
requests time out (seen as 401/500).

**Pattern:** plan (short tx: advisory lock + freshness re-check) → render+upload
(NO connection held) → commit (short tx: re-read fresh row, reconcile, write).
The shared single-invoice persist path uses this. The bulk-print/send routes and
the on-the-fly helpers (renderLeistungsnachweisOnTheFly, loadOrRenderSendablePdfs)
already render outside transactions — each DB read borrows+releases its own
connection, then the render runs with none held.

**Why:** under-load pool exhaustion is the failure; GoBD hash immutability /
idempotent self-heal must still hold across the split (the commit re-checks the
fresh row before writing).

**How to apply:** any new invoice/LN PDF write or send path must keep render
calls out of transaction callbacks. The fitness test
`tests/architecture/no-render-inside-transaction.test.ts` (ast-grep) fails if a
render call lands inside a tx in billing routes or the orchestrator. Known
accepted exception (NOT guarded): customer onboarding renders inside its tx by
design (server/lib/customer-creation-helpers.ts).
