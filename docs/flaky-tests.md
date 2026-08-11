# Flaky Tests Register

Dieses Dokument ist das versionierte Register bekannter **flaky** Tests (Tests,
die ohne Code-Änderung mal grün, mal rot sind). Es ergänzt das automatische
Flake-Tracking aus der CI (Vitest- und Playwright-JUnit-Reports + Playwright-
Retries, siehe Task #774).

## Policy (Microsoft-Regel)

- **Jeder neu erkannte Flake wird hier eingetragen** — mit Test-Datei, Datum,
  Owner und Fix-Deadline.
- **Fix-Deadline = 2 Wochen** ab Erkennungsdatum. Bis dahin ist der Flake
  entweder gefixt **oder** quarantänisiert (z. B. `it.skip` / `test.fixme` mit
  Verweis auf den Eintrag hier), damit er die CI nicht rot färbt.
- Ein quarantänisierter Test ohne Fix nach Deadline wird eskaliert (Owner +
  Tech-Lead), nicht stillschweigend dauerhaft geskippt.

## Wie ein Flake erkannt wird

- **Playwright:** In CI laufen bis zu 2 Retries (`retries: 2`). Ein Test, der
  erst im Retry grün wird, erscheint im Report mit Status **flaky**. Die
  JUnit-XML (`test-results/playwright-junit.xml`) und der HTML-Report werden als
  CI-Artifact hochgeladen.
- **Vitest:** JUnit-Reports (`test-results/vitest-junit.xml`,
  `test-results/architecture-junit.xml`) werden als Artifact hochgeladen.
  Vitest re-runt nicht automatisch — ein als rot gemeldeter Test, der beim
  lokalen Re-Run ohne Änderung grün wird, ist ein Flake-Kandidat und gehört
  hierher.
- Verdacht auf Flake durch Modul-State-Leck? Zuerst prüfen, ob der Test im
  `unit`- oder `integration`-Project läuft (`vitest.config.ts`) und ob er fälsch-
  licherweise auf gemeinsamen Server-/DB-State angewiesen ist.

## Register

| Test-Datei | Erkannt am | Owner | Fix-Deadline | Status | Notiz |
|---|---|---|---|---|---|
| `e2e/smoke/documentation-submit-retry.spec.ts` (`ALREADY_COMPLETED zeigt spezifische Meldung und sperrt Retry`) | 2026-05-28 | SeniorEng | 2026-06-11 | gefixt | Erster Render nach `page.goto('/document-appointment/:id')` riss unter CI-Last (4 Worker + paralleler Integration-Traffic) den 5s-Default-Timeout für `input-actual-start` → grün erst im Playwright-Retry. Fix: Visibility-Wait in `gotoStep2` auf 15s angehoben (konsistent mit den übrigen Waits der Datei). |
| `tests/billing/pdf-hash.test.ts` (`PDFH.1 — pdf_hash != NULL und identisch zu computeDataHash(pdf-bytes)`) | 2026-06-04 | SeniorEng | 2026-06-18 | offen | `invoices.pdf_hash` ist nach `/generate` sporadisch `NULL`, weil der Chromium-Subprozess unter PID-Druck nicht startet (`error while loading shared libraries: libnss3.so: cannot open shared object file`, zygote `FATAL`). Tritt NUR im lokalen Agent-Harness auf, der `test` (2 Worker-Server) + `e2e-smoke` (Browser) + `Start application` gleichzeitig fährt und so das cgroup-`pids.max`-Limit (~1024) reißt. Grün im isolierten Lauf (`EPHEMERAL_DB_WORKERS=1 … vitest run tests/billing/pdf-hash.test.ts`) UND in CI (dort läuft jeder Job isoliert). Die Assertion ist KORREKT (NULL-Hash = echter GoBD-Integritätsbug) und wird NICHT aufgeweicht — der Flake ist reine Ressourcen-Erschöpfung der parallelen Validation-Umgebung. |

> Beim Eintragen das Datum absolut (YYYY-MM-DD) angeben und einen konkreten
> Owner benennen — nicht „Team". Status: `offen` / `quarantäne` / `gefixt`.

## Known-Failing (vorbestehend) — QUARANTÄNE AUFGEHOBEN (SSoT-AP0)

> **Status: Quarantäne ENTFERNT.** Die früher hier gelisteten km-Rebook-/
> km-Drift-Suiten wurden ausschließlich in CI per
> `it.skipIf(quarantinedInCI)` / `describe.skipIf(quarantinedInCI)`
> (`tests/helpers/known-failing.ts`, `quarantinedInCI = !!process.env.CI`)
> übersprungen. In SSoT-AP0 wurde der Skip **ersatzlos zurückgebaut** (Helper
> gelöscht, alle 9 Wrapper entfernt) — die Suiten laufen jetzt **überall
> unquarantänisiert**, auch in der GitHub-Actions-CI.

**Warum die Quarantäne stale war:** Ursprüngliche Root-Cause war die
GoBD-CHECK-Constraint `budget_transactions_appointment_required_check`. Der
Budget-Auto-Rebook (Termin-Edit/Import-Update) schreibt frische
`consumption`/`reversal`-Zeilen und entwertet die alten kurz per
`appointment_id = NULL`; in der frischen CI-DB verletzte das die Constraint →
Route **500 statt 200**. Diese Constraint wird jedoch seit dem
INTERIM-Publish-Fenster **nirgends mehr beim Startup angelegt**: Der Hook
`ensureBudgetTxAppointmentConstraint`
(`server/startup/ensure-budget-tx-appointment-constraint.ts`) ist **nicht mehr
verdrahtet** (Begründung `server/index.ts` ~Z. 616–630; dev droppt die
Constraint sogar). Damit fehlt sie in der CI-DB **und** in den lokalen
Wegwerf-DBs gleichermaßen → der Null-Out ist folgenlos → die Suiten sind grün.
Der Skip schützte also vor einem Zustand, den es nicht mehr gibt.

> ⚠️ **OFFENER Folge-Task (bewusst LAUT, NICHT stumm):** Der Rebook-Null-Out
> (`appointment_id = NULL` auf entwerteten Budget-Zeilen) bleibt **fachlich
> ungeschützt**, solange die GoBD-Constraint dekommissioniert ist. Der
> dedizierte Follow-up muss (a) die Alt-Import-Waisen in Prod backfillen,
> (b) alle Consumption-/Availability-Reader auf `reversed`-Rows prüfen
> (Shadow-Mode-Cent-Diff, Entscheidung vor Umbau an Alrik) und DANN (c) die
> Constraint + den Startup-Hook wieder scharfschalten. Bis dahin ist die
> GoBD-Integrität an dieser Stelle nur durch Konvention, nicht durch die DB
> abgesichert — dieser Marker ersetzt den stummen CI-Skip.

Betroffene Suiten (laufen jetzt unquarantänisiert): `km-rebook-on-edit`,
`re-document-after-edit`, `appointment-edit-rebook`, `appointment-series-bulk-rebook`,
`appointment-series-exception-rebook`, `import-update-budget-drift`,
`reconcile-import-from-excel`, `audit-appointment-budget-km-drift-detects-drift`,
`reconcile-km-drift-leaves-audit-empty`.

### Object-Storage-abhängige Tests (CI ohne Sidecar)

Separat davon werden PDF-/Invoice-Persistenz-Tests in CI übersprungen, weil die
GitHub-Actions-CI **keinen** Object-Storage-Sidecar startet
(`PRIVATE_OBJECT_DIR`/`PUBLIC_OBJECT_SEARCH_PATHS` ungesetzt → Guard
`hasObjectStorageEnv`, `tests/helpers/object-storage.ts`). Das ist kein Bug,
sondern fehlende CI-Infrastruktur (gleiches Muster wie „erechnung ohne Java").

| Test-Datei (Suite/Test) | Erkannt am | Owner | Status | Notiz |
|---|---|---|---|---|
| `tests/billing/billing-flow.test.ts` (`BF-3.5`, `BF-6.1`, `BF-6.2`, `BF-6.3`) | 2026-06-15 | SeniorEng | quarantäne (CI) | Brauchen echten Object-Storage-Read/Write (PDF/LN). `BF-6.4` (404) bleibt aktiv. |
| `tests/billing/zugferd-send-batch-failure.test.ts` (ganze Suite Task #560) | 2026-06-15 | SeniorEng | quarantäne (CI) | ZUGFeRD-Embed schreibt/liest Objekte. |

---

## Anhang: Folge-Entscheidung — dediziertes Flake-Tooling (offen)

Die aktuelle Lösung ist die **schlanke Variante**: GitHub-Actions-Test-Reporting
+ JUnit-Output (Vitest & Playwright) + Playwright-Retries + dieses Register. Sie
macht die Flake-Rate sichtbar, automatisiert aber keine Erkennung/Quarantäne.

Wenn echtes Tooling gewünscht ist (Audit-Prio 8), stehen zwei Optionen zur Wahl.
Die Entscheidung liegt beim Product Owner (Lizenz-/Budget-Frage).

### Option A — Datadog Test Optimization

- **Pro:** Early Flake Detection erkennt ~75 % der Flakes automatisch via
  Re-Runs neuer/geänderter Tests; historische Flake-Trends & Dashboards;
  Test-Impact-Analysis (nur betroffene Tests laufen lassen); integriert sich,
  falls ohnehin Datadog für Observability genutzt wird.
- **Contra:** Kostenpflichtig (pro-Test-Run-Pricing, kann bei großer Suite teuer
  werden); zusätzliche Daten verlassen die eigene Infrastruktur (DSGVO-Prüfung
  nötig, da CareConnect Gesundheits-/Pflegedaten verarbeitet — Test-Metadaten
  dürfen keine PII enthalten); Vendor-Lock-in.

### Option B — Buildkite Test Engine

- **Pro:** Native Vitest-Unterstützung inkl. **Auto-Quarantäne** flakiger Tests
  (rot-machende Flakes werden automatisch isoliert statt die Pipeline zu
  blockieren); Flaky-Test-Detection & -Dashboards; gutes Preis-Leistungs-
  Verhältnis für mittlere Suiten.
- **Contra:** Entfaltet vollen Nutzen v. a. mit Buildkite als CI-Runner —
  bei reinem GitHub-Actions-Setup ist nur der Test-Engine-Teil sinnvoll und der
  Integrationsaufwand höher; ebenfalls kostenpflichtig; DSGVO-Prüfung analog.

### Empfehlung

Vorerst bei der schlanken Variante bleiben und die Flake-Rate über die CI-
Artifacts + dieses Register beobachten. Steigt die Flake-Rate über ~1,5 %
(Google-Schwellwert) und wird das Register-Pflegen zur Last, **Buildkite Test
Engine** evaluieren — die Auto-Quarantäne adressiert den größten Schmerzpunkt
(rote Pipelines durch Flakes) direkt und passt gut zur bestehenden Vitest-Suite.
**Datadog** nur dann, wenn ohnehin eine Datadog-Observability-Einführung ansteht.

## Wandernde Shard-Zuordnung

Seit dem Shard-Umbau (11.08.2026) läuft das Test-Gate als drei Legs
(`tests-shard`, `--shard=i/3`). Jedes Leg hat eine eigene DB; innerhalb eines
Legs laufen die Dateien weiter nacheinander dagegen.

**Die Zuordnung Datei→Leg ist nicht stabil über die Zeit.** Vitest shardet über
einen SHA1-Sort der root-relativen Dateipfade und schneidet bei ⌊n/3⌋. Jede
hinzugefügte oder entfernte Testdatei verschiebt die Slice-Grenzen, und Dateien
wandern zwischen Legs.

Praktische Folge für die Triage: **eine latente Kontaminations-Kopplung kann in
einem völlig unbeteiligten PR rot werden** — etwa in einem, der nur eine
Testdatei ergänzt und dadurch zwei bisher getrennte Dateien in dasselbe Leg
schiebt (oder zwei bisher gemeinsame trennt). Der PR ist dann der Auslöser, nicht
die Ursache.

Vorgehen, wenn ein Leg rot wird und der Diff nichts damit zu tun hat:

1. Im Job-Log nachsehen, **welches Leg** rot war und welche Dateien darin liefen.
2. Die rote Datei isoliert über den Orchestrator fahren. Grün allein + rot im Leg
   ⇒ Kopplung, keine Regression des PRs.
3. Gegen den letzten grünen `main`-Lauf prüfen, mit **welchen** Dateien die rote
   Datei dort ein Leg teilte — die Differenz zeigt den neuen Nachbarn.
4. Die Kopplung selbst beheben (Test-Cleanup-Disziplin), **nicht** das Sharding
   zurückdrehen. Der sequenzielle Einzeljob hat solche Kopplungen nur verdeckt.

Bekannter Kandidat aus `CLAUDE.md`: `tests/customers.test.ts` (KV-0.2) hängt an
Daten anderer Dateien.
