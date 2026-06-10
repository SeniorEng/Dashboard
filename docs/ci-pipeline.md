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

## GitHub-Sync (Repo ↔ Replit-Projekt)

CI läuft auf `SeniorEng/Dashboard` `main` und kann nur das testen, was dort liegt. Die eigentliche Entwicklung passiert im Replit-Projekt; ohne aktiven Sync driftet GitHub `main` gegenüber dem Projekt-Stand. Folge: CI testet alten Code und statische Gates wie der OpenAPI-Drift-Check (`gen:openapi -- --check`) gehen rot, obwohl im Projekt alles aktuell ist.

### Entscheidung: periodischer Push ist der kanonische Sync-Weg

Sync läuft über einen **bewussten, periodischen `git push` von `main`**, NICHT über „Publish".

- **Warum nicht Publish:** „Publish your App" erzeugt zwar historisch einen Repo-Snapshot, hinkt aber dem Tagesgeschäft hinterher (Arbeit nach dem letzten Publish fehlt) und vermischt zwei Anliegen — Deployment der Production-App vs. „CI testet aktuellen Code". Publish ist daher das Deployment-Werkzeug (siehe `docs/deployment-log.md` / `docs/pre-publish-backup-runbook.md`), nicht der CI-Sync.
- **Konsequenz:** Push entkoppelt CI-Sync vom Deploy. Wer Code im Projekt ändert und will, dass CI ihn prüft, pusht `main` — unabhängig davon, ob/wann deployt wird.

### Wiederholbarer Sync (Schritt für Schritt)

1. Lokal sicherstellen, dass `main` sauber und die Spec aktuell ist:
   ```bash
   git status --porcelain        # leer = clean
   npm run gen:openapi -- --check # "OK — Spec ist aktuell."
   ```
   Driftet die Spec, einmal `npm run gen:openapi` laufen lassen und `docs/api/openapi.json` mitcommitten (die Spec wird aus den Zod-Schemas in `shared/api/openapi.ts` generiert).
2. `main` nach GitHub pushen. Über das GitHub-Pane im Workspace oder per CLI:
   ```bash
   git push origin main:main
   ```
3. **Sonderfall Workflow-Dateien (`.github/workflows/*`):** Der Standard-GitHub-Connector-Token hat KEIN `workflow`-Scope; jeder Push, der `.github/workflows/*` berührt, wird mit `GH013` abgelehnt. Solche Pushes brauchen einen klassischen PAT mit `repo`+`workflow`-Scopes (Repo-Secret `GITHUB_WORKFLOW_PAT`):
   ```bash
   git push https://x-access-token:$GITHUB_WORKFLOW_PAT@github.com/SeniorEng/Dashboard.git main:main
   ```
   Reine Code-/Doku-Pushes (ohne `.github/workflows/*`) gehen mit dem normalen Connector-Token durch. Details/Fallstricke zum PAT: Memory-Topic `ci-workflow-not-on-github`.
4. Verifizieren: Auf GitHub den neuen Commit-SHA auf `main` prüfen und den CI-Run abwarten. Grüner OpenAPI-Drift-Gate (`static-analysis`-Job) bestätigt, dass kein stale Drift mehr besteht.

### Automatisierter Sync (Task #1152)

Der manuelle Push ist fehleranfällig — wird er vergessen, driftet GitHub `main` wieder und CI testet alten Code. Deshalb kapselt **`scripts/github-sync.sh`** den kompletten Ablauf (Drift-Erkennung + Push) in einem wiederholbaren Skript:

```bash
bash scripts/github-sync.sh check   # Drift-Signal (read-only): SHA-Vergleich + OpenAPI-Check, Exit != 0 bei Drift
bash scripts/github-sync.sh push    # Pusht main nach GitHub, falls Drift; No-op wenn bereits in sync
```

