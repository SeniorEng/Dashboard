import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #678 — Migration KM-/Geo-Spalten von `real` (single-precision float)
 * auf präzises `numeric` (Postgres exact decimal).
 *
 * Hintergrund: `real` ist IEEE-754 single-precision und produziert subtile
 * Drifts (z.B. 2.714 → 2.7139999..., je nach Replication-Pfad). Die
 * Domain-Schicht rundet km zwar via `quantizeKm` auf 2 NK, aber bereits
 * gespeicherte Werte können beim Re-Read minimal kippen. Mit `numeric`
 * speichert Postgres den Wert exakt — Round-Trip ist bitidentisch.
 *
 * Konvention (siehe `docs/migration-km-geo-numeric.md`):
 *   - KM-Felder:   numeric(10, 3)   — bis 9.999.999,999 km, 3 NK Auflösung
 *   - Geo-Felder:  numeric(9, 6)    — Lat/Lng auf ≈11 cm genau
 *
 * Idempotent: prüft pro Spalte `information_schema.columns.data_type` und
 * führt das ALTER COLUMN nur aus, wenn der aktuelle Typ noch `real` ist.
 * Bei Re-Deploys ist der Lauf damit ein No-Op.
 *
 * KEIN drizzle-kit push: die Migration läuft hier explizit, damit der
 * USING-Cast über `quantizeKm`-äquivalente Rundung (`round(...::numeric, 3)`
 * bzw. `(...)::numeric(9,6)`) explizit gesteuert wird und keine implizite
 * Drizzle-Diff-Heuristik die Spalte droppt + neu anlegt.
 *
 * Lock-Hinweis: `ALTER COLUMN TYPE` mit USING benötigt einen ACCESS EXCLUSIVE
 * Lock und schreibt die Tabelle einmal komplett um. Für dichte Tabellen
 * (`budget_transactions`, `appointments`, `employee_time_entries`) kann das
 * mehrere Sekunden Lock kosten — siehe Backfill-Plan im Runbook.
 */

type ColumnSpec = {
  table: string;
  column: string;
  type: "km" | "geo";
};

const KM_GEO_COLUMNS: ColumnSpec[] = [
  // KM
  { table: "appointments", column: "travel_kilometers", type: "km" },
  { table: "appointments", column: "customer_kilometers", type: "km" },
  { table: "appointments", column: "no_show_kilometers", type: "km" },
  { table: "employee_time_entries", column: "kilometers", type: "km" },
  { table: "budget_transactions", column: "travel_kilometers", type: "km" },
  { table: "budget_transactions", column: "customer_kilometers", type: "km" },
  { table: "invoice_line_items", column: "quantity_raw", type: "km" },
  // Geo
  { table: "users", column: "latitude", type: "geo" },
  { table: "users", column: "longitude", type: "geo" },
  { table: "customers", column: "latitude", type: "geo" },
  { table: "customers", column: "longitude", type: "geo" },
  { table: "company_settings", column: "latitude", type: "geo" },
  { table: "company_settings", column: "longitude", type: "geo" },
  { table: "appointments", column: "doctor_latitude", type: "geo" },
  { table: "appointments", column: "doctor_longitude", type: "geo" },
];

async function getCurrentColumnType(
  table: string,
  column: string,
): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${table}
      AND column_name = ${column}
    LIMIT 1
  `);
  const row = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
    ?? (Array.isArray(res) ? res[0] as Record<string, unknown> : undefined);
  if (!row) return null;
  return String(row.data_type ?? "");
}

export async function migrateKmGeoToNumeric(): Promise<void> {
  let changed = 0;
  let skipped = 0;
  let missing = 0;

  for (const spec of KM_GEO_COLUMNS) {
    let dataType: string | null;
    try {
      dataType = await getCurrentColumnType(spec.table, spec.column);
    } catch (err) {
      log(
        `KM/Geo-Migration: Typ-Check ${spec.table}.${spec.column} fehlgeschlagen — übersprungen (${(err as Error).message})`,
        "startup",
      );
      continue;
    }

    if (dataType === null) {
      // Tabelle/Spalte noch nicht da (frische Test-DB vor erstem Push) — ok.
      missing++;
      continue;
    }

    if (dataType !== "real" && dataType !== "double precision") {
      // Schon migriert (numeric) oder anderer Typ — nichts zu tun.
      skipped++;
      continue;
    }

    if (spec.type === "km") {
      // ROUND(value::numeric, 3) bildet `quantizeKm` (2 NK) konservativ ab —
      // wir behalten 3 NK Speicher-Auflösung, damit Routing-Roh-km nicht
      // bereits beim Migrieren ihre dritte Stelle verlieren.
      await db.execute(sql.raw(
        `ALTER TABLE "${spec.table}" ALTER COLUMN "${spec.column}" TYPE numeric(10,3) USING ROUND("${spec.column}"::numeric, 3)`,
      ));
    } else {
      await db.execute(sql.raw(
        `ALTER TABLE "${spec.table}" ALTER COLUMN "${spec.column}" TYPE numeric(9,6) USING ROUND("${spec.column}"::numeric, 6)`,
      ));
    }
    changed++;
    log(
      `KM/Geo-Migration: ${spec.table}.${spec.column} (${dataType} → numeric)`,
      "startup",
    );
  }

  log(
    `KM/Geo-Migration abgeschlossen — geändert: ${changed}, übersprungen: ${skipped}, fehlend: ${missing}`,
    "startup",
  );
}
