# Automatischer Monatsabschluss — Runbook

## Überblick
- **Cutoff** = 8. des Folgemonats. Bei Wochenende oder bundeseinheitlichem Feiertag (Neujahr, Karfreitag, Ostermontag, 1. Mai, Christi Himmelfahrt, Pfingstmontag, Tag der Deutschen Einheit, 1. + 2. Weihnachtstag) wird auf den vorherigen Werktag vorgezogen.
- **Auto-Close am 8. ist die EINZIGE Abschluss-Mechanik** (Task #1496). Es gibt KEINEN manuellen Abschluss, KEINEN Sammel-/Batch-Abschluss und KEIN Wiederöffnen (Reopen) mehr.
- **Bedingungslos**: Am Cutoff-Tag um 23:00 Berlin-Zeit wird JEDER Mitarbeiter mit Vormonats-Aktivität geschlossen — UNABHÄNGIG von offenen, undokumentierten oder unsignierten Terminen. Es gibt keinen blockierenden oder eskalierenden Pfad mehr.
- **Kein Status-Schreibvorgang**: Der Abschluss überschreibt KEINEN Termin-Status. „Nicht abgerechnet" (`expired_unsigned`) ist ein rein abgeleitetes Anzeige-Label (zur Laufzeit, wenn der Monat geschlossen ist und der Termin nicht dokumentiert ist). Die Periodensperre hängt allein an `employee_month_closings`.
- **Fehlende Unterschriften blockieren nicht**: Dokumentierte, aber noch nicht unterschriebene Termine werden NACH dem Abschluss aktiv nachgehalten — pro betroffenem Mitarbeiter wird eine `month_close_missing_signature`-Benachrichtigung erzeugt, und die offene Liste erscheint im Admin-Cockpit (siehe unten). LN-Erstellung und -Signatur bleiben nach Abschluss erlaubt (nur das Löschen bleibt Superadmin-gegated).
- **Reminder-Wellen** an Mitarbeiter mit offenen Punkten (offene Termine oder Termine ohne Unterschrift): T-3, T-1, T-0 via WhatsApp, E-Mail und In-App-Banner.

## Dokumentiert vs. dokumentiert & unterschrieben
- **„Dokumentiert?"** = `status = 'completed'` (Arbeit erbracht, UNABHÄNGIG von einer Unterschrift). Entscheidet über „Nicht abgerechnet", Lohn-Export (Lexware) und Statistiken.
- **„Dokumentiert & unterschrieben?"** = `completed` UND Unterschrift (direkt oder via unterschriebenem Leistungsnachweis). Gilt NUR für die Kunden-/Pflegekassen-Abrechnung und die Billing-Pipeline.
- SSoT-Prädikate: reines TS in `shared/domain/appointments.ts` (`isAppointmentDocumented`, `isAppointmentDocumentedAndSigned`, `deriveAppointmentDisplayStatus`), SQL-Spiegel in `server/lib/appointment-signed.ts` — beide MÜSSEN in lockstep bleiben (Arch-Test `tests/architecture/ssot-imports.test.ts`).

## Komponenten
- `shared/utils/month-close-cutoff.ts` — `computeMonthCloseCutoff`, `isCutoffDay`, `daysUntilCutoff`, `previousMonth`
- `server/services/month-close-scheduler.ts` — `autoCloseMonthForCutoff`, `sendMonthCloseReminders`, `getMonthCloseBanner`, `startMonthCloseScheduler`
- `server/storage/time-tracking/month-closing.ts` — `getAdminMonthClosingReadiness` (Aktivitäts-/Offen-/Unsigniert-Zählung), `getMissingSignaturesInClosedMonths` (offene Unterschriften in bereits geschlossenen Monaten)
- `server/routes/month-closing.ts` — ausschließlich READ-ONLY (GET) Endpoints, keine Mutationen:
  - `GET /month-closings/admin/:year/:month` + `/readiness`
  - `GET /month-closing/missing-signatures` (requireAdmin) — fehlende Unterschriften nach Abschluss
  - `GET /month-closing/:year/:month` + `/readiness` + `/preview`
  - `GET /month-close/banner`, `GET /month-close/cutoff/:year/:month`
- `client/src/components/month-close-banner.tsx` — In-App-Banner (im `Layout`); Admin-CTA führt in den Arbeitsplatz „Abrechnung" (`/admin/billing`)
- `client/src/features/billing/components/missing-signatures-card.tsx` — Liste „fehlende Unterschriften nach Abschluss" (jetzt im Arbeitsplatz „Abrechnung", Task #1504; die eigenständige read-only Monatsabschluss-Seite wurde entfernt)
- `client/src/features/admin/components/admin-cockpit.tsx` — Cockpit-Inbox-Eintrag, der auf die offenen Unterschriften (`/admin/billing`) verlinkt

## Manuelle Tests
1. **Cutoff-Berechnung**: `npx vitest run tests/equality/month-close-cutoff.test.ts`
2. **Auto-Close manuell auslösen** (Dev): `await autoCloseMonthForCutoff("2026-04-08")` (in einer Node-REPL gegen DEV-DB). Erwartet: `{ closed, expired, missingSignatures, skipped }`.
3. **Reminder-Welle prüfen**: `await sendMonthCloseReminders("2026-04-05")` → erwartet Wave T-3.
4. **Banner**: `GET /api/time-entries/month-close/banner` als Mitarbeiter mit offenen Terminen.
5. **Fehlende Unterschriften**: `GET /api/time-entries/month-closing/missing-signatures` als Admin → Termine in geschlossenen Monaten ohne Unterschrift.

## Was tun, wenn der Auto-Close fehlschlägt?
- Logs grep: `rg "month-close" logs` — der Scheduler loggt bei Erfolg `Auto-Close für M/Y: X Mitarbeiter bedingungslos geschlossen, Y mit fehlenden Unterschriften (nachgehalten), Z Termine nicht dokumentiert (abgeleitet „Nicht abgerechnet", kein Status-Schreibvorgang)`.
- Falls kein Superadmin/Admin existiert, wird Auto-Close übersprungen (`skipped: true`) und in den Logs vermerkt. Lege mindestens einen aktiven Superadmin/Admin an und triggere den Cron erneut.
- Der Lauf ist idempotent: bereits (nicht wieder geöffnete) geschlossene Mitarbeiter werden übersprungen. Ein erneuter Trigger am selben Cutoff-Tag holt nur noch nicht geschlossene Mitarbeiter nach.

## Status `expired_unsigned` („Nicht abgerechnet")
- Label: „Nicht abgerechnet". Wird NICHT persistiert, sondern zur Laufzeit über `deriveAppointmentDisplayStatus(status, { isMonthClosed })` abgeleitet: geschlossener Monat + Termin nicht dokumentiert (≠ `completed`, ≠ `cancelled`/`customer_no_show`) ⇒ Anzeige `expired_unsigned`.
- Lexware-Export & Statistiken filtern auf „dokumentiert" (`status='completed'`), daher sind nicht dokumentierte Termine automatisch ausgeschlossen — UNABHÄNGIG von der Unterschrift.
