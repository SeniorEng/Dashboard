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

Manuelle Werkzeuge: `npm run test:sweep-dbs` (verwaiste DBs aufräumen),
`npm run test:verify-cache` (Warm-/Kalt-Pfad messen).

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
