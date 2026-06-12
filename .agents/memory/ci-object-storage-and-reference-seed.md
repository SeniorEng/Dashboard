---
name: CI lacks object-storage sidecar + reference-data seed
description: Why GitHub-Actions CI skips invoice/PDF-persistence tests and must seed base services/company_settings that the grown Dev-DB has but a fresh DB does not.
---

# GitHub-Actions CI environment gaps (not product bugs)

Two distinct gaps make a fresh CI environment behave differently from the grown
Replit Dev-DB. Both are CI-environment causes, NOT product bugs.

## 1. No object-storage sidecar in CI
The Replit object-storage client gets its token from a local sidecar
(`http://127.0.0.1:1106`). GitHub Actions has no sidecar, so
`PRIVATE_OBJECT_DIR` / `PUBLIC_OBJECT_SEARCH_PATHS` are deliberately unset there.
Any test that really uploads/reads invoice or LN PDFs then dies with
"PRIVATE_OBJECT_DIR not set".

**Rule:** invoice/PDF-persistence tests must be skip-guarded on object-storage
availability via `tests/helpers/object-storage.ts`:
- whole-file dependency → import the helper's `describe` instead of vitest's
  (`import { describe } from "../helpers/object-storage"`) — it auto-skips when
  the env is missing.
- mixed file (only some suites upload) → import `hasObjectStorageEnv` and guard
  only those suites with `describe.skipIf(!hasObjectStorageEnv)(...)`.

**Why:** locally/Replit the env is set so the tests run fully; in CI they skip
cleanly (same pattern as "erechnung without Java" / "ci-seed without secrets").
Mocked-storage tests don't need the guard.

## 2. Fresh CI-DB has no reference master-data
Startup hooks only seed system services (`travel_km`, `customer_km`,
`erstberatung`) + cassen/PKV providers. The non-system base services
`hauswirtschaft` / `alltagsbegleitung` and the `company_settings` company
identity (name + IBAN, needed for ZUGFeRD) exist only as grown Dev-DB data.
`scripts/seed-test-reference-data.ts` seeds exactly this canonical base. The
orchestrator runs it; CI must run it too (a `Seed test reference data` step in
both the `tests` and `e2e-smoke` jobs, guarded by `TEST_USER_PASSWORD != ''`).

`company_settings.updated_by_user_id` is a nullable FK: when no user exists yet
(e.g. the `template-cache-verify` job, which skips the superadmin seed), the
seeder must pass `null`, never `0` (0 violates the FK and aborts the seed).

## Verifying changes here
The agent harness runs `test` + `e2e-smoke` concurrently against the SHARED dev
Postgres, which causes orchestrator `CREATE DATABASE ... TEMPLATE` collisions
("source database ... is being accessed by other users") and stale workflow-log
capture. These are harness flakes, not failures. Verify affected files with raw
`TEST_BASE_URL=http://localhost:5000 npx vitest run <file>` against the running
dev app server instead of trusting the harness aggregate.
