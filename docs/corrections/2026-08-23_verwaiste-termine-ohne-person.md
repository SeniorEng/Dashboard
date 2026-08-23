# Verwaiste Termine ohne Kunde und ohne Interessent

- **Datum des Protokolls:** 23.08.2026
- **Task:** #151
- **Skript (gelöscht nach Anwendung):** `server/scripts/cleanup-orphan-appointments.ts`
- **Anwendung + Verifikation:** von Alrik bestätigt (Gate-1, 23.08.2026)

## Problem

Termine mit `customer_id IS NULL` **und** `prospect_id IS NULL` — also ohne
jede Person. Sie entstanden dadurch, dass beim Löschen eines Interessenten die
Fremdschlüssel-Regel `ON DELETE SET NULL` auf `appointments.prospect_id`
griff, ohne dass ein Kunde verknüpft war. Der Termin blieb als Datensatz
zurück, gehörte aber zu niemandem mehr.

Solche Zeilen sind nicht bloß Ballast: sie tauchen in Listen und Auswertungen
auf, ohne dass sich ein Kunde oder Interessent öffnen ließe, und jede
Aggregation über Personen zählt sie entweder falsch mit oder still nicht.

## Maßnahme

Jeder Fund wurde **soft-gelöscht** (`appointments.deleted_at = now()`), nicht
hart entfernt — die Zeile bleibt für die Nachvollziehbarkeit erhalten.

Ein Audit-Eintrag pro Termin, Action `appointment_deleted`, mit
`previousStatus`, `date` und der Begründung „Task #151: verwaister Termin ohne
Kunden- UND ohne Interessenten-Verknüpfung – Soft-Delete".

Das Skript arbeitete zweistufig: Default war ein reiner Trockenlauf, der die
Funde mit Datum, Uhrzeit, Mitarbeiter, Status und Notiz auflistete; erst
`--apply` schrieb.

## Vorher/Nachher

**Die konkreten Zahlen sind aus dem Repository nicht rekonstruierbar** und
werden hier nicht geschätzt. Das Skript archivierte keinen Report — es zählte
nur auf der Konsole (`Soft-deleted: N/M`). Der Nachweis liegt zeilengenau im
DB-Audit-Log:

```sql
-- Umfang. Spalte heißt `metadata` (jsonb).
SELECT count(*) AS termine, min(created_at), max(created_at)
FROM audit_log
WHERE action = 'appointment_deleted'
  AND metadata->>'reason' LIKE 'Task #151:%';
```

### Akteur im Audit-Log

Der Urheber ist **nicht die handelnde Person**: das Skript wählte den
niedrigsten `is_admin`-User (`ORDER BY id ASC LIMIT 1`). Deterministisch, aber
kein Rückschluss auf den Auslöser.

**Und ein Loch, das mit dem Skript verschwindet:** fand es *keinen*
`is_admin`-User, warnte es nur auf der Konsole — der Soft-Delete lief dann
trotzdem, der Audit-Eintrag wurde per `if (auditUserId == null) continue`
übersprungen. Die Reihenfolge war ausdrücklich erst schreiben, dann
überspringen. Der Zweig war erreichbar, weil `is_admin` und `is_super_admin`
unabhängige Spalten sind (beide `default false`); dieselbe Frage wird im Repo
an drei Stellen verschieden beantwortet (siehe Follow-up unten).

### Endzustand: die Invariante, direkt prüfbar

```sql
-- Muss 0 Zeilen liefern.
SELECT id, date, status
FROM appointments
WHERE customer_id IS NULL
  AND prospect_id IS NULL
  AND deleted_at IS NULL;
```

## Warum das Skript jetzt weg ist

Der **Schreibpfad ist seit Task #149 gesperrt** — die Validierung verhindert,
dass neue Waisen entstehen. Damit ist dieses Skript genau das, was CLAUDE.md
als Einmal-Korrekturwerkzeug beschreibt: es räumte den Altbestand aus der Zeit
*vor* dem Guard auf und kann per Konstruktion nichts mehr finden.

Dazu kommt, dass es **selbst ein Loch trug** (der Audit-Skip oben) und **keinen
einzigen Ziel-Guard** hatte — ein `--apply` in einer Shell mit geerbter
`DATABASE_URL` hätte gegen die getroffene Datenbank soft-gelöscht. Beides
verschwindet mit der Datei. Der Altlast-Eintrag im Prod-Gate-Wächter entfällt
ebenfalls.

## Follow-up (nicht Teil dieser Korrektur)

Das Repo beantwortet „wer darf als Audit-Akteur gelten?" an drei Stellen
verschieden: `is_admin`, `OR(isSuperAdmin, isAdmin)` und
`role IN ('superadmin','admin')`. Das gehört in eine SSoT (`isAdminLike` am
Rollenmodell) — eigener Vorgang, von Alrik für die Long-List notiert.
