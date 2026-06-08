---
name: Invoice PDF object-storage isolation per environment
description: Why invoice/LN PDF object keys are env-scoped and how new PDF write paths must respect it
---

Invoice + Leistungsnachweis PDF object keys are environment-scoped. Production writes the bare `invoices/<number>.pdf` / `invoices/<number>-leistungsnachweis.pdf` key space; all non-production envs (development, test) write under `_nonprod/<NODE_ENV>/invoices/…`.

**Why:** dev/test/prod share ONE object-storage bucket (paths come from global secrets `PRIVATE_OBJECT_DIR`/`PUBLIC_OBJECT_SEARCH_PATHS`), and invoice numbers (`RE-2026-00xx`) collide across the dev and prod DBs. A dev/test run generating `RE-2026-0034` was overwriting the real production PDF at the same object key. The GoBD "never overwrite an existing `pdf_path`" guard only protects a single DB row, not a shared object key written by a different environment.

**How to apply:** any new code path that WRITES an invoice/LN PDF object MUST build its key via `buildInvoicePdfObjectKey(safeNumber, { leistungsnachweis? })` and call `assertInvoicePdfWriteKeyAllowed(key)` before saving — both in `server/lib/object-storage-helpers.ts`. The guard hard-fails if a non-prod env ever targets the bare production key space. READS stay verbatim on the stored `pdf_path`/`leistungsnachweis_path` (existing prod rows have no prefix and keep resolving), so never prefix on read. Tests that `vi.mock` `object-storage-helpers` must also stub the two new exports or the orchestrator import is undefined.
