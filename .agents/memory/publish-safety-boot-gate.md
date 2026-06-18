---
name: Publish safety net — boot gate + replica diff
description: Why the critical-SSoT boot gate is production-scoped and how destructive publish drops are detected/acknowledged.
---

The publish safety net has two staffed layers that must NOT be collapsed:

1. **Operator preflight** (`script/preflight-publish.mjs`, blocking, exit 1) detects
   destructive drops by **schema-vs-prod-replica diff** (`PROD_DATABASE_URL` vs the
   Drizzle/dev `DATABASE_URL`), NOT by grepping `migrations/`. Migration files lie
   about real drift; only the live replica comparison sees it. Drops require explicit
   per-DROP acknowledgment via `PUBLISH_ACK_DROPS` (`table:x` / `column:t.c` keys) and
   must satisfy expand-migrate-contract (no drop of a table still in
   `STARTUP_MIGRATION_REFERENCED_TABLES`).

2. **Boot-time hard gate** (`server/startup/critical-ssot-boot-gate.ts`) runs before
   `httpServer.listen`.

**Why production-scoped (the trap):** dev `Start application` and the ephemeral test
DBs legitimately run with an EMPTY `prices` table and no legacy source tables. A hard
boot-fail in every environment would break dev + every test/e2e/coverage workflow boot.
So `evaluateCriticalSsotGate` only THROWS (`process.exit(1)`) when `isProduction`;
non-prod emits a loud WARNUNG and continues. Verified: all of Start-app / test /
billing-cov boot with the warning, not a crash.

**Manifest escape hatch** (`docs/db-backup-manifest.json`) only legitimizes an empty
critical table when its `schemaHash` matches the running schema — a stale entry is auto-
invalidated, so a freeze-dried "it's fine" can't linger past a schema change.

**Build warning stays non-blocking** (`script/check-build.mjs` / `script/build.ts`) —
that is intentional (backups aren't committed); the hard stop lives in the operator
preflight where prod creds exist.
