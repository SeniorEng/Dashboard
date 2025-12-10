# API Integrationstests

Diese Tests prüfen die Kern-Funktionalität der Termin- und Zeiterfassungs-APIs.

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

## Getestete Bereiche

### Termine (appointments.test.ts)
- Kundentermin erstellen, bearbeiten, löschen
- Überlappungsprüfung
- Status-Workflow: geplant → gestartet → beendet → dokumentiert
- Dokumentation mit Budget-Buchung
- Erstberatung mit Kundenerstellung

### Zeiterfassung (time-entries.test.ts)
- Zeiteinträge erstellen, bearbeiten, löschen
- Mehrtages-Urlaub/Krankheit
- Zeitkonflikt-Erkennung
- Urlaubsübersicht
- Pausenprüfung nach §4 ArbZG

## Hinweise

- Tests laufen gegen die **Entwicklungsdatenbank** - nicht in Produktion ausführen!
- Nach dem Testlauf können Test-Daten übrig bleiben (Termine, Kunden)
- Die Tests prüfen echte API-Antworten - Änderungen an der API können Tests fehlschlagen lassen
