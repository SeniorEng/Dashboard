/**
 * Task #1119 — Migration: `expired_unsigned` → echter Lebenszyklus-Status.
 *
 * Der automatische Monatsabschluss hat Termine früher mit dem Status
 * `expired_unsigned` überschrieben. Dieser Status ist jetzt rein abgeleitet
 * (Anzeige-Label „Nicht abgerechnet") und wird NIE mehr gespeichert. Bestands-
 * termine mit diesem persistierten Status werden idempotent auf ihren wahren
 * Lebenszyklus-Status zurückgeführt:
 *
 *   - dokumentiert & unterschrieben (direkte Unterschrift ODER verknüpfter,
 *     unterschriebener Leistungsnachweis) → `completed`
 *   - ein Ende erfasst (`actual_end` gesetzt)                      → `completed`
 *   - nur ein Beginn erfasst (`actual_start` gesetzt)              → `documenting`
 *   - sonst                                                        → `scheduled`
 *
 * Die Sperrung des Zeitraums hängt ausschließlich an `employee_month_closings`,
 * daher ändert das Zurücksetzen nichts an der effektiven Abrechnungs-/Lohn-
 * Logik. Pro Termin wird ein Audit-Eintrag geschrieben.
 *
 * Idempotent: betrifft ausschließlich Zeilen mit `status = 'expired_unsigned'`.
 */
import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";
import { log } from "../lib/log";

export async function migrateExpiredUnsignedAppointments(exec: DbOrTx = db): Promise<void> {
  const result = await exec.execute(sql`
    WITH updated AS (
      UPDATE appointments a
      SET status = CASE
        WHEN (
          a.signature_data IS NOT NULL OR EXISTS (
            SELECT 1
            FROM service_record_appointments sra
            JOIN monthly_service_records msr ON msr.id = sra.service_record_id
            WHERE sra.appointment_id = a.id
              AND msr.deleted_at IS NULL
              AND msr.status IN ('employee_signed', 'completed')
          )
        ) THEN 'completed'
        WHEN a.actual_end IS NOT NULL THEN 'completed'
        WHEN a.actual_start IS NOT NULL THEN 'documenting'
        ELSE 'scheduled'
      END
      WHERE a.status = 'expired_unsigned'
      RETURNING a.id, a.status AS new_status
    )
    SELECT id, new_status FROM updated
  `);

  const rows = (result.rows ?? []) as Array<{ id: number; new_status: string }>;
  if (rows.length === 0) return;

  // `audit_log.user_id` ist NOT NULL (FK → users.id). Kaskadierende Suche nach
  // einem System-Akteur (Superadmin → Admin → erster aktiver User), analog zum
  // Monatsabschluss-Scheduler.
  const actorRes = await db.execute(sql`
    SELECT id FROM users
    WHERE is_active = true
    ORDER BY is_super_admin DESC, is_admin DESC, id ASC
    LIMIT 1
  `);
  const systemActorId = (actorRes.rows?.[0] as { id: number } | undefined)?.id ?? null;

  if (systemActorId !== null) {
    for (const row of rows) {
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, metadata, user_id, created_at)
        VALUES ('appointment', ${row.id}, 'appointment_status_restored_from_expired',
                ${JSON.stringify({ from: "expired_unsigned", to: row.new_status, task: 1119 })}::jsonb,
                ${systemActorId}, NOW())
      `).catch(() => {
        // Migration darf am Audit-Log nicht scheitern.
      });
    }
  }

  log(
    `Task #1119: ${rows.length} Termin(e) von 'expired_unsigned' auf echten Lebenszyklus-Status zurückgesetzt`,
    "startup",
  );
}
