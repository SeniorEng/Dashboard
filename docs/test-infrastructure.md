# Test-Infrastruktur: Configs, Orchestrator & Template-Cache

Überblick über die Test-Pipeline von CareConnect: welcher Befehl welche
Vitest-Config nutzt, wie der Ephemeral-DB-Orchestrator isolierte Wegwerf-DBs +
App-Server bereitstellt und wie der Template-Cache wiederholte Läufe beschleunigt.

> Diese Seite ist die High-Level-Landkarte. Tiefe Betriebs-Details (Worker-Zahl,
> PID-Limits, CI-Gates) stehen in `replit.md` unter **Run & Operate**; das
> Mutation-Runbook in [`docs/mutation-testing.md`](mutation-testing.md).

## Befehl → Config → Pipeline-Schicht

| Befehl | Vitest-Config | Pipeline-Schicht |
|---|---|---|
| `npm run test` (= `vitest run`) | `vitest.config.ts` (Projects `unit` + `integration`) | Direkt gegen Dev-Server/-DB (1 Worker, sequenziell) — z.B. für gezielte Einzelläufe. |
| Workflow `test` | `vitest.config.ts` | Orchestrator `scripts/with-ephemeral-db.ts` → isolierte Per-Worker-Wegwerf-DBs + dedizierte App-Server (Datei-Parallelität). |
| Workflow `e2e-smoke` / `npm run test:e2e:smoke` | (Playwright, `playwright.config.ts`) | Orchestrator (1 Worker) + vorgebauter Vite-Client, statisch ausgeliefert. |
| `npm run mutation` | `vitest.stryker-vitest.config.ts` **und** `vitest.stryker.config.ts` | Stryker (2 Profile, `scripts/run-mutation.mjs`), rein gegen pure `shared/`-Module — KEINE DB. |

## Die vier Vitest-Configs (Task #930)

`vitest.config.ts` ist die **Single-Source-of-Truth**. Es exportiert ein
geteiltes `baseConfig` (Modul-Aliase, JSX-Transform, `globals`/`environment`/
`isolate`). Die anderen Configs erweitern diese Basis via `mergeConfig` und
tragen nur noch ihre Deltas — kein Setting ist über Dateien dupliziert.

- **`vitest.config.ts`** — Default-Export: `baseConfig` + zwei Vitest-Projects.
  - `unit`: reine Logik-/Fitness-Tests (`tests/unit/**`, `tests/architecture/**`),
    **parallel**, kein Server/DB. Schnelles Feedback.
  - `integration`: alle übrigen `tests/**`. Datei-Parallelität nur über
    GETRENNTE Per-Worker-DBs (vom Orchestrator gesetzt; ohne ihn 1 Worker /
    sequenziell). Eigenes `globalSetup` (wartet auf `/api/health`).
- **`vitest.stryker-vitest.config.ts`** — Stryker-Profil "vitest" (native
  `@stryker-mutator/vitest-runner`). `include` eng auf die DETERMINISTISCHEN
  Hotspot-Module gepinnt, kürzere Timeouts, kein `globalSetup`/`projects`.
- **`vitest.stryker.config.ts`** — Stryker-Profil "command" (Command-Runner,
  pro Mutant frischer Kindprozess). `include` eng auf die PROPERTY-basierten
  (fast-check) Module gepinnt, die den nativen Runner zum Hängen bringen.

Beim Aufnehmen eines neuen Hotspot-Moduls: Test-Datei in die passende
`include`-Liste **und** das Modul in die `mutate`-Liste des passenden
Stryker-Profils (`stryker.vitest.conf.mjs` bzw. `stryker.command.conf.mjs`)
eintragen.

## Ephemeral-DB-Orchestrator (`scripts/with-ephemeral-db.ts`)

Bricht in Production hart ab und arbeitet ausschließlich auf DBs mit Präfix
`cc_test_`. Pro Lauf:

1. **Orphan-Sweep** — verwaiste `cc_test_%`-DBs aus hart abgebrochenen Läufen
   aufräumen (nur verbindungslose, >15 Min alte; Cache-DB geschützt).
2. **Template bereitstellen** — eine geseedete Per-Lauf-Template-DB (Schema-Push
   + Superadmin + Basis-Referenzdaten), bevorzugt aus dem Cache geklont (s.u.).
3. **Worker provisionieren** — pro Worker (Default 2 für Vitest, 1 für e2e) eine
   eigene Wegwerf-DB `cc_test_<id>_w<N>` (aus der Template geklont) + ein
   dedizierter App-Server auf frei vom OS vergebenem Port. Server werden einmal
   pro Lauf via esbuild gebündelt (`node <bundle>` statt `tsx`, schnellerer Boot).
