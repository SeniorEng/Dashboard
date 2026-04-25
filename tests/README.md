# API Integrationstests

Diese Tests prüfen die Kern-Funktionalität der CareConnect-APIs.

## Voraussetzungen

1. Der Server muss laufen (`npm run dev`)
2. Ein Test-Benutzer mit Admin-Rechten muss existieren

## Tests ausführen

```bash
# Passwort setzen und Tests ausführen
TEST_USER_PASSWORD='dein_passwort' npx vitest run

# Optional: Anderen Benutzer verwenden
TEST_USER_EMAIL='andere@email.de' TEST_USER_PASSWORD='passwort' npx vitest run

# Tests im Watch-Modus (bei Änderungen automatisch neu ausführen)
TEST_USER_PASSWORD='dein_passwort' npx vitest

# Einzelne Datei
npx vitest run tests/customers.test.ts
```

## Domänen-Abdeckungsmatrix (20 Dateien, ~460 Tests)

| Datei | Domäne | Endpunkte | Tests |
|-------|--------|-----------|-------|
| `auth.test.ts` | Authentifizierung | Login, Session, CSRF | ~10 |
| `customers.test.ts` | Kundenverwaltung | CRUD, Validierung, Pflege, Deaktivierung | ~50 |
| `appointments.test.ts` | Terminverwaltung | Status-Workflow, Dokumentation, Junction | ~45 |
| `appointment-series.test.ts` | Terminserien | Erstellen, Bearbeiten, Löschen | ~20 |
| `time-entries.test.ts` | Zeiterfassung | Konflikte, ArbZG-Pausen, Urlaub | ~40 |
| `budget.test.ts` | Budget | Pools, Zuweisungen, Kostenschätzung | ~30 |
| `budget-e2e.test.ts` | Budget E2E | Dokumentation → Buchung → Storno | ~15 |
| `erstberatung.test.ts` | Erstberatung | Prospects, Erstberatungs-Workflow | ~20 |
| `service-records.test.ts` | Leistungsnachweise | Signatur, PDF-Generierung | ~20 |
| `services.test.ts` | Dienstleistungen | CRUD, Kundenpreise | ~15 |
| `private-billing-e2e.test.ts` | Privatrechnung | End-to-End Abrechnung | ~25 |
| `month-closing.test.ts` | Monatsabschluss | Readiness, Close, Reopen, Batch, Preview | 12 |
| `notifications.test.ts` | Benachrichtigungen | Liste, Ungelesen-Zähler, Gelesen-Markierung | 5 |
| `profile.test.ts` | Mitarbeiterprofil | Laden, Bearbeiten, Dokumente, Nachweise | 10 |
| `tasks-app.test.ts` | Aufgabenverwaltung | CRUD, Zähler, Badge, Erinnerung | 15 |
| `company-settings.test.ts` | Firmeneinstellungen | Laden, Bearbeiten, Systemeinstellungen | 4 |
| `search.test.ts` | Globale Suche | Kunden/Termine suchen, Validierung | 5 |
| `documents.test.ts` | Dokumentenverwaltung | Typen, Upload, Historie, Nachweise | 9 |
| `public-signing.test.ts` | Digitale Unterschrift | Token-Validierung, Signatur (öffentlich) | 4 |
| `statistics.test.ts` | Statistik/Cockpit | Overview, Trends, Budget, Margen | 6 |

## Regressions-Guard

Die Tests dienen als automatische Regressions-Prüfung. Bei jeder Änderung an der API:

```bash
npx vitest run
```

Alle Tests sollten grün sein bevor Code gemerged wird.

## Hinweise

- Tests laufen gegen die **Entwicklungsdatenbank** - nicht in Produktion ausführen!
- Nach dem Testlauf können Test-Daten übrig bleiben (Termine, Kunden)
- Die Tests prüfen echte API-Antworten - Änderungen an der API können Tests fehlschlagen lassen

## Test-Datenisolation

Damit Test-Suites unabhängig voneinander und reihenfolge-stabil laufen, gilt
folgendes Pattern:

- **Niemals** `apiGet("/api/admin/customers?limit=1")` o.ä. nutzen, um den
  ersten existierenden Kunden zu greifen — das teilt State zwischen Tests
  und macht sie flaky.
- Stattdessen pro Suite (`beforeAll`) oder pro Test einen **frischen Kunden**
  via `createTestCustomer()` aus `./test-utils` anlegen und über
  `assignEmployeeToCustomer()` dem Test-Mitarbeiter zuweisen.
- Bei Bedarf (z.B. mehrere Kunden für Cross-Tests) per Test einen weiteren
  Kunden mit `createTestCustomer({ nachname: "..." + uniqueId() })` erzeugen.

Beispiele für korrektes Pattern: `appointments.test.ts`, `time-entries.test.ts`,
`appointment-series.test.ts`, `budget-e2e.test.ts`, `private-billing-e2e.test.ts`,
`customer-hard-delete.test.ts`.

## Test-Daten-Konventionen (verbindlich)

Damit die Datenbank nicht erneut zumüllt, gilt **für jede neue Test-Datei**:

### Naming-Pattern (werden vom Cleanup erkannt)

- **Customers / Prospects**: `nachname` startet mit `Auto_`, `Privat-`,
  `Fahrtdienst-`, `Integ-`; oder `vorname` startet mit `Sz-`, `Pv-`, `Fd-`,
  `Eb-`, `Pg1-`, `Qs-`, `Status-`; oder Vor-/Nachname enthält `Test`.
- **Users (Mitarbeiter)**: E-Mail endet auf `@test.local` oder beginnt mit
  `testemp-`; Nachname beginnt mit `TestEmp_`. `createTestEmployee()` aus
  `test-utils.ts` macht das automatisch korrekt.
- **Services**: Name enthält `_test_`. `createTestService()` aus
  `test-utils.ts` setzt das Pattern automatisch.

### Pflicht zur Cleanup-Registrierung

Jede neu angelegte Test-Entität **muss** über `trackCleanup()` registriert
sein — entweder direkt oder über die Helper, die das schon eingebaut haben:

| Helper                    | Datei            | Cleanup automatisch |
|--------------------------|------------------|---------------------|
| `createTestCustomer()`   | `test-utils.ts`  | ja, via `purge-customers` |
| `createTestEmployee()`   | `test-utils.ts`  | manuell mit `deactivateTestEmployee()` |
| `createTestService()`    | `test-utils.ts`  | ja, via `purge-test-services` |
| `createAndDocumentAppointment()` | `test-utils.ts` | über Customer-Cascade |

In jeder Test-Datei in einem `afterAll`/`afterEach`-Hook `runCleanup()`
aufrufen.

### Manuelles Cleanup (Trockenlauf, dann anwenden)

```bash
# Trockenlauf: zeigt nur an, was gelöscht würde
npx tsx server/scripts/cleanup-test-data.ts --dry-run --scope=all

# Wirklich anwenden (löscht in einer Transaktion, mit Whitelist-Guard)
npx tsx server/scripts/cleanup-test-data.ts --apply --scope=all

# Nur eine Kategorie (customers | prospects | services | users | orphans | all)
npx tsx server/scripts/cleanup-test-data.ts --apply --scope=services
```

Das Skript verweigert die Ausführung, wenn `NODE_ENV=production` gesetzt ist
oder die Whitelist-Counts (echte Kunden, echte Mitarbeiter, echte Services)
durch eine Lösch-Operation kleiner werden würden.
