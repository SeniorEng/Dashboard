---
name: Startup reference-data importers vs ephemeral test-DB seeding
description: Why making the insurance_providers (and similar) startup importers "update-only" silently empties the test DB
---

Reference-data importers like `importPflegekassen` / `seedPkvProviders` (server/startup/) populate `insurance_providers` at **server boot**, running against the freshly-cloned ephemeral test DB. These rows are NOT baked into the template cache (`cc_test_tmpl_cache`), and the cache hash only tracks `shared/schema/`, `drizzle.config.ts`, and the two seed scripts — it does NOT track `server/startup/`.

**Rule:** When a startup importer must stop re-creating intentionally-deleted reference rows, gate inserts on **"target set is empty OR explicit force flag"**, never flag-only-defaulting-off.

**Why:** A flag-only-off default means a fresh/empty DB (every e2e/test run, and first-ever onboarding) gets zero rows inserted. e2e smoke (`budget-setup-required-banner.spec.ts`) asserts `insurance providers > 0` and hard-fails ("Keine Insurance-Provider in der Test-DB"). The dev DB hid this because it was already populated (importer ran update-only and reported "0 neu, 304 aktualisiert").

**How to apply:** `allowInsert = forceFlag || isEmpty`. For the EDIFACT importer, `isEmpty` = `existing.length === 0`. For the PKV seed (table already has EDIFACT rows by then), `isEmpty` = none of the known PKV names exist yet. Force flag = `INSURANCE_PROVIDER_IMPORT_INSERT=1`. No cache rebuild is needed — the new importer logic runs against the cloned DB on next boot.
