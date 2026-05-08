# Automatischer Monatsabschluss — Runbook

## Überblick
- **Cutoff** = 8. des Folgemonats. Bei Wochenende oder bundeseinheitlichem Feiertag (Neujahr, Karfreitag, Ostermontag, 1. Mai, Christi Himmelfahrt, Pfingstmontag, Tag der Deutschen Einheit, 1. + 2. Weihnachtstag) wird auf den vorherigen Werktag vorgezogen.
- **Auto-Close** schließt am Cutoff-Tag um 23:00 Berlin-Zeit alle Mitarbeiter mit Vormonats-Aktivität. Undokumentierte Termine werden auf `expired_unsigned` gesetzt.
- **Reminder-Wellen** an Mitarbeiter mit offenen Punkten (offene Termine oder Termine ohne Unterschrift): T-3, T-1, T-0 via WhatsApp, E-Mail und In-App-Banner.
- **Lock nach Auto-Close**: Nur Superadmins können noch Änderungen am geschlossenen Monat vornehmen oder den Monat mit Begründung wieder öffnen.

## Komponenten
- `shared/utils/month-close-cutoff.ts` — `computeMonthCloseCutoff`, `isCutoffDay`, `daysUntilCutoff`, `previousMonth`
- `server/services/month-close-scheduler.ts` — `autoCloseMonthForCutoff`, `sendMonthCloseReminders`, `getMonthCloseBanner`, `startMonthCloseScheduler`
- `server/routes/month-closing.ts` — Endpoints `/time-entries/month-close/banner`, `/time-entries/month-close/cutoff/:year/:month`, `/time-entries/reopen-month` (requireSuperAdmin)
- `client/src/components/month-close-banner.tsx` — In-App-Banner (im `Layout`)
- `client/src/pages/admin/month-closing.tsx` — Admin-Seite mit Cutoff-Karte + Reopen-Reason-Dialog

## Manuelle Tests
1. **Cutoff-Berechnung**: `npx vitest run tests/month-close-cutoff.test.ts`
2. **Auto-Close manuell auslösen** (Dev): `await autoCloseMonthForCutoff("2026-04-08")` (in einer Node-REPL gegen DEV-DB).
3. **Reminder-Welle prüfen**: `await sendMonthCloseReminders("2026-04-05")` → erwartet Wave T-3.
4. **Banner**: `GET /api/time-entries/month-close/banner` als Mitarbeiter mit offenen Terminen.

## Was tun, wenn der Auto-Close fehlschlägt?
- Logs grep: `rg "month-close" logs` — der Scheduler loggt `Auto-Close für M/Y: X Mitarbeiter geschlossen, Y Termine als verfallen markiert` bei Erfolg.
- Falls kein Superadmin existiert, wird Auto-Close übersprungen und in den Logs vermerkt. Lege mindestens einen aktiven Superadmin an und triggere den Cron erneut.
- Manuell nachholen: über Admin-Seite "Monatsabschluss" pro Mitarbeiter oder via "Alle bereit abschließen".

## Reopen
- Endpoint: `POST /api/time-entries/reopen-month` mit `{ userId, year, month, reason }`.
- Nur `isSuperAdmin = true`. Reason ≥ 10 Zeichen, ≤ 500 Zeichen, Pflichtfeld.
- Audit: `month_reopened` mit Metadaten `{ year, month, targetUserId, reason }`.

## Status `expired_unsigned`
- Label: "Nicht abgerechnet". Wird bei Auto-Close für alle nicht-abgeschlossenen, nicht-stornierten Termine im Cutoff-Monat gesetzt.
- Lexware-Export & Statistiken filtern auf `status='completed'`, daher automatisch ausgeschlossen.
