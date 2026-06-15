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

## Known-Failing (vorbestehend, CI-only quarantänisiert)

Abgrenzung zu „flaky": Die folgenden Tests sind **nicht** mal-grün-mal-rot,
sondern in der GitHub-Actions-CI **deterministisch rot** — wegen eines
vorbestehenden Produktiv-Bugs, der außerhalb dieses Tasks gefixt wird. Sie
werden **nur in CI** via `it.skipIf(quarantinedInCI)` /
`describe.skipIf(quarantinedInCI)` übersprungen
(`tests/helpers/known-failing.ts`, `quarantinedInCI = !!process.env.CI`); lokal
und in den Wegwerf-DBs laufen sie weiter, die Dev-Coverage bleibt also erhalten.

**Root-Cause (eine gemeinsame Ursache):** Der Budget-Auto-Rebook beim
Termin-Edit/Import-Update schreibt frische `consumption`/`reversal`-Zeilen und
entwertet die alten kurz per `appointment_id = NULL`. In Dev/Prod und den
lokalen Wegwerf-DBs ist das folgenlos, weil die GoBD-CHECK-Constraint
`budget_transactions_appointment_required_check`
(`server/startup/ensure-budget-tx-appointment-constraint.ts`) dort wegen noch
nicht aufgelöster Legacy-Waisen **nicht** installiert wird. Die CI fährt eine
frische DB, in der die Constraint angelegt wird → der Null-Out verletzt sie, die
Route liefert **500 statt 200**.

| Test-Datei (Suite/Test) | Erkannt am | Owner | Status | Notiz |
|---|---|---|---|---|
| `tests/budget/km-rebook-on-edit.test.ts` (`Reopen + PATCH … travelKilometers …`) | 2026-06-15 | SeniorEng | quarantäne (CI) | Constraint-Verletzung beim Rebook-Null-Out. |
| `tests/budget/re-document-after-edit.test.ts` (`Re-Document nach Reopen+km-PATCH …`) | 2026-06-15 | SeniorEng | quarantäne (CI) | dito. |
| `tests/equality/appointment-edit-rebook.test.ts` (ganze Suite „Termin-Edit Auto-Rebook") | 2026-06-15 | SeniorEng | quarantäne (CI) | dito. |
| `tests/equality/appointment-series-bulk-rebook.test.ts` (`single-Mode mit Datumsänderung …`) | 2026-06-15 | SeniorEng | quarantäne (CI) | dito. |
| `tests/equality/appointment-series-exception-rebook.test.ts` (`Edit eines Serientermins …`) | 2026-06-15 | SeniorEng | quarantäne (CI) | dito. |
| `tests/equality/import-update-budget-drift.test.ts` (ganze Suite Task #643) | 2026-06-15 | SeniorEng | quarantäne (CI) | Import-Update koppelt Budget-Ledger via Rebook. |
| `tests/reconcile-import-from-excel.test.ts` (`erkennt Drift … idempotent`) | 2026-06-15 | SeniorEng | quarantäne (CI) | Reconcile rebookt aus Original-Excel. |
| `tests/integration/audit-appointment-budget-km-drift-detects-drift.test.ts` (einziger `it`) | 2026-06-15 | SeniorEng | quarantäne (CI) | Drift-Korrektur via `reconcileKmDrift` löst Rebook aus. |
| `tests/integration/reconcile-km-drift-leaves-audit-empty.test.ts` (einziger `it`) | 2026-06-15 | SeniorEng | quarantäne (CI) | dito. |

**Aufhebung:** Sobald der dedizierte Follow-up-Task den Rebook-Null-Out fixt
(Plan: alle Consumption-/Availability-Reader auf `reversed`-Rows prüfen +
Shadow-Mode-Cent-Diff, Entscheidung vor Umbau an Alrik), werden die
`skipIf(quarantinedInCI)`-Wrapper **ersatzlos** entfernt.

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
