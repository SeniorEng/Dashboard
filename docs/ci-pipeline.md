# CI-Pipeline (GitHub Actions)

Detail-Runbook zur Continuous-Integration-Pipeline von CareConnect. Übergeordneter
Projekt-README: [`../replit.md`](../replit.md). Lokale Test-Ausführung (Orchestrator,
Ephemeral-DB, Template-Cache) siehe [`test-infrastructure.md`](test-infrastructure.md);
Dependency-Automatisierung siehe [`dependency-management.md`](dependency-management.md).

## Pflicht-Gates

GitHub Actions (`.github/workflows/ci.yml`) läuft bei jedem Push und Pull-Request mit 9 Pflicht-Gates:

1. `npm ci`
2. `tsc --noEmit`
3. `eslint --max-warnings 0`
4. `vitest run` (JUnit-Report als Artifact)
5. `vitest run tests/architecture/` (Fitness-Functions, eigenes Gate)
6. `npm audit --audit-level=high`
7. `npm run test:e2e:smoke` (Playwright)
8. Targeted-Coverage-Gates `tsx script/coverage-gate.ts <key>` (je ein CI-Step für `billing`, `qonto`, `consumption-engine`, `month-close-scheduler`)
9. `npm run gen:openapi -- --check` (OpenAPI-Spec-Drift, statisch im `static-analysis`-Job)

Die DB-/Server-abhängigen Gates (4, 5, 7, 8) brauchen die Repo-Secrets `TEST_USER_EMAIL` + `TEST_USER_PASSWORD` (Login gegen den in CI gestarteten App-Server) — fehlen sie (z.B. in Forks), werden diese Schritte sauber übersprungen, die statischen Gates (1, 2, 3, 6) laufen immer.

## Neon-Proxy in CI (Task #798)

Der App-DB-Layer (`server/lib/db.ts`) nutzt den Neon-Serverless-Treiber (Secure-WebSocket/TLS) und kann sich NICHT direkt mit dem plain `postgres:16`-Service-Container verbinden (ECONNREFUSED). Die Jobs `tests` und `e2e-smoke` starten daher zusätzlich den Service `neon-proxy` (`ghcr.io/timowilhelm/local-neon-http-proxy`, Port 4444, `PG_CONNECTION_STRING` → `postgres`-Service) und setzen `NEON_LOCAL_WS_PROXY=localhost:4444`. Ist diese Variable gesetzt, schaltet `db.ts` Secure-WS/TLS-Pipelining ab und routet den WebSocket über den Proxy (`ws://…/v2`); der Produktivpfad (echter Neon-Host) bleibt unberührt, solange die Variable NICHT gesetzt ist. `drizzle-kit push` läuft weiter direkt gegen `localhost:5432` (eigener pg-Connect, kein Neon-Treiber).

## Test-User-Seed (Task #786)

Da die CI-DB frisch ist (`drizzle-kit push` legt nur das Schema an), seedet der Step `npx tsx scripts/ci-seed-superadmin.ts` (in den Jobs `tests` und `e2e-smoke`, nach dem DB-Push und vor dem Server-Start, gegated auf gesetztes `TEST_USER_PASSWORD`) idempotent einen Superadmin mit `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` — sonst schlägt das Login in `globalSetup` fehl und die Required-Checks liefen permanent rot.

## Branch-Protection (aktiv)

`main` auf `SeniorEng/Dashboard` erzwingt die Required-Status-Checks `static-analysis`, `tests` und `e2e-smoke` (strict / „branch up to date") vor jedem Merge; Force-Pushes und Branch-Löschung sind gesperrt. PR-Reviews werden nicht erzwungen, damit Renovate grüne Patch-Updates weiterhin auto-mergen kann; `enforce_admins` ist aus (Admin-Notfall-Override möglich). Wichtig: Die CI-Job-Namen (`name:`) sind bewusst identisch mit den Job-IDs (`static-analysis`/`tests`/`e2e-smoke`), weil GitHub den Required-Check-Kontext über den Job-**Namen** matcht — bei abweichenden Anzeigenamen würden die Checks nie „grün" und jeder Merge (inkl. Renovate) bliebe blockiert. Eingerichtet via GitHub-API am 2026-05-28, bestätigt durch Repo-Admin `SeniorEng`. Verwaltung: Repo → Settings → Branches.
