# Berechtigungs-Matrix — Termine

> **Auto-generiert** aus `shared/policies/appointments.ts` durch
> `tests/policies/appointments-matrix.test.ts`. **Nicht von Hand bearbeiten** —
> der Test scheitert bei Drift. Aktualisierung mit `UPDATE_MATRIX_DOC=1 npx vitest run tests/policies`.

Lese-Schlüssel: `✓` = erlaubt, `–` = verweigert.

Annahmen pro Zelle:
- 'Mitarbeiter (zugewiesen)' ist assignedEmployeeId des Termins.
- 'Mitarbeiter (Kunden-Backup)' ist dem Kunden zugeordnet, aber nicht dem Termin.
- Wochenende/Feiertag/Vergangenheit sind in den Create-Spalten aus.
- `overrideClosedMonth` ignoriert Termin-Felder — nur Rolle zählt.

## Termin-Status: offen

| Rolle | Status | view | create | edit | delete | document | reopen | overrideClosedMonth |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deaktiviert | `scheduled` | – | – | – | – | – | – | – |
| Deaktiviert | `in-progress` | – | – | – | – | – | – | – |
| Deaktiviert | `documenting` | – | – | – | – | – | – | – |
| Deaktiviert | `completed` | – | – | – | – | – | – | – |
| Deaktiviert | `cancelled` | – | – | – | – | – | – | – |
| Deaktiviert | `expired_unsigned` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `scheduled` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `in-progress` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `documenting` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `completed` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `cancelled` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `expired_unsigned` | – | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `scheduled` | ✓ | – | ✓ | ✓ | ✓ | – | – |
| Mitarbeiter (zugewiesen) | `in-progress` | ✓ | – | ✓ | ✓ | ✓ | – | – |
| Mitarbeiter (zugewiesen) | `documenting` | ✓ | – | ✓ | ✓ | ✓ | – | – |
| Mitarbeiter (zugewiesen) | `completed` | ✓ | – | ✓ | – | – | ✓ | – |
| Mitarbeiter (zugewiesen) | `cancelled` | ✓ | – | ✓ | – | – | – | – |
| Mitarbeiter (zugewiesen) | `expired_unsigned` | ✓ | – | ✓ | ✓ | – | – | – |
| Mitarbeiter (Kunden-Backup) | `scheduled` | ✓ | ✓ | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `in-progress` | ✓ | ✓ | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `documenting` | ✓ | ✓ | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `completed` | ✓ | ✓ | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `cancelled` | ✓ | ✓ | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `expired_unsigned` | ✓ | ✓ | – | – | – | – | – |
| Teamleitung | `scheduled` | ✓ | ✓ | ✓ | ✓ | – | – | – |
| Teamleitung | `in-progress` | ✓ | ✓ | ✓ | – | – | – | – |
| Teamleitung | `documenting` | ✓ | ✓ | ✓ | – | – | – | – |
| Teamleitung | `completed` | ✓ | ✓ | ✓ | – | – | – | – |
| Teamleitung | `cancelled` | ✓ | ✓ | ✓ | – | – | – | – |
| Teamleitung | `expired_unsigned` | ✓ | ✓ | ✓ | – | – | – | – |
| Admin | `scheduled` | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| Admin | `in-progress` | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| Admin | `documenting` | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| Admin | `completed` | ✓ | ✓ | ✓ | ✓ | – | ✓ | – |
| Admin | `cancelled` | ✓ | ✓ | ✓ | ✓ | – | – | – |
| Admin | `expired_unsigned` | ✓ | ✓ | ✓ | ✓ | – | – | – |
| Superadmin | `scheduled` | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Superadmin | `in-progress` | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Superadmin | `documenting` | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Superadmin | `completed` | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| Superadmin | `cancelled` | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| Superadmin | `expired_unsigned` | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |

## Termin-Status: Monat geschlossen