4. **Testlauf** — Vitest verteilt Dateien über die Worker; jeder Worker fährt
   sequenziell gegen SEINE DB (keine Cross-Datei-Kontamination).
5. **Teardown** — Server killen, alle Wegwerf-DBs + Bundle/Client droppen (auch
   im Fehlerfall).

Wichtige Env-Schalter: `EPHEMERAL_DB_WORKERS` (Worker-Anzahl),
`EPHEMERAL_DB_CACHE=0` (Cache aus), `EPHEMERAL_DISABLE_BUNDLE=1` (tsx-Boot),
`EPHEMERAL_PROVISION_ONLY=1` (nur Template bereitstellen, für Cache-Verify).
Der `<portHint>`-Arg ist nur noch Kompatibilität — die echten Ports werden frei
vergeben.

## Template-Cache (`scripts/lib/template-cache.ts`)

Der teure Fixkosten-Block ist nicht der Server-Boot, sondern der Template-Aufbau
(`drizzle-kit push --force` + Seeds). Der Cache hält EINE persistente,
geseedete Cache-DB `cc_test_tmpl_cache` vor, verschlüsselt über einen SHA-256-Hash
von `shared/schema/**`, `drizzle.config.ts` und den beiden Seed-Skripten
(hinterlegt als `COMMENT ON DATABASE`).

- **Warm** (Hash passt): Push + Seeds übersprungen, Per-Lauf-Template direkt aus
  dem Cache geklont → Sekunden statt ~24s.
- **Cold** (Cache fehlt/veraltet): Cache einmalig neu gebaut, danach warm.
  Konkurrierende kalte Aufbauten werden über einen Postgres-Advisory-Lock
  serialisiert.

Ändert sich Schema oder ein Seed-Skript, invalidiert der Hash den Cache
automatisch — kein manuelles Drop nötig. Die reine Entscheidungs-/Hash-Logik ist
in `tests/unit/template-cache.test.ts` gepinnt.

Manuelle Werkzeuge: `npm run test:sweep-dbs` (verwaiste DBs/Logs/Prozesse aufräumen),
`npm run test:unblock` (= `--force`: PID-Limit-Notfall-Aufräumung, ignoriert die
Altersgrenze), `npm run test:verify-cache` (Warm-/Kalt-Pfad messen).

## PID-Limit & verwaiste Prozesse (Task #1489)

Der Workspace-Container hat ein cgroup-PID-Limit (`pids.max`, typ. 1024). Hart
abgebrochene Testläufe (SIGKILL, Container-Crash) ließen früher ihre Test-App-
Server **und deren Chromium-Enkel** (PDF-Rendering) als Waisen zurück — sie wurden
auf init reparentet und fraßen PIDs, bis neue Läufe an `spawn EAGAIN` scheiterten.

Schutz (alles fail-safe, blockiert Tests nie):
- **Auto-Prozess-Sweep**: Der Orchestrator (`scripts/with-ephemeral-db.ts`) killt
  beim Start zusätzlich zu DBs/Logs auch verwaiste Test-Prozesse. Erkannt werden
  NUR eindeutig markierte Test-Prozesse (`.local/test-server-*.cjs`-Bundle bzw.
  Chromium-User-Data-Dir `careconnect-chromium-test-`), die auf init reparentet
  sind (PPID 1) und die Altersgrenze überschreiten. Ein laufender Schwester-Lauf
  (PPID ≠ 1) bleibt unberührt; der eigene Prozess/init nie.
- **Eigene Prozessgruppe**: Worker-Server werden `detached` gestartet; `killServers`
  killt per `kill(-pid)` die ganze Gruppe inkl. Chromium-Enkel, plus ein
  `process.on("exit")`-Reaper als letzte Absicherung.
- **PID-Preflight**: Nach dem Sweep prüft der Orchestrator die PID-Auslastung
  (`EPHEMERAL_PID_PREFLIGHT_RATIO`, Default 0.8); ist sie weiterhin zu hoch, bricht
  er mit Anleitung (`npm run test:unblock`) ab statt mitten im Lauf zu scheitern.
  Abschaltbar via `EPHEMERAL_PID_PREFLIGHT=0`.
