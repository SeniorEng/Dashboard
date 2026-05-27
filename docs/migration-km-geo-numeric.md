# KM-/Geo-Spalten: Migration von `real` auf `numeric`

**Task #678** — Quality-Sweep 2026-05-27, High Finding 9.

## Entscheidung

| Bereich | Bisher (`real`, IEEE-754 single) | Neu (Postgres `numeric`) | Begründung |
|---|---|---|---|
| Kilometer (Routing, Termin, Budget, Line-Items) | `real` | **`numeric(10, 3)`** | Bis 9 999 999,999 km; 3 NK Speicher-Auflösung > 2 NK Domain-Rundung (`quantizeKm`), damit GPS-Rohwerte beim Migrieren keine Stelle verlieren. |
| Geo-Koordinaten (Lat/Lng) | `real` | **`numeric(9, 6)`** | ±180 Grad mit 6 NK ≈ 11 cm Auflösung — genug für Routing/Anfahrtsstrecke, deutlich präziser als `real` (≈7 signifikante Stellen). |

**Warum nicht integer-Meter?**
Integer-Meter (KM × 1000 als `integer`) wären kompakter, hätten aber Domain-weite Wrapping-Logik in jedem Producer/Consumer erzwungen (`shared/domain/invoice-line-items.ts`, `server/services/budget-engine.ts`, alle Routes-Handler, alle Frontend-Forms). `numeric(10,3)` mit Drizzles `mode: "number"` behält die Runtime-Repräsentation als JS-`number`, eliminiert aber den Storage-Drift — kein einziger Aufrufer muss angepasst werden.

**Warum nicht `double precision`?**
Doppelte Floats hätten zwar mehr Bits, sind aber immer noch ungenau (Binärbruch ≠ Dezimalbruch). `numeric` ist exakte Dezimalarithmetik — der Wert, der reingeht, ist exakt der Wert, der rauskommt. Genau das, was GoBD-Konsistenz für Rechnungen verlangt.

## Drizzle-Schema

```ts
travelKilometers: numeric("travel_kilometers", { precision: 10, scale: 3, mode: "number" })
latitude:         numeric("latitude",         { precision: 9,  scale: 6, mode: "number" })
```

`mode: "number"` (drizzle-orm ≥ 0.30) erhält den Runtime-Typ `number` — alle bestehenden Aufrufer (Equality-Tests, PDF-Template, ZUGFeRD-Mapper, Routes) bleiben unverändert. Der pg-Treiber serialisiert beim Schreiben automatisch nach String.

## SQL-Migration

Wird über die Startup-Migration `server/startup/migrate-km-geo-to-numeric.ts` aufgerufen (idempotent — prüft pro Spalte `information_schema.columns.data_type` und überspringt, sobald der Typ bereits `numeric` ist). **Kein** `drizzle-kit push` — explizite SQL-Migration mit kontrolliertem `USING`-Cast:

```sql
ALTER TABLE appointments
  ALTER COLUMN travel_kilometers TYPE numeric(10,3)
  USING ROUND(travel_kilometers::numeric, 3);
```

Analog für jede der 15 betroffenen Spalten (siehe `KM_GEO_COLUMNS` im Startup-Modul).

`ROUND(..., 3)` bildet `quantizeKm` konservativ ab — die 4./5. Nachkommastelle (Float-Artefakt aus Migration/Replication) wird beim Cast endgültig entfernt; ab dann sind alle Roundtrips bit-identisch.

## Backfill-Plan

Der `USING`-Cast IST der Backfill — Postgres rechnet jede Zeile im Zuge des `ALTER COLUMN` einmal um. Kein separates Backfill-Skript erforderlich. Was zu beachten ist:

1. **Pre-Audit:** `tsx server/scripts/audit-km-geo-precision.ts` (read-only, Production sicher) zählt pro Spalte Zeilen, Min/Max, Distinct und Drift-Kandidaten (`value != ROUND(value, scale)`). Ausgabe als Markdown-Tabelle für den Deployment-Log archivieren.
2. **Backup:** vor dem ersten Deploy-Run mit dieser Migration die Snapshot-Routine aus `docs/pre-publish-backup-runbook.md` ausführen. `ALTER COLUMN TYPE` schreibt die Tabelle einmal komplett um — bei `budget_transactions` und `appointments` (dichteste Tabellen) im einstelligen Sekundenbereich.
3. **Locks:** `ALTER COLUMN TYPE` benötigt `ACCESS EXCLUSIVE`. Während des Casts ist die Tabelle für Reads und Writes blockiert. Für Produktions-Tabellen unter Last → außerhalb von Bürozeiten deployen oder per `lock_timeout` absichern (wenn Lock nicht in N Sekunden, abbrechen und retry).
4. **Idempotenz:** der Startup-Hook prüft den aktuellen `data_type`. Beim zweiten Boot ist jede Spalte schon `numeric` → No-Op. Re-Deploys sind sicher.
5. **Post-Audit:** nach erstem erfolgreichen Boot dasselbe Audit-Skript erneut laufen lassen. Spalte „Float-Drift" muss überall 0 sein, Spalte „Typ" überall `numeric(…)`. Ergebnis in `docs/deployment-log.md` archivieren.
6. **Rollback:** ein Downgrade auf `real` ist verlustbehaftet (3 NK Präzision werden auf ~7 signifikante Stellen abgeschnitten). Nicht vorgesehen. Bei Problemen → Snapshot-Restore.

## Test-Verifikation

`numeric` mit `mode: "number"` ändert den Runtime-Typ nicht — alle Equality-Tests (`tests/equality/travel-km-roundtrip.test.ts`, `invoice-line-item-arithmetic.test.ts`, `import-update-budget-drift.test.ts`) bleiben unverändert grün, weil sie auf JS-Number-Vergleiche basieren. `npm run check` + `npm test` decken die Typgrenze ab.

## Betroffene Spalten (15)

KM (`numeric(10,3)`):
- `appointments.travel_kilometers`, `appointments.customer_kilometers`, `appointments.no_show_kilometers`
- `employee_time_entries.kilometers`
- `budget_transactions.travel_kilometers`, `budget_transactions.customer_kilometers`
- `invoice_line_items.quantity_raw` (Stunden ODER km — 3 NK reichen für beide)

Geo (`numeric(9,6)`):
- `users.latitude`, `users.longitude`
- `customers.latitude`, `customers.longitude`
- `company_settings.latitude`, `company_settings.longitude`
- `appointments.doctor_latitude`, `appointments.doctor_longitude`

`users.monthly_work_hours` bleibt absichtlich `real` — kein KM/Geo, nicht Teil dieses Sweeps.
