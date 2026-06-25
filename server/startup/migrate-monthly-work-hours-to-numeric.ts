import { db, type DbOrTx } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #833 — Migration `users.monthly_work_hours` von `real`
 * (single-precision float) auf präzises `numeric(6,2)` (Postgres exact decimal).
 *
 * Hintergrund: `real` ist IEEE-754 single-precision und produziert subtile
 * Drifts (z.B. 86.45 → 86.4499969...). Der Wert fließt in die Pro-Rata-
 * Urlaubsberechnung und Stunden-/Auslastungs-Statistiken; kleine Drifts
 * summieren sich dort zu falschen Tages-/Stundenwerten. Mit `numeric` speichert
 * Postgres den Wert exakt — Round-Trip ist bitidentisch. Analog zu Task #678
 * (KM-/Geo-Spalten, `migrate-km-geo-to-numeric.ts`).
 *
 * Konvention: numeric(6, 2) — bis 9.999,99 Stunden, 2 NK (Max-Bound ist 300).
 *
 * Idempotent: prüft `information_schema.columns.data_type` und führt das
 * ALTER COLUMN nur aus, wenn der aktuelle Typ noch `real`/`double precision`
 * ist. Bei Re-Deploys ist der Lauf ein No-Op.
 *
 * KEIN drizzle-kit push: die Migration läuft hier explizit mit gesteuertem
 * USING-Cast (`round(...::numeric, 2)`), damit keine implizite Drizzle-Diff-
 * Heuristik die Spalte droppt + neu anlegt (Datenverlust).
 */

// Task #922 — Ziel-Typ als exportierte SSoT für den Drift-Wächter
// (`tests/startup/startup-schema-drift.test.ts`): die Spalte MUSS im Drizzle-
// Modell als exakt `numeric(6,2)` deklariert sein. Das ALTER unten baut seinen
// Typ aus genau diesen Konstanten.
export const MONTHLY_WORK_HOURS_TARGET = {
  table: "users",
  column: "monthly_work_hours",
  precision: 6,
  scale: 2,
} as const;

async function getColumnType(
  table: string,
  column: string,
  exec: DbOrTx = db,
): Promise<string | null> {
  const res = await exec.execute(sql`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${table}
      AND column_name = ${column}
    LIMIT 1
  `);
  const row = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
    ?? (Array.isArray(res) ? (res[0] as Record<string, unknown>) : undefined);
  if (!row) return null;
  return String(row.data_type ?? "");
}

export async function migrateMonthlyWorkHoursToNumeric(exec: DbOrTx = db): Promise<void> {
  let dataType: string | null;
  try {
    dataType = await getColumnType("users", "monthly_work_hours", exec);
  } catch (err) {
    log(
      `monthly_work_hours-Migration: Typ-Check fehlgeschlagen — übersprungen (${(err as Error).message})`,
      "startup",
    );
    return;
  }

  if (dataType === null) {
    // Spalte noch nicht da (frische Test-DB vor erstem Push) — ok.
    return;
  }

  if (dataType !== "real" && dataType !== "double precision") {
    // Schon migriert (numeric) oder anderer Typ — nichts zu tun.
    return;
  }

  await exec.execute(sql.raw(
    `ALTER TABLE "${MONTHLY_WORK_HOURS_TARGET.table}" ALTER COLUMN "${MONTHLY_WORK_HOURS_TARGET.column}" TYPE numeric(${MONTHLY_WORK_HOURS_TARGET.precision},${MONTHLY_WORK_HOURS_TARGET.scale}) USING ROUND("${MONTHLY_WORK_HOURS_TARGET.column}"::numeric, ${MONTHLY_WORK_HOURS_TARGET.scale})`,
  ));
  log(
    `monthly_work_hours-Migration: users.monthly_work_hours (${dataType} → numeric(6,2))`,
    "startup",
  );
}
