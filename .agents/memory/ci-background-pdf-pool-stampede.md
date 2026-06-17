---
name: CI background-PDF persistence drains the DB pool
description: Why unrelated auth/customer requests time out (401/500) in CI without object storage, and the gate that fixes it
---

In GitHub-Actions CI there is no object-storage sidecar, so `PRIVATE_OBJECT_DIR`/`PUBLIC_OBJECT_SEARCH_PATHS` are unset. Background invoice-PDF persistence (`schedulePdfPersistInBackground` → `persistInvoicePdf`) wraps a full Puppeteer render **inside** `db.transaction` and retries 3×30s. Without a bucket it can never succeed, so after every `billing/generate` it just holds a pooled connection through the render + retries.

**Symptom (non-obvious):** the failures land on *unrelated* requests — session validation returns 401 and `POST /customers` returns 500, each after ~15s. Root cause is `connectionTimeoutMillis` on an exhausted pool (max 20), NOT a logic regression in auth/customers. The auth middleware silently catches the DB connect-timeout and treats it as "not logged in" → 401.

**Rule:** any expensive write/render path that needs object storage MUST early-return when object storage is unconfigured (`isObjectStorageConfigured()` in `server/lib/object-storage-helpers.ts`, same `PRIVATE_OBJECT_DIR && PUBLIC_OBJECT_SEARCH_PATHS` criterion as `tests/helpers/object-storage.ts#hasObjectStorageEnv`). It is a no-op everywhere object storage exists (local/Replit/prod) and only changes CI.

**Why:** keeps the gate at the product layer (no PDF target ⇒ don't render) instead of papering over symptoms in auth/customer routes.

**How to apply:** when a CI job goes red with timeouts/401/500 on endpoints unrelated to the changed code, suspect pool exhaustion from a transaction-held background render, not the endpoint. Playwright e2e can't read the vitest object-storage helper — gate those specs on the raw env vars directly.
