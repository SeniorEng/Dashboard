import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

/**
 * Task #1528 — Partieller Unique-Index gegen Doppel-Monats-LN.
 *
 * Stellt sicher, dass pro Kunde+Mitarbeiter+Monat höchstens EIN offener
 * (pending) Monats-Leistungsnachweis existieren kann. Das schließt das
 * verbleibende Race aus Task #1526: Treffen zwei Create-Requests gleichzeitig
 * ein, wenn noch KEIN pending-LN existiert (Doppel-Klick / zwei Tabs), sehen
 * beide „kein pending" und legen je einen an — ohne DB-Garantie entstünde ein
 * Doppel-LN. Mit diesem Index gewinnt genau ein Insert, der zweite läuft in
 * einen Unique-Verstoß (23505), den die Route abfängt und in den Merge-Pfad
 * umleitet.
 *
 * Versiegelte (employee_signed/completed) und gelöschte (deleted_at) Sätze sind
 * bewusst ausgenommen, damit für spätere Termine korrekt ein NEUER LN angelegt
 * werden kann.
 *
 * Idempotent (`IF NOT EXISTS`). Bewusst KEIN `drizzle-kit push` (analog zu den
 * KM/Geo-/Per-Pot-Migrationen). Scheitert die Index-Erstellung an existierenden
 * Duplikaten, wird der Fehler geloggt und der Boot läuft weiter — der
 * Produktions-Duplikat-Cleanup (Folge-Task) muss zuvor laufen.
 */
// Task #923 — Index-DDL als Konstante exportiert (Index-Drift-Wächter-SSoT).
export const MONTHLY_SERVICE_RECORD_PENDING_UNIQUE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS monthly_service_records_pending_unique_idx
    ON monthly_service_records (customer_id, employee_id, year, month)
    WHERE record_type = 'monthly' AND status = 'pending' AND deleted_at IS NULL
`;

export async function ensureMonthlyServiceRecordPendingUnique(): Promise<void> {
  try {
    await db.execute(sql.raw(MONTHLY_SERVICE_RECORD_PENDING_UNIQUE_INDEX_SQL));
  } catch (err) {
    log(`ensureMonthlyServiceRecordPendingUnique: ${err}`, "startup");
  }
}
