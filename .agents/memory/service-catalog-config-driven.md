---
name: Service catalog is config-driven SSoT
description: Why services can't be created via UI/API, and where the "no junk service" guarantee actually lives.
---

# Service catalog = config-driven single source of truth

`shared/config/services.ts` (`SERVICE_CATALOG` / `SERVICE_CATALOG_CODES`) is the
ONLY source of real services. A service is added/changed ONLY by editing that
file with review — there is no API/UI write path (`POST`/`PUT /api/services` →
`403 SERVICE_CATALOG_READONLY`; the services admin UI is read-only).

**Why drift can't crash startup, and where the real guarantee lives.**
At boot `serviceCatalogStorage.syncServiceCatalog()` upserts every config entry
(+ budget pots via `reconcileBudgetPots`) and then THROWS on any DB service
absent from the config / with a null code. But that throw is intentionally
swallowed by the per-step fault-isolation try/catch in `runStartupTasks`
(`server/index.ts`) — an arch rule (`startup-steps-fault-isolated.test.ts`)
forbids any startup step from aborting the rest of the chain, so a drift error is
only logged as "Startfehler". **Therefore the "no junk service" guarantee is NOT
startup-abort; it is a read filter:** `getAllServices()` returns only rows whose
code is in `SERVICE_CATALOG_CODES`. That holds even if the sync is skipped.

**Why extras are filtered, not deleted.** Old DB rows may be FK-referenced by
appointments/customer prices, so sync must not delete them. Hence
`getServiceById/getServicesByIds/getServiceByCode` stay UNFILTERED (existing FK
lookups keep resolving), only the catalog LIST is filtered. Real cleanup of a
non-config row is a manual, FK-safe migration.

**How to apply.** To add/rename a service, edit `SERVICE_CATALOG`. Never seed
services in scripts/tests — tests use the seeded catalog services (e.g.
`hauswirtschaft`) and create their own customers. Don't "fix" drift by deleting
the startup try/catch (breaks the arch test) or by deleting referenced rows.
