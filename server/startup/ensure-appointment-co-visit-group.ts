import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #1613 — Zwei-Kräfte-Einsatz (Co-Visit).
 *
 * Stellt die additive, nullable Spalte `appointments.co_visit_group_id` sowie
 * den Lookup-Index sicher. Idempotent, ohne destruktiven drizzle-kit-Push-Pfad
 * (GoBD: Bestand bleibt unverändert).
 *
 * - `co_visit_group_id` ist nullable — bestehende Einzeltermine behalten NULL
 *   und verhalten sich exakt wie zuvor.
 * - Der Index beschleunigt das Co-Visit-Paar-Lookup in der Overlap-Prüfung.
 *
 * Die Spalte verknüpft zwei gleichzeitige Termine desselben Kunden mit
 * verschiedenen Mitarbeitern zu einem Einsatz und dient EINZIG der
 * Kunden-Overlap-Ausnahme (Sichtbarkeits-Invariante, siehe Schema-Kommentar).
 */
export const APPOINTMENTS_CO_VISIT_GROUP_COLUMN_SQL = `
  ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS co_visit_group_id text
`;

export const APPOINTMENTS_CO_VISIT_GROUP_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS appointments_co_visit_group_id_idx
  ON appointments (co_visit_group_id)
`;

export async function ensureAppointmentCoVisitGroup(): Promise<void> {
  await db.execute(sql.raw(APPOINTMENTS_CO_VISIT_GROUP_COLUMN_SQL));
  await db.execute(sql.raw(APPOINTMENTS_CO_VISIT_GROUP_INDEX_SQL));

  log("Appointment-Co-Visit-Group-Spalte + Index sichergestellt", "startup");
}
