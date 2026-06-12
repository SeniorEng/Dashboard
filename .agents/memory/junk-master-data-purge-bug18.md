---
name: Junk master-data purge (BUG-18)
description: How service/document-type junk is detected & purged, and why doc-types use a name WHITELIST not a regex.
---

# Junk master-data purge (BUG-18)

## Document-type junk = name WHITELIST, not regex
Junk doc-types are now classified as: name starts with `DOC` AND name NOT in the
central `DOCUMENT_TYPE_WHITELIST` (the 22 real types) — SSoT lives in
`server/services/test-data-cleanup.ts` (`isDocumentTypeTestJunk`,
`DOCUMENT_TYPE_TEST_FILTER`). This REPLACED the old `DOC%_17777%` regex.

**Why:** real document types never start with `DOC`; the prefix is only ever used
by test fixtures. A whitelist is defensive — any future `DOC*`-named test row is
caught even if its suffix shape changes. The old timestamp-regex missed variants.

**How to apply:** when adding a genuinely new real document type, if (and only if)
its name starts with `DOC`, add it to `DOCUMENT_TYPE_WHITELIST` or the guard/purge
will treat it as junk. Mirror constant is imported (not re-declared) by
`server/scripts/cleanup-test-data.ts` and `scripts/check-no-test-junk.ts`.

## Service junk patterns
`SERVICE_TEST_FILTER` matches name/code `tlsicht_%`, `tlwrite_%`, `qs-test-%`,
`%_test_%`.

## Purge is FK-safe (deactivate vs hard-delete)
Referenceless junk → hard DELETE; junk referenced by `customer_service_prices` /
appointments / documents → soft `is_active=false` (kept, GoBD/FK-safe). On the
shared dev DB almost all junk services are price-referenced ⇒ deactivate path.

## Guard counts only ACTIVE junk
`scripts/check-no-test-junk.ts` (CI step `npm run check:no-test-junk`, also run by
the orchestrator after the full vitest+e2e pass) only flags `is_active=true` junk.
**Why:** soft-deactivated referenced junk is intentionally retained and would keep
the guard permanently red on a shared dev DB with no way to fix. A fresh CI
throwaway DB has no deactivated junk ⇒ identical behaviour. In production the guard
is a non-fatal no-op (exit 0).

## Prod migration (#895 pattern)
`server/startup/purge-junk-master-data.ts`: single guarded txn + advisory lock +
`budget_migrations` ledger (exactly-once) + real-ID conservation pre/post with
rollback on `JunkPurgeConservationError`. CLI `server/scripts/purge-junk-master-data.ts`
(`npm run purge:junk-master-data`) always writes a dry-run report to
`docs/bug-18-junk-purge-dry-run-<env>-<ts>.md`; destructive `--apply` is gated
behind `JUNK_PURGE_PROD_APPROVED`. Migration name SSoT: `bug-18-purge-junk-master-data`.
**Why:** GoBD — never run unguarded destructive master-data deletes; conservation
check proves real IDs are untouched. NO prod execution without explicit approval.
