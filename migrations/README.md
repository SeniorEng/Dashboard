# Migrations

Die SQL-Dateien in diesem Ordner werden von `drizzle-kit` aus dem Drizzle-Schema in `shared/schema/` generiert. **Sie werden nicht automatisch zur Laufzeit ausgeführt** — der Server enthält keinen Migrate-Runner. Schema-Änderungen werden im Alltag mit `npm run db:push` direkt aus dem Drizzle-Schema synchronisiert.

Für Änderungen, die `db:push` als destruktiv einstuft (z. B. das Entfernen von Spalten mit Daten), sind die Migrations-Dateien hier die Anlaufstelle. Sie werden manuell ausgeführt — entweder per `psql`, über das Replit-Database-Tool oder die Drizzle-Konsole.

## Reihenfolge

`migrations/meta/_journal.json` ist die maßgebliche Liste. Neuere Migrationen am Ende anhängen, niemals Lücken in den Index-Nummern lassen.

## Manuelle Ausführung in Production

Beispiel (psql) — vollständige Reihenfolge des Mai-2026-Cleanups:

```bash
psql "$DATABASE_URL" -f migrations/0015_add_vacation_entitlement_history.sql
psql "$DATABASE_URL" -f migrations/0016_fix_vacation_allowance_total_days_numeric.sql
psql "$DATABASE_URL" -f migrations/0014_remove_lbnr_personalnummer.sql
```

Wichtig: Vor destruktiven Migrationen (DROP COLUMN / DROP TABLE) immer ein Backup ziehen — entweder über `pg_dump` oder via `SELECT … INTO outfile` der relevanten Spalten. Die Backups dieser Bereinigung liegen unter `attached_assets/schema-drift-backup-2026-05/`.

## Cleanup Mai 2026

- `0014_remove_lbnr_personalnummer.sql` entfernt die nicht mehr referenzierten Spalten `users.lbnr`, `users.personalnummer` und `invoice_line_items.employee_lbnr`. In allen drei Spalten waren zum Zeitpunkt der Migration ausschließlich `NULL`-Werte; ein CSV-Snapshot liegt unter `attached_assets/schema-drift-backup-2026-05/`.
- `0015_add_vacation_entitlement_history.sql` legt die mit Task #279 eingeführte Tabelle nach. Idempotent — kann gefahrlos mehrfach ausgeführt werden.
- `0016_fix_vacation_allowance_total_days_numeric.sql` korrigiert die Drift, dass `employee_vacation_allowance.total_days` im Drizzle-Schema `numeric(5,2)`, in der DB aber noch `integer` war. Anteilige Jahresansprüche (z. B. 12,67) liefen vorher in `22P02 invalid input syntax for type integer`. Verlustfreier Cast.

Reihenfolge in Production: erst `0015` (Tabelle anlegen) und `0016` (Type-Cast), dann `0014` (Spalten droppen). Die drei Migrationen sind unabhängig voneinander, müssen aber alle laufen.
