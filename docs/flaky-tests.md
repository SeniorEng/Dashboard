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

> Beim Eintragen das Datum absolut (YYYY-MM-DD) angeben und einen konkreten
> Owner benennen — nicht „Team". Status: `offen` / `quarantäne` / `gefixt`.

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
