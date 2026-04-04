import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

export async function backfillAppointmentServices(): Promise<void> {
  try {
    const missing = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM appointments a
      LEFT JOIN appointment_services asvc ON asvc.appointment_id = a.id
      WHERE a.deleted_at IS NULL
        AND a.status IN ('completed', 'documented')
        AND a.service_type IS NOT NULL
        AND a.duration_promised IS NOT NULL
        AND a.duration_promised > 0
        AND asvc.id IS NULL
    `);
    const missingCount = (missing.rows as Array<{ cnt: number }>)[0]?.cnt ?? 0;
    if (missingCount === 0) return;

    const result = await db.execute(sql`
      INSERT INTO appointment_services (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes)
      SELECT a.id, s.id, a.duration_promised, a.duration_promised
      FROM appointments a
      JOIN services s ON s.code = a.service_type
      LEFT JOIN appointment_services asvc ON asvc.appointment_id = a.id
      WHERE a.deleted_at IS NULL
        AND a.status IN ('completed', 'documented')
        AND a.service_type IS NOT NULL
        AND a.duration_promised IS NOT NULL
        AND a.duration_promised > 0
        AND asvc.id IS NULL
    `);

    const count = result.rowCount ?? 0;
    if (count > 0) {
      log(`Backfill: ${count} fehlende appointment_services-Einträge erstellt`, "startup");
    }
  } catch (error) {
    log(`Backfill appointment_services fehlgeschlagen: ${error}`, "startup");
  }
}
