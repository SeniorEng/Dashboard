import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #396 — Drop deprecated `appointments.service_type` column.
 *
 * Die Kategorie eines Termins wird ausschließlich über
 * `appointment_services` + `services.lohnart_kategorie` geführt. Die
 * Spalte wird im Produktivcode nicht mehr gelesen oder geschrieben.
 * Diese idempotente Migration entfernt die Spalte endgültig.
 */
// Task #922 — als SSoT exportiert: der Drift-Wächter
// (`tests/startup/startup-schema-drift.test.ts`) stellt sicher, dass diese
// gedroppte Spalte NICHT (wieder) im Drizzle-Modell auftaucht — sonst legt
// `drizzle-kit push` sie an und diese Migration droppt sie beim nächsten Boot
// wieder (Flapping).
export const DROPPED_APPOINTMENTS_SERVICE_TYPE = {
  table: "appointments",
  column: "service_type",
} as const;

export async function dropAppointmentsServiceTypeColumn(): Promise<void> {
  try {
    const check = await db.execute(sql`
      SELECT 1 AS exists
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'appointments'
        AND column_name = 'service_type'
      LIMIT 1
    `);
    if (check.rows.length === 0) return;

    await db.execute(sql`ALTER TABLE appointments DROP COLUMN IF EXISTS service_type`);
    log("Migration: appointments.service_type entfernt", "startup");
  } catch (error) {
    log(`Drop appointments.service_type fehlgeschlagen: ${error}`, "startup");
  }
}
