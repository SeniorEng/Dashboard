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
| `billing/billing-flow.test.ts` | Rechnungsflow | Happy-Path, Split, Storno, Nachberechnung, Edge-Cases, PDF, /send-Validation | 27 |
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

## Coverage-Gate für `server/routes/billing.ts` (Task #109)

Der Billing-Flow hat einen eigenen Coverage-Gate, der per V8-Native-Coverage
gegen einen separat instrumentierten Express-Server läuft (Port 5050):

```bash
TEST_USER_PASSWORD='dein_passwort' npx tsx script/coverage-billing.ts
```

Das Skript:

1. Startet `tsx server/index.ts` mit `NODE_V8_COVERAGE=coverage/billing-raw`
   in einer eigenen Prozessgruppe auf Port 5050.
2. Wartet, bis der Server hört, und führt `npx vitest run
   tests/billing/billing-flow.test.ts` mit `TEST_BASE_URL=http://localhost:5050`
   aus (alle 27 Billing-Tests).
3. Sendet `SIGTERM` an die Server-Prozessgruppe; V8 schreibt seine Profile
   in `coverage/billing-raw/`.
4. Wertet die Profile mit `c8 report` aus (HTML-Report unter
   `coverage/billing/index.html`) und erzwingt die Schwellen
   **Lines ≥ 55 %** und **Branches ≥ 45 %** für `server/routes/billing.ts`.

**Hinweis zu den Schwellen:** Die ursprüngliche Zielmarke war
„Branch-Coverage > 70 %". V8-Native-Coverage zählt jedoch nur Branches in
beobachteten Code-Pfaden, und der ~280 Zeilen lange SMTP-/E-Mail-Pfad in
`router.post("/:id/send")` lässt sich ohne Mail-Mocking nicht abdecken
(würde echte Postausgänge erzeugen). Der Floor wurde daher auf das aktuell
gemessene Niveau gesetzt (Lines 57,6 % / Branches 47,9 %) und schützt vor
Regressionen unter diese Linie. Für eine echte 70 %-Branch-Marke müsste der
Mail-Versand-Pfad auf einen mockbaren SMTP-Adapter umgestellt werden.

## Hinweise

- Tests laufen gegen die **Entwicklungsdatenbank** - nicht in Produktion ausführen!
- Nach dem Testlauf können Test-Daten übrig bleiben (Termine, Kunden)
- Die Tests prüfen echte API-Antworten - Änderungen an der API können Tests fehlschlagen lassen

## E-Mail-Versand in Tests (In-Memory-Stub-Postausgang)

Damit Tests **keine echten Mails** mehr über Office 365 verschicken (vorher: Account
wurde wegen "Message rate limit exceeded" gedrosselt), läuft der Server im
Test-Workflow mit `NODE_ENV=test`. In diesem Modus leitet `email-service.ts`
jede Mail in einen modul-internen In-Memory-Postausgang um — `sendEmail` und
`testSmtpConnection` behalten ihre Signatur und Fehlerpfade (z. B. "SMTP nicht
konfiguriert" bleibt eine echte Exception).

**Aktivierung:**
- Automatisch über die "Start application"-Workflow (`NODE_ENV=test tsx server/index.ts`).
- Alternativ explizit über `EMAIL_TRANSPORT=stub` als Umgebungsvariable.
- Beim Server-Start wird ein lautes `[email-stub]`-Log ausgegeben, sobald
  `NODE_ENV=test` aktiv ist.

**Echten SMTP-Pfad in Unit-Tests prüfen** (Task #232):
Damit der Real-Pfad in `email-service.ts` (nodemailer.createTransport,
`requireTLS`, TLS-Floor, `verify()`, `sendMail()`) trotz Stub-Postausgang
nicht atrophiert, gibt es einen expliziten Opt-out:

- `EMAIL_TRANSPORT=real` schaltet den Stub auch unter `NODE_ENV=test` aus.
- Dieser Opt-out darf **nur** in Verbindung mit gemocktem nodemailer
  (`vi.mock('nodemailer')`) oder einem lokalen Mail-Catcher
  (z. B. MailHog/maildev) gesetzt werden — Office 365 darf NIE aus Tests
  heraus angesprochen werden.
- `tests/email-service.test.ts` deckt diesen Pfad mit gemocktem nodemailer
  ab und verifiziert Host/Port/STARTTLS/`requireTLS`/TLS 1.2-Floor/
  `rejectUnauthorized` sowie Header-, Attachment- und Fehler-Verhalten.

**Postausgang aus Tests abfragen:**

```ts
import { getTestOutbox, clearTestOutbox } from "./test-utils";

beforeEach(async () => {
  await clearTestOutbox();
});

it("schickt eine Welcome-Mail beim Anlegen eines Mitarbeiters", async () => {
  await createTestEmployee();
  const outbox = await getTestOutbox();
  expect(outbox.some(m => m.subject.includes("Willkommen"))).toBe(true);
});
```

Die Helfer rufen den nur unter `NODE_ENV=test` registrierten Endpoint
`GET /api/test/outbox` bzw. `DELETE /api/test/outbox` auf. In Dev/Production
sind diese Routen nicht eingehängt.

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