- **Worker-Slot-Gate**: Mehrere gleichzeitige Orchestrator-Läufe (Auto-Run +
  Validation) teilen sich ein gemeinsames Worker-Budget per Postgres-Advisory-Lock
  (`EPHEMERAL_GLOBAL_WORKER_BUDGET`, Default 4; `0` deaktiviert), damit ihre
  Worker-Server-/Chromium-Bäume in Summe das PID-Limit nicht sprengen.

Die reine Entscheidungslogik (`selectOrphanProcesses`, `evaluatePidPreflight`,
`parsePsOutput`, `classifyTestProcess`) ist in
`tests/unit/ephemeral-db-process-sweep.test.ts` gepinnt.

Den **echten Prozess-Kill** end-to-end (Double-Fork-Waise auf init, Marker-
Erkennung, realer SIGKILL) deckt `tests/unit/ephemeral-db-process-sweep-e2e.test.ts`
ab. Die **Gesamt-Garantie** — „ein abgestürzter Lauf blockiert den nächsten nicht" —
liefert der Smoke-Test `tests/unit/ephemeral-db-restart-after-crash-smoke.test.ts`
(Task #1492): er simuliert den Zustand nach einem Hart-Abbruch (verwaister, auf init
reparenteter, marker-tragender Test-Server-Prozess **und** eine verwaiste, alt genug
datierte `cc_test_`-Wegwerf-DB) und startet danach einen echten, kleinen
Orchestrator-Lauf (1 Worker, triviales Kommando, API-only-Pfad), der **grün** endet —
Beweis, dass Sweep + PID-Preflight beim Start greifen und der Lauf nicht an
`spawn EAGAIN` scheitert. Weil er einen vollständigen App-Server bootet und > 30s auf
die Prozess-Sweep-Altersgrenze wartet, läuft er **nicht** im Standard-`npm run test`,
sondern nur on-demand: `npm run test:restart-smoke` (= `EPHEMERAL_RESTART_SMOKE=1`).

