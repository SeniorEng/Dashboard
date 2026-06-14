---
name: Company-settings two-tier cache cross-process test trap
description: Why an in-process billing /send test flaked on "LetterXpress-Konfiguration unvollständig" and how to seed-then-read company_settings across two processes.
---

There are TWO company-settings caches in one app process: a service-tier cache
(`companySettingsCache` in `server/services/cache.ts`, 60s TTL, the canonical
invalidation point used by routes) and a storage-tier cache (private field inside
the `DatabaseStorage` singleton in `server/storage.ts`, 5min TTL). In production
both live in the same process and `updateCompanySettings` clears the storage tier
while the route clears the service tier — consistent.

**The test trap:** orchestrator-style billing tests SEED company_settings via the
`apiPatch`/`apiPost` helpers, which hit `BASE_URL` = the orchestrator's SEPARATE
app-server process. But some tests then READ via an IN-PROCESS mounted router
(`startInProcessBilling`) running in the vitest worker process. Those are two
different `DatabaseStorage` singletons with two different storage-tier caches.
The seed invalidates the orchestrator process's caches, NOT the test process's.
If an earlier in-process read populated the test process's storage-tier cache
with a pre-seed snapshot (no LetterXpress creds) it stays warm for 5min, so the
in-process `/send` reads stale settings → `LetterXpress-Konfiguration
unvollständig`. Intermittent because it depends on prior in-process reads + the
5min TTL, so it passes in isolation and flakes in the full run.

**Fix / how to apply:** before reading company_settings in-process after an
out-of-process seed, invalidate BOTH tiers in the test process:
`storage.invalidateCompanySettingsCache()` (public method added for exactly this)
AND `companySettingsCache.invalidate()`. Invalidating only the service tier is
not enough. Any new in-process-router test that seeds via the orchestrator
app-server must do the same.
