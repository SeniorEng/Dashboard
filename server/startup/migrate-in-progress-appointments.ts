/**
 * Task #638 — Migration: `in-progress` → `documenting`.
 *
 * Der Status `in-progress` wurde mit Task #638 abgeschafft. Bestandstermine
 * mit diesem Status werden idempotent auf `documenting` umgestellt und ein
 * Audit-Eintrag pro Termin geschrieben.
 */
import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";
import { log } from "../lib/log";

export async function migrateInProgressAppointments(exec: DbOrTx = db): Promise<void> {
  const result = await exec.execute(sql`
    WITH updated AS (
      UPDATE appointments
      SET status = 'documenting'
      WHERE status = 'in-progress'
      RETURNING id
    )
    SELECT id FROM updated
  `);

  const rows = (result.rows ?? []) as Array<{ id: number }>;
  if (rows.length === 0) return;

  for (const row of rows) {
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, changes, user_id, created_at)
      VALUES ('appointment', ${row.id}, 'status_migrated_in_progress_to_documenting',
              ${JSON.stringify({ from: "in-progress", to: "documenting", task: 638 })}::jsonb,
              NULL, NOW())
    `).catch(() => {
      // Audit-Tabelle hat ggf. abweichendes Schema in alten Deployments —
      // Migration darf am Audit-Log nicht scheitern.
    });
  }

  log(`Task #638: ${rows.length} Termin(e) von 'in-progress' auf 'documenting' migriert`, "startup");
}
