import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #1503 — Konvergenz der Lohnsatz-Quellen.
 *
 * Entfernt die schlafende Tabelle `employee_compensation_history` (datierte
 * Mitarbeiter-Sätze, in Prod stets 0 Zeilen / nie befüllt). Sie war eine der
 * zwei parallelen Lohnsatz-Quellen und wird durch die EINE `wageFor`-SSoT
 * (Rollen-Satz `role_wage_rates` → Katalog-Default `services.employee_rate_cents`)
 * ERSETZT — gemäß Ersetzungs-Regel.
 *
 * Idempotent (`DROP TABLE IF EXISTS`), ohne destruktiven drizzle-kit-Push-Pfad.
 * GoBD: die Tabelle enthielt nie produktive Datensätze, daher kein
 * Historisierungs-/Audit-Verlust.
 */
export const DROP_EMPLOYEE_COMPENSATION_HISTORY_SQL = `
  DROP TABLE IF EXISTS employee_compensation_history
`;

export async function dropEmployeeCompensationHistory(): Promise<void> {
  await db.execute(sql.raw(DROP_EMPLOYEE_COMPENSATION_HISTORY_SQL));
  log("employee_compensation_history entfernt (ersetzt durch wageFor-SSoT)", "startup");
}