Damit eine Regression dieser Sweep-/PID-Preflight-Maschinerie nicht erst auffällt,
wenn sie real einen Entwickler blockiert, läuft der Smoke-Check zusätzlich
**automatisch nächtlich** als eigener GitHub-Actions-Workflow
`.github/workflows/crash-recovery-smoke.yml` (Task #1493, cron `0 4 * * *` +
`workflow_dispatch`). Er ist bewusst ein **eigener** Workflow (nur `schedule`/
`workflow_dispatch`), damit er nie gleichzeitig mit den schweren `tests`/`e2e-smoke`-
Jobs läuft — konkurrierende Orchestratoren würden ihn aushungern. Bei Fehlschlag
hängt der Job die komplette Orchestrator-Ausgabe als Artefakt
`crash-recovery-smoke-log` an. Detail: [`ci-pipeline.md`](ci-pipeline.md#crash-recovery-smoke-als-nächtlicher-eigen-job-task-1493).

## LetterXpress mocken (node:https, NICHT fetch)

Der LetterXpress-v2-Postversand-Transport (`server/services/letterxpress-http.ts`)
spricht bewusst über `node:https` direkt — weil die LXP-v2-API einen Request-Body
auch an `GET /v2/balance` verlangt, was `fetch`/undici verbietet. **Folge:** Ein
`vi.stubGlobal("fetch", …)` fängt LetterXpress-Aufrufe NICHT ab. Ein Test, der
einen Postversand auslöst (Anschreiben, Rechnungs-Kopie, Leistungsnachweis-Brief),
trifft sonst still die ECHTE LetterXpress-API und schlägt mit 401 fehl.

Mock daher IMMER auf der Transport-Schicht `letterxpress-http`, nicht über fetch.
Dafür gibt es den geteilten Helper `tests/helpers/letterxpress.ts`: er stellt eine
`lxHttpRequest`-Mock-Implementierung bereit, die jeden Aufruf aufzeichnet und eine
konfigurierbare setjob-/balance-Antwort zurückgibt.

```ts
import { vi } from "vitest";
// vi.mock MUSS im Testfile stehen (vitest hebt es nur dort an, nicht in
// importierten Modulen). Die dynamische import()-Factory teilt sich die
// Modulinstanz — und damit Recorder + Mock — mit den statischen Helper-Imports.
vi.mock("../../server/services/letterxpress-http", async () => {
  const lx = await import("../helpers/letterxpress");
  return { lxHttpRequest: lx.lxHttpRequest };
});
import { getLxHttpCalls, resetLxHttpMock, setLxSetjobResponse } from "../helpers/letterxpress";

beforeEach(() => resetLxHttpMock());
// ... setLxSetjobResponse("L-123"); → Aufruf auslösen → getLxHttpCalls() prüfen.
```

Referenz-Nutzung: `tests/billing/invoice-pdf-orchestrator-e2e.test.ts` (Brief-Kopie,
Task #1046) und `tests/document-delivery-letterxpress-e2e.test.ts` (Anschreiben-/
Cover-Letter-Postversand über `POST /api/admin/document-delivery/send`).

## Test-Daten-Hygiene & Bulk-Purge

Test cleanup scripts exist but require careful execution (e.g., `--apply` flag, hostname guard). Do not run cleanup scripts directly on production.

**Bulk-Purge der Test-Daten (Task #789, seit Task #894 NICHT mehr im Test-Hot-Path):** Seit der Umstellung auf die isolierte Wegwerf-Test-DB pro Lauf (Task #894) räumt `tests/globalSetup.ts` KEINE stale Test-Datensätze mehr auf — jeder Lauf startet ohnehin auf einer frischen DB. Die Bulk-Purge-Route `POST /api/admin/test-cleanup/purge-prospects` (Superadmin-only, in Production deaktiviert) bleibt als manuelles Aufräum-Werkzeug erhalten (eigene Tests in `tests/test-cleanup-safety.test.ts`), wird aber nicht mehr automatisch pro Lauf getriggert. Sie löst ursprünglich den per-Record-`DELETE`-Loop ab (eine solche Route existierte nie → 404 pro Datensatz → das Cleanup fraß das gesamte Test-Zeitbudget und ließ die Coverage-Gates flaky/langsam laufen). Die Route löscht in EINER gescopten Transaktion: optionales `ids`-Array scoped, leerer Body = kompletter Backlog-Purge; ein SQL-Sicherheitsfilter spiegelt `isTestProspect` aus `globalSetup`, sodass NUR Test-Pattern-Leads je gelöscht werden können. Erstberatungs-Termine, die auf die Prospects zeigen, werden ZUERST hart gelöscht, weil `appointments.prospect_id` zwar `ON DELETE SET NULL` ist, der CHECK-Constraint `appointments_prospect_or_customer_check` aber `prospect_id` ODER `customer_id` verlangt (Erstberatung hat keinen Kunden → SET NULL würde den Constraint verletzen). Direkte `db.select().from(...)` sind in `server/routes` per ESLint verboten — die Route nutzt daher `prospectsRepo`/`appointmentsRepo` (`selectColumnsFrom`, bewusst OHNE `activeOnly()`, damit auch soft-gelöschte Test-Prospects fallen). Analoge gescopte Routen: `purge-customers`, `purge-test-users`.

**Test-Services & Test-Dokumenttypen (Task #1173):** Zusätzlich zu Prospects/Kunden/Usern existieren zwei gescopte Purge-Routen für Stammdaten-Test-Müll, der sich über die Zeit in den Dev-Tabellen ansammelt (sichtbar u.a. in der Services-API und in den Kundenanlage-Schritten):

- `POST /api/admin/test-cleanup/purge-test-services` — entfernt Test-Services. Der SSoT-Filter (`SERVICE_TEST_FILTER` in `server/services/test-data-cleanup.ts`) matcht die Namens-/Code-Muster `tlsicht_%`, `tlwrite_%`, `qs-test-%` sowie `%_test_%`.
- `POST /api/admin/test-cleanup/purge-test-document-types` — entfernt Test-Dokumenttypen. Der Filter (`DOCUMENT_TYPE_TEST_FILTER`) folgt seit BUG-18 (Task #1230) einem WHITELIST-Ansatz: Müll = jeder Dokumenttyp mit `DOC`-Prefix, der NICHT in der zentralen `DOCUMENT_TYPE_WHITELIST` (22 echte Typen, SSoT in `server/services/test-data-cleanup.ts`) steht. Echte Typen beginnen nie mit `DOC`.

Beide Routen sind Superadmin-only, in Production via 403 deaktiviert und dünn — die gesamte DB-Logik liegt im Service-Modul `server/services/test-data-cleanup.ts` (`purgeTestServices`/`purgeTestDocumentTypes`, ESLint verbietet `db.select().from(...)` in `server/routes`). Optionales `ids`-Array scoped (max. 20000), leerer Body = kompletter Backlog. **FK-sicher statt hart-löschen-um-jeden-Preis:** Unreferenzierte Test-Rows werden hart gelöscht, referenzierte (z.B. Service mit Terminen/`customer_service_prices`, Dokumenttyp mit Dokumenten) werden NUR auf `is_active=false` soft-deaktiviert — kein FK-Bruch. Beide Funktionen liefern `{ deleted, deactivated, rejected }` zurück (`rejected` = übergebene IDs, die das Test-Pattern NICHT erfüllen → werden niemals angefasst). Safety-Pins: `tests/test-cleanup-safety.test.ts` CLEAN-1.4 (Services) und CLEAN-1.5 (Dokumenttypen) belegen, dass echte Stammdaten abgelehnt und nur Test-Pattern-Rows gelöscht werden.

Das CLI-Pendant `server/scripts/cleanup-test-data.ts` (Dry-Run-Default, `--apply`, Hostname-Guard, Whitelist-Snapshot echter Stammdaten) deckt beide Tabellen ab: Test-Services + neuer Scope `documenttypes`. Wie bei den übrigen Scopes NIE `customers`/`all`/`users` ausführen, um die Budget-/Monatsabschluss-Beweisdatensätze nicht zu gefährden.

## Object-Storage-Retention für Nicht-Prod-PDFs (Task #1806)

Rechnungs-/Leistungsnachweis-PDFs liegen in EINEM geteilten Object-Storage-Bucket. Produktion schreibt in den nackten Key-Space `invoices/…` (**GoBD-aufbewahrt, UNANTASTBAR**); alle Nicht-Prod-/Test-Läufe isolieren ihre Keys unter `_nonprod/<NODE_ENV>[/run-<RUN_ID>][/w-<WORKER_ID>]/…` (Task #1042/#1051/#1263). Diese Isolation verhindert Kollisionen — aber es gab **keine Retention/TTL**: es wurde nie ein `.delete()` abgesetzt, und die DB-Cleanup-Pfade hart-löschen zwar Zeilen, lassen die zugehörigen PDF-Objekte aber verwaist zurück. Jeder Dev-/Test-/CI-Lauf füllte den Bucket also dauerhaft weiter → die Object-Storage-Kosten wuchsen monoton.

**Retention-Sweep:** `runNonprodPdfSweep`/`sweepNonprodPdfArtifacts` (`scripts/lib/object-storage-pdf-sweep.ts`) enumerieren Objekte unter dem `_nonprod/`-Prefix und löschen NUR die ausreichend ALTEN (Default-Aufbewahrung **24h**, `DEFAULT_PDF_RETENTION_MS`). Die Altersgrenze schützt frisch geschriebene PDFs eines parallel laufenden Schwester-Laufs (analog zum DB-Orphan-Sweep). Alters-unbekannte Objekte werden konservativ übersprungen.

**Sicherheitsschichten (spiegeln den Schreib-Guard `assertInvoicePdfWriteKeyAllowed`):**
- Läuft NIEMALS in Production (harter `NODE_ENV`-Guard im Wrapper UND im CLI).
- Dry-Run per Default; echtes Löschen nur mit `--apply` (CLI) bzw. `dryRun:false` (Wrapper).
- Der Listen-Prefix MUSS `_nonprod/` enthalten, sonst Abbruch (kein Enumerieren des Prod-Key-Space).
- Jeder zu löschende Key wird über `assertNonprodPdfDeleteKeyAllowed` geprüft — Nicht-`_nonprod/`-Keys (z.B. Produktions-`invoices/…`) sind beweisbar unerreichbar.
- Kurzer No-op ohne konfiguriertes Object-Storage (z.B. GitHub-Actions-CI ohne Sidecar).

**Cadence/Verdrahtung:** Der Sweep läuft auf derselben Kadenz wie die bestehenden Test-DB-Sweeps — automatisch beim Start des Ephemeral-Orchestrators (`scripts/with-ephemeral-db.ts`, fail-safe, blockiert den Lauf nie) und im Sammel-Unblock `scripts/sweep-test-dbs.ts` (`npm run test:unblock`, dort `--force` ⇒ Altersgrenze 0). Manuell:

- `npm run test:sweep-pdfs` — Dry-Run (nur anzeigen, was gelöscht würde).
- `tsx scripts/sweep-nonprod-pdfs.ts --apply` — wirklich löschen.
- `tsx scripts/sweep-nonprod-pdfs.ts --retention-ms=0 --apply` — alle `_nonprod/`-PDFs (Altersgrenze aus).

DB-Cleanup und Object-Cleanup bleiben bewusst getrennte, je eigenständig sichere Mechanismen (die Row-Level-`test-data-cleanup` fasst keine Objekte an).