- **Drift-Signal:** `check` vergleicht die lokale `main`-SHA (`git rev-parse HEAD`, Fallback `.git/refs/heads/main`) mit der Remote-SHA (GitHub-API `…/git/refs/heads/main`) und ruft zusätzlich `gen:openapi -- --check`. Exit-Code `0` = in sync + Spec aktuell; `1` = Drift (Sync nötig). Eignet sich als schneller Pre-Push-Check und als Health-Probe in einem Cronjob.
- **Token-Handling:** Das Skript pusht zuerst mit dem Standard-Connector-Token (`GITHUB_PERSONAL_ACCESS_TOKEN`) für reine Code-/Doku-Pushes. Scheitert der Push am fehlenden `workflow`-Scope (GH013 bei `.github/workflows/*`) **oder** ist kein Connector-Token vorhanden (z.B. im Deployment), fällt es automatisch auf den `GITHUB_WORKFLOW_PAT` (Classic-PAT mit `repo`+`workflow`) zurück. Nach erfolgreichem Push verifiziert es die Remote-SHA.
- **Idempotenz:** Ist GitHub bereits auf dem lokalen Stand, ist `push` ein No-op (kein leerer Push, kein Fehler) — gefahrlos beliebig oft ausführbar.

#### Cadence: Replit Scheduled Deployment

GitHub Actions kann den Sync NICHT übernehmen: ein Actions-Workflow läuft auf GitHub und kann den Replit-Projekt-Stand nicht „herziehen" — der Push muss von der Replit-Seite ausgehen (nur dort liegen Arbeitskopie + Connector-Token). Die kanonische, wiederkehrende Cadence auf Replit ist deshalb ein **Scheduled Deployment** (separat vom Web-App-Deployment):

1. Publishing-Tool → neues Deployment vom Typ **Scheduled** anlegen.
2. Run-Command: `bash scripts/github-sync.sh push`.
3. Schedule: z.B. stündlich (`0 * * * *`) — fängt vergessene Pushes innerhalb einer Stunde ab.
4. Sicherstellen, dass das Secret `GITHUB_WORKFLOW_PAT` im Deployment verfügbar ist (deckt als universeller Fallback alle Fälle inkl. Workflow-Dateien ab; `GITHUB_PERSONAL_ACCESS_TOKEN` ist im Deployment evtl. nicht gesetzt).

Die Logs des Scheduled Deployments zeigen pro Lauf das Drift-Signal und ob gepusht wurde. Einmalig vom Nutzer einzurichten (Publish), danach läuft der Sync ohne manuelle Schritte.

> **Hinweis Workflow-Scope-Henne-Ei:** Ein *neues* `.github/workflows/*.yml` würde über den normalen Connector-Sync nie auf GitHub landen (kein `workflow`-Scope). Deshalb wurde der Sync bewusst Replit-seitig als Skript + Scheduled Deployment gebaut, nicht als GitHub-Actions-Workflow. Bestehende Workflow-Dateien werden über den PAT-Fallback des Skripts mitgepusht.

### Drift früh erkennen

Der lokale `npm run gen:openapi -- --check` ist der schnellste Frühindikator: läuft er grün, ist die committete Spec konsistent mit dem Code, und nach einem Push läuft auch das CI-Gate grün. Geht er lokal rot, liegt echter Drift vor (Spec neu generieren), nicht nur ein Sync-Problem. Bequemer kapselt `bash scripts/github-sync.sh check` denselben Check plus den SHA-Vergleich gegen GitHub.

## Branch-Protection (aktiv)

`main` auf `SeniorEng/Dashboard` erzwingt die Required-Status-Checks `static-analysis`, `tests` und `e2e-smoke` (strict / „branch up to date") vor jedem Merge; Force-Pushes und Branch-Löschung sind gesperrt. PR-Reviews werden nicht erzwungen, damit Renovate grüne Patch-Updates weiterhin auto-mergen kann; `enforce_admins` ist aus (Admin-Notfall-Override möglich). Wichtig: Die CI-Job-Namen (`name:`) sind bewusst identisch mit den Job-IDs (`static-analysis`/`tests`/`e2e-smoke`), weil GitHub den Required-Check-Kontext über den Job-**Namen** matcht — bei abweichenden Anzeigenamen würden die Checks nie „grün" und jeder Merge (inkl. Renovate) bliebe blockiert. Eingerichtet via GitHub-API am 2026-05-28, bestätigt durch Repo-Admin `SeniorEng`. Verwaltung: Repo → Settings → Branches.
