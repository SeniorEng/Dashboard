import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Korrigiert Spaltentypen, die historisch als `text` angelegt wurden, aber im
 * Drizzle-Modell als `date`/`time` deklariert sind. Idempotent: konvertiert pro
 * Ziel-Spalte nur, wenn der aktuelle DB-Typ noch `text` ist.
 *
 * Task #922 — Die Ziel-Spalten + ihr Soll-Typ sind als Registry exportiert, damit
 * der Drift-Wächter (`tests/startup/startup-schema-drift.test.ts`) prüfen kann,
 * dass jede hier konvertierte Spalte im Drizzle-Modell als exakt dieser Typ
 * deklariert ist. WICHTIG: `customers.inaktiv_ab` ist hier bewusst NICHT
 * enthalten — es ist im Drizzle-Modell `text("inaktiv_ab")` (die App speichert
 * YYYY-MM-DD-Strings und castet bei Bedarf explizit `::date`). Es als `date` zu
 * migrieren würde dauerhaft gegen das Drizzle-Modell driften (jeder
 * `drizzle-kit push` würde die Spalte wieder altern wollen).
 */
export const FIX_COLUMN_TYPE_TARGETS: ReadonlyArray<{
  table: string;
  column: string;
  targetType: "date" | "time";
}> = [
  { table: "invoice_line_items", column: "appointment_date", targetType: "date" },
  { table: "invoice_line_items", column: "start_time", targetType: "time" },
  { table: "invoice_line_items", column: "end_time", targetType: "time" },
];

export async function fixColumnTypes(): Promise<void> {
  const changed: string[] = [];

  for (const target of FIX_COLUMN_TYPE_TARGETS) {
    const res = await db.execute(sql`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${target.table}
        AND column_name = ${target.column}
      LIMIT 1
    `);
    const dataType = (res.rows[0] as { data_type?: string } | undefined)?.data_type;
    if (dataType !== "text") continue;

    await db.execute(sql.raw(
      `ALTER TABLE "${target.table}" ALTER COLUMN "${target.column}" SET DATA TYPE ${target.targetType} USING "${target.column}"::${target.targetType}`,
    ));
    changed.push(`${target.table}.${target.column}→${target.targetType}`);
  }

  if (changed.length > 0) {
    log(`Spaltentypen korrigiert: ${changed.join(", ")}`, "startup");
  }
}
