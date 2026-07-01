import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

/**
 * Task #1542 — Partiellen Unique-Index aus Task #1528
 * (monthly_service_records_pending_unique_idx) ABRÄUMEN.
 *
 * Mit dem On-Demand-Sammel-Leistungsnachweis gibt es keinen automatisch
 * wachsenden Monatscontainer mehr: der Mitarbeiter legt gezielt ein Bündel
 * (recordType='monthly') aus den gewählten dokumentierten Terminen an und kann
 * pro Kunde+Mitarbeiter+Monat mehrere solcher Bündel erzeugen. Der alte Index
 * erzwang „höchstens EIN offener monthly-LN" und würde das jetzt gewollte
 * Mehrfach-Anlegen mit 23505 blockieren — deshalb wird er entfernt.
 *
 * Idempotent (`DROP INDEX IF EXISTS`). Bewusst KEIN `drizzle-kit push` (analog
 * zu den KM/Geo-/Per-Pot-Migrationen). Bestandssysteme (inkl. Prod) haben den
 * Index bereits; frische DBs haben ihn nie erhalten — beides ist abgedeckt.
 */
export const DROP_MONTHLY_SERVICE_RECORD_PENDING_UNIQUE_INDEX_SQL = `
  DROP INDEX IF EXISTS monthly_service_records_pending_unique_idx
`;

export async function dropMonthlyServiceRecordPendingUnique(): Promise<void> {
  try {
    await db.execute(sql.raw(DROP_MONTHLY_SERVICE_RECORD_PENDING_UNIQUE_INDEX_SQL));
  } catch (err) {
    log(`dropMonthlyServiceRecordPendingUnique: ${err}`, "startup");
  }
}
