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
```

## Testdateien (11 Dateien, ~390 Tests)

| Datei | Bereich |
|-------|---------|
| `customers.test.ts` | Kunden CRUD, Validierung, Pflege, Deaktivierung |
| `appointments.test.ts` | Termine, Status-Workflow, Dokumentation, Junction-Tabelle |
| `time-entries.test.ts` | Zeiterfassung, Konflikte, ArbZG-Pausen, Urlaub |
| `budget.test.ts` | Budget-Pools, Zuweisungen, Kostenschätzung |
| `budget-e2e.test.ts` | Budget End-to-End: Dokumentation → Buchung → Storno |
| `erstberatung.test.ts` | Erstberatung, Prospects, Prospect-Erstberatung |
| `service-records.test.ts` | Leistungsnachweise, Signatur, PDF |
| `appointment-series.test.ts` | Terminserie erstellen, bearbeiten, löschen |
| `services.test.ts` | Dienstleistungen CRUD, Kundenpreise |
| `auth.test.ts` | Login, Session, CSRF |
| `private-billing-e2e.test.ts` | Privatrechnung End-to-End |

## Hinweise

- Tests laufen gegen die **Entwicklungsdatenbank** - nicht in Produktion ausführen!
- Nach dem Testlauf können Test-Daten übrig bleiben (Termine, Kunden)
- Die Tests prüfen echte API-Antworten - Änderungen an der API können Tests fehlschlagen lassen
