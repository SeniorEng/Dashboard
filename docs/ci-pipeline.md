# CI-Pipeline (GitHub Actions)

Detail-Runbook zur Continuous-Integration-Pipeline von CareConnect. Übergeordneter
Projekt-README: [`../replit.md`](../replit.md). Lokale Test-Ausführung (Orchestrator,
Ephemeral-DB, Template-Cache) siehe [`test-infrastructure.md`](test-infrastructure.md);
Dependency-Automatisierung siehe [`dependency-management.md`](dependency-management.md).

## Pflicht-Gates

GitHub Actions (`.github/workflows/ci.yml`) läuft auf jedem **Pull-Request** sowie auf **Push nach `main`** (Trigger-Modell siehe [Kosten-Optimierung](#kosten-optimierung-task-1799)) mit 10 Pflicht-Gates:

1. `npm ci`
2. `tsc --noEmit`
3. `eslint --max-warnings 0`
4. `vitest run` (JUnit-Report als Artifact)
5. `vitest run tests/architecture/` (Fitness-Functions, eigenes Gate)
6. `npm audit --audit-level=high`
7. `npm run test:e2e:smoke` (Playwright)
8. Targeted-Coverage-Gates `tsx script/coverage-gate.ts <key>` (je ein CI-Step für `billing`, `qonto`, `consumption-engine`, `month-close-scheduler`)
9. `npm run gen:openapi -- --check` (OpenAPI-Spec-Drift, statisch im `static-analysis`-Job)
10. `npm run validate:erechnung` (E-Rechnungs-Validierung EN 16931 + PDF/A-3b, eigener Job `erechnung-validation` — Mustang/KoSIT EN-16931 + veraPDF PDF/A-3b; Detail: [`erechnung-validation.md`](erechnung-validation.md))
11. `vitest run tests/architecture/dev-db-scripts-guard.test.ts` (Dev-DB-Skript-Prod-Guards, statisch, **immer** — eigener Step im `static-analysis`-Job; Detail siehe unten)
12. `vitest run tests/architecture/sweep-dev-guard.test.ts` (Sweep-Skript-Prod-Guards, DB-frei, statisch, **immer** — eigener Step im `static-analysis`-Job; Detail siehe unten)

Die DB-/Server-abhängigen Gates (4, 5, 7, 8) brauchen die Repo-Secrets `TEST_USER_EMAIL` + `TEST_USER_PASSWORD` (Login gegen den in CI gestarteten App-Server) — fehlen sie (z.B. in Forks), werden diese Schritte sauber übersprungen, die statischen Gates (1, 2, 3, 6, 10, 11, 12) laufen immer (Gate 10 lädt zur Laufzeit Mustang + veraPDF und braucht Java, aber keine Test-User-Secrets).

### Kosten-Optimierung (Task #1799)

Fünf Verbrauchs-Hebel, die **keinen** der Pflicht-Gates und **nicht** die Branch-Protection schwächen:

- **Keine doppelten Runs (Trigger-Modell).** `push` triggert nur noch auf `main`, dazu `pull_request`. Vorher liefen Feature-Branch-Commits mit offenem PR **doppelt** (je ein `push`- UND ein `pull_request`-Run), weil die `concurrency`-Gruppe auf `github.ref` keyte und beide Events sich dort unterscheiden. Jetzt deckt ein Feature-Branch ausschließlich das `pull_request`-Event ab; direkte Pushes/Merges nach `main` laufen weiter die volle Suite. Die `concurrency`-Gruppe keyt für PRs auf die PR-Nummer (`github.event.pull_request.number`), für `main`-Pushes auf die Ref — superseded Runs des überlebenden Triggers werden korrekt gecancelt, ohne dass PR- und Push-Runs sich gegenseitig abbrechen. **Was auf `main` bzw. auf PRs nach `main` geprüft wird, ändert sich nicht.**
- **`timeout-minutes` pro Job.** Jeder Job hat ein großzügiges Hard-Limit (weit über der beobachteten Laufzeit, aber weit unter dem 6-h-Default): `static-analysis` 20, `tests-shard` 25, `tests` (Aggregator) 5, `e2e-smoke` 30, `template-cache-verify` 30, `mutation` 25, `erechnung-validation` 25, `changes` 5. Ein hängender Prozess (Server/Vitest/Browser/Download) wird so nach Minuten gekillt statt bis zum Default weiterzubillen.
- **Dependency-Installation: bewusst bei `npm ci` + `cache: npm` belassen.** Der `node_modules`-Cache-Hebel (Install über die 6 Jobs skippen) wurde **verworfen**: Ein restaurierter `node_modules` würde sowohl `npm ci` als auch den `postinstall`-Hook `normalize-lockfile.mjs` überspringen, und native/Toolchain-Binaries (esbuild, Playwright/Chromium, drizzle-kit) sind cache-empfindlich. Ohne beweisbare Cache-Sicherheit kostet ein Cache-Bug (flaky Jobs) mehr als die gesparte Installation. `cache: npm` (Download-Tarball-Cache) + `npm ci` + Lockfile-Registry-Guard + `postinstall`-Normalize-Hook bleiben unverändert.
- **Path-Gating der optionalen Schwer-Jobs (Branch-Protection-sicher).** Ein leichter `changes`-Job (`dorny/paths-filter`) ermittelt zentral, ob e-rechnungs- bzw. cache-relevante Pfade geändert wurden. `template-cache-verify` (KEIN Required-Check) wird bei irrelevanten PR-Änderungen komplett übersprungen (`if: push || template_cache` ⇒ ein Skip lässt keinen Merge „pending" hängen). `erechnung-validation` (**Required-Check**) läuft dagegen **immer** als Job und meldet grün — das Java-freie **Strict-WASM-XSD-Gate läuft unbedingt**; nur der teure Java-Download + Mustang/veraPDF-Lauf ist auf relevante Pfade (oder `main`-Push) gegated. So bleibt kein Required-Kontext „pending", aber ein docs-only-PR spart den Java-Teil.
- **Artefakte schlanker.** Schwere Artefakte (Playwright-Report/Traces/Video, Coverage, Test-Reports, knip-, mutation-Report) werden nur noch **bei Fehlschlag** (`if: failure()`) hochgeladen und die Retention auf 3 Tage gekürzt (vorher 7).

**Deployment-Build (Autoscale, `npm run build`):** bewusst **nicht** angefasst — kein klar sicherer Cheap-Win ohne Prod-Debuggability-Verlust (Vite + esbuild-Minify + hidden Sourcemaps + OpenAPI-Gen), Scope bleibt CI-seitig.

### Dev-DB-Skript-Prod-Guards als eigenes Gate (Task #1436)

Die Dev-DB-Helfer `scripts/backup-dev-db.sh` und `scripts/reseed-dev-db.sh` sind **zerstörerisch** (Reseed = `DROP SCHEMA public CASCADE`). Ihre Prod-Schutz-Guards (Abbruch bei `NODE_ENV=production`, prod-aussehendem DB-Host, nicht extrahierbarem Host = fail-closed, sowie `DATABASE_URL`-Host == `PROD_DATABASE_URL`-Host) werden vom Black-Box-Guard-Test `tests/architecture/dev-db-scripts-guard.test.ts` (Task #1435) abgesichert.

Dieser Test liegt im `tests/architecture/`-Verzeichnis (Vitest-Project `unit`) und liefe daher ohnehin in Gate 4 (`vitest run`) und Gate 5 (`vitest run tests/architecture/`) mit — **aber** beide sind DB-/Server-Gates und auf gesetzte `TEST_USER_*`-Secrets gegated; in Forks ohne Secrets würden sie übersprungen. Damit eine Regression der Prod-Guards den Merge **deterministisch** blockiert, läuft der Schutz-Check zusätzlich als eigener, klar benannter Step **`Dev-DB scripts prod-guard (dev-db-scripts-guard)`** im immer laufenden `static-analysis`-Job. Der Test braucht weder DB noch Server (Fake-`.example`-Hosts lösen als NXDOMAIN auf), nur `bash` + `pg_dump`/`psql` (auf `ubuntu-latest` vorinstalliert), und ist damit deterministisch grün/rot.

### Sweep-Skript-Prod-Guards als eigenes Gate (Task #1439)

Schwester zu Gate 11: Das Sweep-Skript `server/scripts/sweep-dev-test-data.ts` (npm `db:sweep-dev -- --apply`) ist ebenfalls **zerstörerisch** (Bulk-Purge des Test-Pattern-Backlogs). Seine zeichengleichen Prod-Schutz-Guards (`NODE_ENV=production`, prod-aussehender Host, fail-closed bei nicht extrahierbarem Host, `DATABASE_URL`-Host == `PROD_DATABASE_URL`-Host) liegen seit Task #1439 DB-frei in `server/lib/dev-db-guard.ts` (aus dem Skript herausgelöst, Wrapper re-exportiert sie). So kann der reine Unit-Test `tests/architecture/sweep-dev-guard.test.ts` sie abdecken, **ohne** `server/lib/db` zu importieren.

Vorher deckte nur `tests/test-data-cleanup-sweep-guard.test.ts` die Guards ab — dieser Test importiert über das Sweep-Skript transitiv das DB-Modul und liegt deshalb im `integration`-Vitest-Project (Secret-/DB-gegatete Gates 4/5), würde also in Forks ohne `TEST_USER_*`-Secrets übersprungen. Damit eine Regression der Sweep-Prod-Guards **deterministisch** blockiert, läuft der DB-freie Schutz-Check als eigener, klar benannter Step **`Sweep script prod-guard (sweep-dev-guard)`** im immer laufenden `static-analysis`-Job. Der verbleibende DB-GEBUNDENE Teil (DRY-RUN `runSweep(false)` ändert nichts) bleibt im `integration`-Test.

### Crash-Recovery-Smoke als nächtlicher Eigen-Job (Task #1493)

Das Test-Runner-Sicherheitsnetz gegen PID-Erschöpfung (Prozess-/DB-/Log-/Artefakt-Sweep + PID-Preflight, Task #1489/#1490) hat seine **Gesamt-Garantie** im Smoke-Test `tests/unit/ephemeral-db-restart-after-crash-smoke.test.ts` (Task #1492): ein kompletter Orchestrator-Lauf, der NACH einem simulierten Hart-Abbruch (verwaister, auf init reparenteter Test-Server-Prozess + verwaiste `cc_test_`-Wegwerf-DB) trotzdem grün durchläuft. Dieser Test ist bewusst **nicht** in Gate 4 (`vitest run`) aktiv — er bootet einen echten App-Server und wartet > 30s auf die Prozess-Sweep-Altersgrenze (zu schwer für den per-PR-Fast-Path, und ein zweiter Orchestrator IM Orchestrator). Er läuft nur on-demand via `npm run test:restart-smoke` (= `EPHEMERAL_RESTART_SMOKE=1`).

Damit eine Regression der Sweep-/PID-Preflight-Maschinerie **nicht** erst auffällt, wenn sie einen Entwickler real blockiert, fährt der eigene Workflow `.github/workflows/crash-recovery-smoke.yml` diesen Smoke-Check **nächtlich** (cron `0 4 * * *`) und auf Knopfdruck (`workflow_dispatch`). Bewusst ein **eigener Workflow** (nicht in `ci.yml`), denn er läuft nur auf `schedule`/`workflow_dispatch` und kann damit nie gleichzeitig mit den per-Push/PR getriggerten Jobs `tests`/`e2e-smoke` laufen — konkurrierende Orchestratoren würden ihn über das gemeinsame Cluster-Worker-Budget / PID-Limit aushungern (siehe Test-Header + `flaky-tests.md`, `validation-env-concurrency`). Die `concurrency`-Gruppe `crash-recovery-smoke` verhindert zusätzlich zwei überlappende eigene Läufe. Der Job nutzt dieselbe Postgres-+-Neon-Proxy-Service-Topologie wie der `tests`-Job (DB-Sweep/-Klon + drizzle-kit push direkt nach 5432, App-Server-Boot über den Proxy), pusht Schema + seedet idempotent (ohne Secrets sauberer Skip), führt `npm run test:restart-smoke` aus und hängt bei jedem Ausgang die komplette Orchestrator-Ausgabe als Artefakt `crash-recovery-smoke-log` an. Da der Job rein nächtlich/manuell läuft, ist er **kein** Required-Status-Check für Merges (Branch-Protection: `static-analysis`/`tests`/`e2e-smoke`/`erechnung-validation`) — er bleibt bewusst aus dem per-PR-Fast-Path heraus.

**Alarmierung bei Fehlschlag (Task #1495):** Weil dieser Job kein Required-Check ist, würde ein roter nächtlicher Lauf sonst nur als leicht überseh­bare GitHub-Standard-Mail untergehen und auf einem aktiven Repo tagelang unbemerkt bleiben — genau das „fällt erst auf, wenn es einen Entwickler blockiert"-Szenario, das das ganze Testnetz verhindern soll. Deshalb hat der Workflow `issues: write` und zwei `actions/github-script`-Steps am Ende: Bei **Fehlschlag** (`if: failure()`) öffnet er ein Tracking-Issue mit dem eindeutigen Label `crash-recovery-smoke-alert` (inkl. Link auf den fehlgeschlagenen Lauf + Hinweis auf das `crash-recovery-smoke-log`-Artefakt); existiert bereits ein offenes Alarm-Issue mit diesem Label, wird es stattdessen nur kommentiert (nie mehrere parallele Alarme). Bei **Erfolg** (`if: success()`) schließt er ein ggf. offenes Alarm-Issue wieder mit Entwarnungs-Kommentar, sodass es nicht weiter nervt. Das Label wird im Failure-Step idempotent angelegt (HTTP 422 „existiert bereits" wird ignoriert). Diese Alarmierung ändert **nichts** an der Branch-Protection — sie koppelt keinen neuen Required-Status-Check an.

### Targeted-Coverage-Gates: Skip ohne Object Storage (Task #1330)

Object-storage-abhängige Coverage-Gates (Gate 8, aktuell `billing`) skippen sauber, wenn kein Object Storage konfiguriert ist. Die GitHub-Actions-CI hat **keinen** Object-Storage-Sidecar (dokumentierte Entscheidung), deshalb sind `PRIVATE_OBJECT_DIR`/`PUBLIC_OBJECT_SEARCH_PATHS` dort nicht gesetzt und die PDF-/Leistungsnachweis-Tests in `tests/billing/billing-flow.test.ts` skippen via `it.skipIf(!hasObjectStorageEnv)`. Ohne diese Tests bricht die gemessene Coverage von `server/routes/billing.ts` von ~55 % auf ~24 % ein — was den (mit Object Storage kalibrierten) Floor verfehlen würde, obwohl es nur die Umgebungslücke spiegelt und keine echte Regression ist.

`script/coverage-gate.ts` markiert solche Gates mit `requiresObjectStorage: true` und überspringt sie dann mit einer expliziten Log-Zeile und **Exit 0** — gleiches CI-Muster wie „erechnung ohne Java" / „ci-seed ohne Secrets". **In der Replit-Dev-Umgebung (Object Storage vorhanden) läuft das Gate unverändert und erzwingt die Schwellen (Lines ≥55 % / Branches ≥45 %).** Die Object-Storage-Erkennung ist identisch zu `tests/helpers/object-storage.ts`. Nicht-object-storage-abhängige Gates (`qonto`, `consumption-engine`, `month-close-scheduler`) sind unberührt. Schwellen-Details und das Hinzufügen neuer Gates: [`../tests/README.md`](../tests/README.md).

## npm-Registry-Normalisierung (package-firewall)

In Replit löst npm Pakete über den internen Mirror `http://package-firewall.replit.local/npm/…` auf. Dieser Host ist NUR innerhalb von Replit erreichbar — stünde er in den `resolved`-URLs des committeten `package-lock.json`, bräche `npm ci` auf GitHub-Runnern mit `EAI_AGAIN` ab und legte ALLE Jobs lahm.

Die URLs landen im Lockfile, weil die `npm_config_registry`-Env-Var in Replit auf die Firewall zeigt UND der Firewall-Mirror die Tarball-URLs seiner Packuments bereits mit Firewall-Host ausliefert. Ein `.npmrc registry`-Override oder `replace-registry-host` reicht deshalb NICHT — die Env-Var übersteuert die `.npmrc`, und der Host steckt schon in den Tarball-URLs.

Stattdessen normalisiert ein **postinstall-Hook** (`scripts/normalize-lockfile.mjs`, verdrahtet als `postinstall` in `package.json`) das Lockfile direkt an der Quelle: nach jeder Installation werden `http://package-firewall.replit.local/npm/`-URLs idempotent auf `https://registry.npmjs.org/` zurückgeschrieben (identische Tarballs, die Integrity-Hashes bleiben gültig). So bleibt das committete `package-lock.json` dauerhaft sauber — CI braucht KEIN per-Step-`sed` mehr, `npm ci` läuft auf den Runnern direkt durch. Lokale Replit-Installationen funktionieren unverändert (Fetch weiter über die Firewall via Env-Var, nur das Lockfile wird im Anschluss normalisiert). `registry.npmjs.org` ist sowohl aus Replit als auch aus CI erreichbar. Ein zusätzliches `.npmrc` setzt die öffentliche Registry als Repo-Default (greift außerhalb von Replit, wo keine Env-Var gesetzt ist).

**Lockfile-Guard (Task #1163):** Weil der postinstall-Hook nur lokal greift, kann ein mit `npm ci --ignore-scripts` (Hook übersprungen) erzeugtes, schmutziges Lockfile unbemerkt committet werden. Damit das nicht erst in CI durch ein `npm ci`-`EAI_AGAIN` auffällt, läuft im Job `static-analysis` ein zusätzlicher Step **vor** `npm ci`: `node scripts/normalize-lockfile.mjs --check`. Dieser `--check`-Modus schreibt NICHT, sondern failed hart (Exit 1) inkl. Zeilennummern und Fix-Hinweis (`node scripts/normalize-lockfile.mjs` / postinstall-Hook), sobald der Firewall-Host im Lockfile steht — reiner Node-Bordmittel-Check, ohne installierte Dependencies. Als zweites, lokal/in `vitest run` greifendes Sicherheitsnetz prüft die Fitness-Function `tests/architecture/no-firewall-url-in-lockfile.test.ts` dieselbe Invariante.

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
- **Token-Handling:** Das Skript pusht zuerst mit dem Standard-Connector-Token (`GITHUB_PERSONAL_ACCESS_TOKEN`) für reine Code-/Doku-Pushes. Scheitert der Push am fehlenden `workflow`-Scope (GH013 bei `.github/workflows/*`) **oder** ist kein Connector-Token vorhanden (z.B. im Deployment), fällt es automatisch auf den `GITHUB_WORKFLOW_PAT` (Classic-PAT mit `repo`+`workflow`) zurück.
- **Token-bewusste Verifikation (Task #1483):** Nach einem erfolgreichen Push liest das Skript die Remote-SHA bevorzugt mit **demselben Token, der den Push authentifiziert hat**, und probiert sonst beide Token durch — es zählt nur ein HTTP-`200`. Ein abgelaufener Connector-Token (401) maskiert damit kein erfolgreiches Lesen mehr und erzeugt keine falsche `WARNUNG: Remote-SHA … unbekannt` nach einem in Wahrheit gelungenen Push. Lässt sich die Remote-SHA mit keinem Token gegenlesen, gibt es einen neutralen `HINWEIS` (Push gilt trotzdem als erfolgreich), keine `WARNUNG`.
- **Sichtbares Fehlersignal bei totem/abgelaufenem Token (Task #1483):** Ein fehlgeschlagener Push ist kein stiller No-op mehr — das Skript beendet sich mit **Exit-Code `1`** (das Scheduled Deployment markiert den Lauf damit als fehlgeschlagen) und loggt eine actionable Meldung. Bei erkanntem Auth-Fehler (401/403 / „Authentication failed" / „Bad credentials") lautet sie explizit: *„Token ungültig/abgelaufen. GITHUB_WORKFLOW_PAT (Scope repo+workflow) in den Deployment-Secrets erneuern."* — so wird ein abgelaufenes PAT sofort sichtbar, statt dass der Backlog stillschweigend wächst.
- **Idempotenz:** Ist GitHub bereits auf dem lokalen Stand, ist `push` ein No-op (kein leerer Push, kein Fehler) — gefahrlos beliebig oft ausführbar.

#### Zwei Auslöser im Arbeitsrhythmus (Task #1249)

Der Sync ist fest in den Rhythmus eingebunden und läuft über **zwei sich ergänzende Auslöser**:

1. **Nach jedem Merge (Post-Merge):** `scripts/post-merge.sh` ruft am Ende `bash scripts/github-sync.sh push` auf. Das ersetzt den manuellen, leicht zu vergessenden `git push` nach einem gemergten Task. Der Aufruf ist **best-effort**: er läuft unter einem 60-s-Timeout und mit `|| true`, ein Sync-Fehler (fehlender Token im Merge-Kontext, GitHub kurz nicht erreichbar) blockiert den Merge also NIE — die stündliche Kadenz holt ihn dann nach.
2. **Stündliche Kadenz (Scheduled Deployment):** fängt alles auf, was der Post-Merge-Push ausgelassen hat (z.B. direkte Commits ohne Merge oder ein im Merge fehlgeschlagener Sync). Siehe unten.

Drift-Signal jederzeit manuell prüfbar: `npm run sync:check` (= `bash scripts/github-sync.sh check`, read-only). Empfohlene Kadenz für das Scheduled Deployment: **stündlich** (`0 * * * *`).

#### Cadence: Replit Scheduled Deployment

GitHub Actions kann den Sync NICHT übernehmen: ein Actions-Workflow läuft auf GitHub und kann den Replit-Projekt-Stand nicht „herziehen" — der Push muss von der Replit-Seite ausgehen (nur dort liegen Arbeitskopie + Connector-Token). Die kanonische, wiederkehrende Cadence auf Replit ist deshalb ein **Scheduled Deployment** (separat vom Web-App-Deployment):

1. Publishing-Tool → neues Deployment vom Typ **Scheduled** anlegen.
2. Run-Command: `bash scripts/github-sync.sh push`.
3. Schedule: z.B. stündlich (`0 * * * *`) — fängt vergessene Pushes innerhalb einer Stunde ab.
4. Sicherstellen, dass das Secret `GITHUB_WORKFLOW_PAT` im Deployment verfügbar ist (deckt als universeller Fallback alle Fälle inkl. Workflow-Dateien ab; `GITHUB_PERSONAL_ACCESS_TOKEN` ist im Deployment evtl. nicht gesetzt).

Die Logs des Scheduled Deployments zeigen pro Lauf das Drift-Signal und ob gepusht wurde. Einmalig vom Nutzer einzurichten (Publish), danach läuft der Sync ohne manuelle Schritte. Ein Task-Agent kann KEIN Deployment anlegen (Publish ist Nutzer-Aktion) und das `.replit`-`[deployment]`-Feld trägt bereits das Autoscale-Web-App-Deployment — das Scheduled Deployment ist ein **separates** Deployment-Objekt, das im Publishing-Tool erstellt wird, nicht in `.replit`.

#### Einmaliger Divergenz-Reconcile (wenn GitHub `main` bereits abgedriftet ist)

Im Normalbetrieb ist jeder Sync-Push ein Fast-Forward (GitHub `main` ist Vorfahre des lokalen Stands) — das Skript reicht. Ist GitHub `main` aber bereits *divergiert* (eigene GitHub-only-Commits, die nicht in der lokalen Historie liegen, z.B. ein direkt auf GitHub editierter Commit), wird der normale Push als `non-fast-forward` abgelehnt. Dann gilt:

1. **Divergenz prüfen:** GitHub-only-Commits gegen den lokalen Stand vergleichen (Merge-Base + `git log local..github`) und entscheiden, ob ihr Inhalt schon durch lokale Commits abgedeckt/abgelöst ist (dann verwerfbar) oder noch gewollt ist (dann zuerst lokal übernehmen).
2. **Force-Push nötig:** Damit der *Steady-State*-Sync weiter über Fast-Forward funktioniert, muss GitHub `main` exakt auf den lokalen SHA gesetzt werden (kein Merge-Commit — der würde künftige Fast-Forward-Pushes brechen, da der nächste lokale Commit nicht von einem GitHub-seitigen Merge-Knoten abstammt). Das erfordert einen Force-Push.
3. **Branch-Protection blockt Force-Push — auch für Admins.** `allow_force_pushes=false` lehnt den Force-Push per Pre-Receive-Hook mit `GH006` ab, selbst mit Admin-Token und `enforce_admins=false` (Admin-Override gilt für Required-Checks/Reviews, NICHT für Force-Push). Reconcile daher: per GitHub-API kurzzeitig `allow_force_pushes=true` setzen (vollständiges Protection-Objekt via `PUT …/branches/main/protection` — alle anderen Felder, v.a. die Required-Check-Kontexte + `app_id`s, unverändert lassen), Force-Push mit `--force-with-lease` ausführen, dann `allow_force_pushes` sofort wieder auf `false` zurücksetzen. Verifizieren, dass Remote-SHA == lokaler SHA und die Protection wieder im Ausgangszustand ist.

> **Hinweis Workflow-Scope-Henne-Ei:** Ein *neues* `.github/workflows/*.yml` würde über den normalen Connector-Sync nie auf GitHub landen (kein `workflow`-Scope). Deshalb wurde der Sync bewusst Replit-seitig als Skript + Scheduled Deployment gebaut, nicht als GitHub-Actions-Workflow. Bestehende Workflow-Dateien werden über den PAT-Fallback des Skripts mitgepusht.

### Drift früh erkennen

Der lokale `npm run gen:openapi -- --check` ist der schnellste Frühindikator: läuft er grün, ist die committete Spec konsistent mit dem Code, und nach einem Push läuft auch das CI-Gate grün. Geht er lokal rot, liegt echter Drift vor (Spec neu generieren), nicht nur ein Sync-Problem. Bequemer kapselt `bash scripts/github-sync.sh check` denselben Check plus den SHA-Vergleich gegen GitHub.

## Test-Gate: drei Shard-Legs + Aggregator

Der volle Vitest-Lauf lief bis 11.08.2026 sequenziell in EINEM Job `tests` (~19 min von ~22 min Job-Laufzeit) und war der alleinige Wall-Clock-Treiber der Pipeline — alle anderen Jobs sind nach ≤ 4 min fertig und warteten. Ursache war nicht die Testmenge, sondern fehlende Parallelität: das `integration`-Project in `vitest.config.ts` pinnt `minWorkers`/`maxWorkers`/`fileParallelism` auf `EPHEMERAL_DB_WORKERS`, und CI setzt diese Env nicht.

Seither läuft das Gate als Matrix **`tests-shard`** mit `--shard=i/3` — drei Legs, jedes mit eigener Postgres-Instanz, eigenem Neon-Proxy und eigenem App-Server auf Port 5000. Gemessener kritischer Pfad: **~8:30 statt ~22:00**. Preis: 3× Runner-Minuten für dieses Gate (~22 → ~26–27 min), also eine bewusste Gegenbewegung zu den Sparhebeln oben.

**Der Required Check heißt weiterhin `tests`** — das ist der Aggregator-Job, der nichts ausführt, sondern nur `needs.tests-shard.result` auswertet: grün nur, wenn ALLE Legs grün sind, `skipped` und alles andere rot. Er trägt `if: always()`, damit ein rotes Leg zu einem roten Kontext führt statt zu einem übersprungenen.

Was dabei zu beachten ist:

- **Coverage-Gates laufen nur auf Leg 3.** Sie fahren eigene, fest gepinnte Testlisten. `qonto` (Modus `server`) misst allerdings den DB-Reststand des jeweiligen Hauptlaufs mit — 80,0 % Branches im Shard-Betrieb gegen 81,5 % im alten Einzellauf, bei Floor 72.
- **Architektur-Fitness läuft in JEDEM Leg.** Der Gate-Meta-Check (`scripts/assert-gate-ran.ts`) verlangt beide JUnit-Reports im selben Arbeitsverzeichnis und darf laut `tests/architecture/gate-meta-check.test.ts` weder ein `if:` tragen noch mehrfach im YAML stehen.
- **Matrix und Nenner sind gekoppelt geprüft.** `tests/architecture/ci-shard-partition.test.ts` erzwingt, dass die Matrix-Werte lückenlos `1..N` sind und jede `--shard=…/N`-Stelle denselben Nenner `N` trägt. Ohne diesen Wächter könnte eine auf `[1, 2]` gekürzte Matrix mit stehengebliebenem `/3` ein Drittel der Suite still überspringen, bei durchweg grünem Lauf.
- **Die Leg-Zuordnung wandert.** Vitest shardet über einen SHA1-Sort der Dateipfade mit Slice-Grenzen bei ⌊n/3⌋. Jede hinzugefügte oder entfernte Testdatei verschiebt die Grenzen. Siehe `docs/flaky-tests.md` → „Wandernde Shard-Zuordnung".

## Branch-Protection (aktiv)

`main` auf `SeniorEng/Dashboard` erzwingt die Required-Status-Checks `static-analysis`, `tests`, `e2e-smoke` und `erechnung-validation` (strict / „branch up to date") vor jedem Merge; Force-Pushes und Branch-Löschung sind gesperrt. PR-Reviews werden nicht erzwungen, damit Renovate grüne Patch-Updates weiterhin auto-mergen kann; `enforce_admins` ist aus (Admin-Notfall-Override möglich). Wichtig: Die CI-Job-Namen (`name:`) sind bewusst identisch mit den Job-IDs (`static-analysis`/`tests`/`e2e-smoke`/`erechnung-validation`), weil GitHub den Required-Check-Kontext über den Job-**Namen** matcht — bei abweichenden Anzeigenamen würden die Checks nie „grün" und jeder Merge (inkl. Renovate) bliebe blockiert. Seit dem Shard-Umbau ist `tests` **nicht mehr der DB-Job selbst**, sondern der Aggregator über die Matrix-Legs `tests-shard (1|2|3)` (Details oben). Eine Matrix erzeugt Kontexte mit dem Leg im Namen und könnte den Kontext `tests` deshalb nie erfüllen — der Aggregator existiert genau dafür. Die Required-Liste bleibt damit unverändert; die drei `tests-shard (N)`-Kontexte zusätzlich als Required zu setzen ist möglich, aber nicht nötig. Eingerichtet via GitHub-API am 2026-05-28, bestätigt durch Repo-Admin `SeniorEng`; `erechnung-validation` als vierter Required-Check ergänzt am 2026-06-10 (nachdem der Job erstmals real grün lief). Verwaltung: Repo → Settings → Branches.
