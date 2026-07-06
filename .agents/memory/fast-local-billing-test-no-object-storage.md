---
name: Fast local verification of heavy billing/PDF tests
description: How to run a Chromium-heavy billing test synchronously within the agent's ~2min bash limit
---

Heavy billing tests that go through invoice generate + storno + reissue render PDFs
via Chromium (`persistInvoicePdf`), which in this workspace is triggered because the
object-storage env vars are present. That pushes a single-test run past the agent's
~2 min foreground bash timeout, and detached/background runs (`nohup`, `setsid`,
`disown`) are killed as soon as the tool call returns — so there is no way to run it
in the background either.

**Fix:** run the orchestrator with object storage unset:
`env -u PRIVATE_OBJECT_DIR -u PUBLIC_OBJECT_SEARCH_PATHS npx tsx scripts/with-ephemeral-db.ts <port> npx vitest run <file>`

`persistInvoicePdf` early-returns when `!isObjectStorageConfigured()`
(`server/lib/object-storage-helpers.ts` = both `PRIVATE_OBJECT_DIR` &&
`PUBLIC_OBJECT_SEARCH_PATHS`), and generate's background persist is gated the same
way. All Chromium renders are skipped → a ~2-4 min run drops to ~10 s.

**Why safe:** this is exactly how the no-sidecar GitHub-Actions CI runs this test
class (see ci-object-storage-and-reference-seed.md). Assertions that only read DB
rows (invoice status, budget_transactions, audit_log, service records) are
unaffected — only PDF bytes are skipped, which these tests don't assert on.

**How to apply:** use it for any billing/invoice/storno test whose asserts are
DB-only when you need synchronous green-verification locally. Add
`--reporter=json --outputFile=.local/x.json` so results land on disk even if the
tool kills stdout capture at teardown. Do NOT use it if the test actually asserts
on rendered PDF content or object-storage keys.