| Rolle | Status | view | create | edit | delete | document | reopen | overrideClosedMonth |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deaktiviert | `scheduled` | – | – | – | – | – | – | – |
| Deaktiviert | `in-progress` | – | – | – | – | – | – | – |
| Deaktiviert | `documenting` | – | – | – | – | – | – | – |
| Deaktiviert | `completed` | – | – | – | – | – | – | – |
| Deaktiviert | `cancelled` | – | – | – | – | – | – | – |
| Deaktiviert | `expired_unsigned` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `scheduled` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `in-progress` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `documenting` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `completed` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `cancelled` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `expired_unsigned` | – | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `scheduled` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `in-progress` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `documenting` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `completed` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `cancelled` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `expired_unsigned` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `scheduled` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `in-progress` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `documenting` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `completed` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `cancelled` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `expired_unsigned` | ✓ | – | – | – | – | – | – |
| Teamleitung | `scheduled` | ✓ | – | – | – | – | – | – |
| Teamleitung | `in-progress` | ✓ | – | – | – | – | – | – |
| Teamleitung | `documenting` | ✓ | – | – | – | – | – | – |
| Teamleitung | `completed` | ✓ | – | – | – | – | – | – |
| Teamleitung | `cancelled` | ✓ | – | – | – | – | – | – |
| Teamleitung | `expired_unsigned` | ✓ | – | – | – | – | – | – |
| Admin | `scheduled` | ✓ | – | – | – | – | – | – |
| Admin | `in-progress` | ✓ | – | – | – | – | – | – |
| Admin | `documenting` | ✓ | – | – | – | – | – | – |
| Admin | `completed` | ✓ | – | – | – | – | – | – |
| Admin | `cancelled` | ✓ | – | – | – | – | – | – |
| Admin | `expired_unsigned` | ✓ | – | – | – | – | – | – |
| Superadmin | `scheduled` | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Superadmin | `in-progress` | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Superadmin | `documenting` | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Superadmin | `completed` | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| Superadmin | `cancelled` | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| Superadmin | `expired_unsigned` | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |

## Termin-Status: LN unterschrieben (Lock)

| Rolle | Status | view | create | edit | delete | document | reopen | overrideClosedMonth |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deaktiviert | `scheduled` | – | – | – | – | – | – | – |
| Deaktiviert | `in-progress` | – | – | – | – | – | – | – |
| Deaktiviert | `documenting` | – | – | – | – | – | – | – |
| Deaktiviert | `completed` | – | – | – | – | – | – | – |
| Deaktiviert | `cancelled` | – | – | – | – | – | – | – |
| Deaktiviert | `expired_unsigned` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `scheduled` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `in-progress` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `documenting` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `completed` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `cancelled` | – | – | – | – | – | – | – |
| Mitarbeiter (fremd) | `expired_unsigned` | – | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `scheduled` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `in-progress` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `documenting` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `completed` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `cancelled` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (zugewiesen) | `expired_unsigned` | ✓ | – | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `scheduled` | ✓ | ✓ | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `in-progress` | ✓ | ✓ | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `documenting` | ✓ | ✓ | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `completed` | ✓ | ✓ | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `cancelled` | ✓ | ✓ | – | – | – | – | – |
| Mitarbeiter (Kunden-Backup) | `expired_unsigned` | ✓ | ✓ | – | – | – | – | – |
| Teamleitung | `scheduled` | ✓ | ✓ | – | – | – | – | – |
| Teamleitung | `in-progress` | ✓ | ✓ | – | – | – | – | – |
| Teamleitung | `documenting` | ✓ | ✓ | – | – | – | – | – |
| Teamleitung | `completed` | ✓ | ✓ | – | – | – | – | – |
| Teamleitung | `cancelled` | ✓ | ✓ | – | – | – | – | – |
| Teamleitung | `expired_unsigned` | ✓ | ✓ | – | – | – | – | – |
| Admin | `scheduled` | ✓ | ✓ | – | ✓ | – | – | – |
| Admin | `in-progress` | ✓ | ✓ | – | ✓ | – | – | – |
| Admin | `documenting` | ✓ | ✓ | – | ✓ | – | – | – |
| Admin | `completed` | ✓ | ✓ | – | ✓ | – | – | – |
| Admin | `cancelled` | ✓ | ✓ | – | ✓ | – | – | – |
| Admin | `expired_unsigned` | ✓ | ✓ | – | ✓ | – | – | – |
| Superadmin | `scheduled` | ✓ | ✓ | – | ✓ | – | – | ✓ |
| Superadmin | `in-progress` | ✓ | ✓ | – | ✓ | – | – | ✓ |
| Superadmin | `documenting` | ✓ | ✓ | – | ✓ | – | – | ✓ |
| Superadmin | `completed` | ✓ | ✓ | – | ✓ | – | – | ✓ |
| Superadmin | `cancelled` | ✓ | ✓ | – | ✓ | – | – | ✓ |
| Superadmin | `expired_unsigned` | ✓ | ✓ | – | ✓ | – | – | ✓ |

## Aktions-Definitionen

| Aktion | Bedeutung |
| --- | --- |
| `view` | Termin lesen / im Kalender sehen |
| `create` | Neuen Termin im selben Monat anlegen |
| `edit` | Datum, Zeit, Mitarbeiter, Notizen, Services ändern (PATCH) |
| `delete` | Termin löschen |
| `document` | Start, Ende, Dokumentation, Kundenunterschrift |
| `reopen` | Abgeschlossenen Termin zur Korrektur öffnen |
| `overrideClosedMonth` | In einem geschlossenen Monat handeln dürfen |
