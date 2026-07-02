/**
 * Task #1565 — Konsolidiert die No-Show-Kilometer auf EINE SSoT
 * (`appointments.no_show_kilometers`).
 *
 * Historisch schrieb der No-Show-Dokumentationspfad denselben Wert in ZWEI
 * Felder (`travel_kilometers` UND `no_show_kilometers`). Die Zeitübersicht
 * ("Leerfahrten") las `travel_kilometers`, die Abrechnung `no_show_kilometers`
 * — eine latente Drift-Quelle. Seit Task #1565 ist `no_show_kilometers` die
 * einzige SSoT für No-Show-Km; Anzeige UND Buchung lesen ausschließlich dieses
 * Feld.
 *
 * Dieser Backfill stellt sicher, dass Alt-Datensätze mit Status
 * `customer_no_show`, bei denen `no_show_kilometers` noch NULL ist, den Wert aus
 * `travel_kilometers` übernehmen — damit auch nach dem Umstellen der Lesepfade
 * kein historischer No-Show ohne Km-Wert dasteht.
 *
 * Idempotent: der `WHERE no_show_kilometers IS NULL`-Filter macht jeden erneuten
 * Lauf zum No-Op; zusätzlich ist die Migration über den Migrations-Ledger
 * (`data-migration-runner`) exactly-once gegated.
 */
import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";
import { log } from "../lib/log";

// Single-Source-of-Truth für das rohe SQL, damit der Drift-Wächter es
// introspizieren kann, ohne es zu duplizieren.
export const BACKFILL_NO_SHOW_KILOMETERS_SQL = `
  UPDATE appointments
  SET no_show_kilometers = travel_kilometers
  WHERE status = 'customer_no_show'
    AND no_show_kilometers IS NULL
    AND travel_kilometers IS NOT NULL
`;

export async function backfillNoShowKilometers(exec: DbOrTx = db): Promise<void> {
  await exec.execute(sql.raw(BACKFILL_NO_SHOW_KILOMETERS_SQL));
  log("Task #1565: No-Show-Kilometer auf no_show_kilometers-SSoT gebackfillt", "startup");
}
